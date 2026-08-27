import { createReadStream } from "fs";
import mime from "mime-types";
import path from "path";
import { serverLogFilePath, PORT, version, SPOOLMAN_URL, SPOOLMAN_FQDN, MODE, MAX_RETRIES, LEGACY_MODE } from "./config.js";
import { state } from "./state.js";
import { tailFileLines } from "./logger.js";
import { createSpool, createFilamentAndSpool, mergeSpool, getSpoolmanSpools } from "./spoolman.js";
import { fetchSliceInfo, calcFullConsumption, calcPartialConsumption, consumptionKey } from "./gcode.js";
import { setupMqtt, broadcastSlotUpdate } from "./mqtt.js";
import { getMappings, setMapping, clearMapping } from "./mappings.js";

function sanitizeSpoolForClient({ logFilePath, printerName, ...rest }) {
    return rest;
}

function resolveSpoolData({ printerId, amsId }, printers, res) {
    const printer = printers.find(p => p.id === printerId);
    if (!printer) { res.status(404).json({ ok: false, error: "Printer not found" }); return null; }
    const spoolData = (printer.spoolData || []).find(s => s.amsId === amsId);
    if (!spoolData) { res.status(404).json({ ok: false, error: "Spool not found" }); return null; }
    return spoolData;
}

export function registerRoutes(app, printers) {
    app.get("/api/status/:printerId", (req, res) => {
        const printer = printers.find(p => p.id === req.params.printerId);
        if (!printer) return res.status(404).json({ error: "Printer not found" });

        res.json({
            spoolmanStatus: state.spoolmanStatus,
            mqttStatus: printer.mqttStatus,
            lastMqttUpdate: printer.lastMqttUpdate,
            lastMqttAmsUpdate: printer.lastMqttAmsUpdate,
            PRINTER_ID: printer.id,
            printerName: printer.name,
            MODE,
            LEGACY_MODE,
            SPOOLMAN_URL,
            VERSION: version,
            SPOOLMAN_FQDN,
            monitoringEnabled: printer.monitoringEnabled,
        });
    });

    app.get("/api/spools/:printerId", (req, res) => {
        const printer = printers.find(p => p.id === req.params.printerId);
        if (!printer) return res.status(404).json({ error: "Printer not found" });
        res.json((printer.spoolData || []).map(sanitizeSpoolForClient));
    });

    app.get("/api/printers", (req, res) => {
        res.json(printers.map(({ id, name }) => ({ id, name })));
    });

    app.post("/api/mergeSpool", async (req, res) => {
        const spoolData = resolveSpoolData(req.body, printers, res);
        if (!spoolData) return;
        try {
            await mergeSpool(spoolData);
            res.status(200).json({ ok: true });
        } catch (err) {
            console.error("Server", serverLogFilePath, "mergeSpool failed:", err?.message);
            res.status(500).json({ ok: false, error: err?.message || "mergeSpool failed" });
        }
    });

    app.post("/api/createSpool", async (req, res) => {
        const spoolData = resolveSpoolData(req.body, printers, res);
        if (!spoolData) return;
        try {
            await createSpool(spoolData);
            res.status(200).json({ ok: true });
        } catch (err) {
            console.error("Server", serverLogFilePath, "createSpool failed:", err?.message);
            res.status(500).json({ ok: false, error: err?.message || "createSpool failed" });
        }
    });

    app.post("/api/createSpoolWithFilament", async (req, res) => {
        const spoolData = resolveSpoolData(req.body, printers, res);
        if (!spoolData) return;
        try {
            await createFilamentAndSpool(spoolData);
            res.status(200).json({ ok: true });
        } catch (err) {
            console.error("Server", serverLogFilePath, "createSpoolWithFilament failed:", err?.message);
            res.status(500).json({ ok: false, error: err?.message || "createSpoolWithFilament failed" });
        }
    });

    app.get("/api/events", (req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        state.clients.push(res);
        req.on("close", () => {
            state.clients = state.clients.filter(client => client !== res);
        });
    });

    app.get("/api/logs/:printerId", async (req, res) => {
        try {
            const limitRaw = req.query.limit;
            const limit = Math.max(1, Math.min(2000, parseInt(limitRaw ?? "250", 10) || 250));

            if (req.params.printerId === "server") {
                const lines = await tailFileLines(serverLogFilePath, limit);
                return res.json({ logs: lines });
            }

            const printer = printers.find(p => p.id === req.params.printerId);
            if (!printer) return res.status(404).json({ error: "Printer not found" });

            const lines = await tailFileLines(printer.logFilePath, limit);
            return res.json({ logs: lines });
        } catch (err) {
            console.error("Server", serverLogFilePath, `Failed to read log file: ${err.message}`);
            return res.status(500).json({ error: "Failed to read log file" });
        }
    });

    app.get("/api/logs/:printerId/download", async (req, res) => {
        try {
            const { printerId } = req.params;
            let filePath, downloadName;

            if (printerId === "server") {
                filePath = serverLogFilePath;
                downloadName = "server.log";
            } else {
                const printer = printers.find(p => p.id === printerId);
                if (!printer) return res.status(404).json({ error: "Printer not found" });
                filePath = printer.logFilePath;
                downloadName = `${printer.name.replace(/\s+/g, "_")}_${printer.id}.log`;
            }

            res.setHeader("Content-Type", mime.lookup("log") || "text/plain; charset=utf-8");
            res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
            const stream = createReadStream(filePath);
            stream.on("error", err => {
                console.error("Server", serverLogFilePath, `Failed to stream log: ${err.message}`);
                if (!res.headersSent) res.status(500).end("Failed to read log file");
            });
            stream.pipe(res);
        } catch (err) {
            console.error("Server", serverLogFilePath, `Download error: ${err.message}`);
            res.status(500).json({ error: "Download failed" });
        }
    });

    app.post("/api/printer/:printerId/monitoring/stop", (req, res) => {
        const printer = printers.find(p => p.id === req.params.printerId);
        if (!printer) return res.status(404).json({ error: "Printer not found" });

        if (printer.monitoringEnabled) {
            printer.monitoringEnabled = false;

            // Actively close the existing MQTT connection instead of waiting for it to drop
            if (printer.mqttClient) {
                printer.mqttClient.end();
                printer.mqttClient = null;
            }
            printer.mqttRunning = false;
            printer.mqttStatus = "Disabled";

            state.clients.forEach(client => {
                client.write(`data: ${JSON.stringify({ type: "monitoring_update", printer: printer.id, enabled: false })}\n\n`);
            });
            res.json({ ok: true, printer: printer.id, monitoringEnabled: false });
            console.log(printer.name, printer.logFilePath, `Monitoring disabled for ${printer.name} - ${printer.id}`);
        } else {
            res.json({ ok: false, message: `Monitoring already disabled for ${printer.name} - ${printer.id}` });
        }
    });

    app.post("/api/printer/:printerId/monitoring/start", (req, res) => {
        const printer = printers.find(p => p.id === req.params.printerId);
        if (!printer) return res.status(404).json({ error: "Printer not found" });

        if (printer.monitoringEnabled) {
            res.json({ ok: false, message: `Monitoring already enabled for ${printer.name} - ${printer.id}` });
        } else {
            printer.monitoringEnabled = true;
            state.clients.forEach(client => {
                client.write(`data: ${JSON.stringify({ type: "monitoring_update", printer: printer.id, enabled: true })}\n\n`);
            });
            res.json({ ok: true, printer: printer.id, monitoringEnabled: true });

            // Always restart MQTT immediately, regardless of MAX_RETRIES setting
            printer.reconnectAttempts = 0;
            printer.mqttRunning = false;
            printer.mqttStatus = "Reconnecting";
            console.log(printer.name, printer.logFilePath, `Monitoring enabled for ${printer.name} - ${printer.id}, restarting MQTT...`);
            setupMqtt(printer);
        }
    });

    app.get("/api/print/:printerId", async (req, res) => {
        const printer = printers.find(p => p.id === req.params.printerId);
        if (!printer) return res.status(404).json({ error: "Printer not found" });

        // Allow ?job=<name> to test the FTPS fetch for a specific file manually
        const jobName   = req.query.job || printer.currentJobName || null;
        const state     = printer.currentGcodeState || "IDLE";
        const layerNum  = printer.currentLayerNum   || 0;

        // Fetch fresh slice info if a job is known (or explicitly requested),
        // otherwise fall back to the cached version
        let sliceInfo = req.query.job ? null : (printer.currentSliceInfo || null);
        if (jobName && !sliceInfo) {
            try {
                sliceInfo = await fetchSliceInfo(printer, jobName);
            } catch (err) {
                // non-fatal — surface the error in the response
                return res.json({
                    gcodeState: state,
                    jobName,
                    layerNum,
                    error: `FTPS fetch failed: ${err.message}`,
                    sliceInfo: null,
                    loadedSpools: [],
                    consumption: null,
                });
            }
        }

        // Build loaded spool summary with readable names (same data the main
        // menu uses: Spoolman filament name/material/vendor when linked, AMS
        // slot data as fallback).
        const loadedSpools = (printer.spoolData || []).map(s => {
            const fil = s.existingSpool?.filament || null;
            return {
                amsId:          s.amsId,
                vendor:         fil?.vendor?.name
                                ?? s.matchingExternalFilament?.manufacturer
                                ?? null,
                material:       fil?.material
                                ?? s.slot?.tray_type
                                ?? null,
                filamentName:   fil?.name
                                ?? s.matchingExternalFilament?.name
                                ?? s.slot?.tray_sub_brands
                                ?? null,
                color:          s.slot?.tray_color       ?? null,
                tray_info_idx:  s.slot?.tray_info_idx    ?? null,
                key:            consumptionKey(s.slot?.tray_info_idx, s.slot?.tray_color),
                tray_uuid:      s.slot?.tray_uuid        ?? null,
                spoolmanId:     s.existingSpool?.id       ?? null,
                connectedViaTag: s.connectedViaTag        ?? false,
                remainingWeight: s.correctedWeight        ?? null,
                slotState:      s.slotState               ?? null,
            };
        });

        // fullConsumption = total grams the whole print needs per tray_info_idx
        // (used for the "needed" column). consumption = estimate at the current
        // print progress (partial for an in-progress/aborted print).
        let fullConsumption = null;
        let consumption     = null;
        if (sliceInfo) {
            const TERMINAL = new Set(["FINISH", "FAILED", "CANCEL"]);
            fullConsumption = calcFullConsumption(sliceInfo);
            if (state === "FINISH") {
                consumption = fullConsumption;
            } else if (TERMINAL.has(state) || state === "RUNNING" || state === "PAUSE") {
                consumption = calcPartialConsumption(sliceInfo, layerNum);
            }
        }

        res.json({
            gcodeState: state,
            jobName,
            layerNum,
            totalLayers:    sliceInfo?.totalLayers   ?? null,
            sliceInfo:      sliceInfo ? {
                filaments: sliceInfo.filaments,
            } : null,
            loadedSpools,
            fullConsumption,
            consumption,
            consumptionBooked: printer.consumptionBooked ?? false,
        });
    });

    // ---------------------------------------------------------------------
    // Manual AMS slot -> Spoolman spool assignments
    //
    // 3rd-party spools have no RFID chip, so nothing links them to a Spoolman
    // spool automatically. These endpoints let the Web UI make that link, which
    // is what enables consumption booking for them (see bookConsumption in
    // mqtt.js). They also resolve the ambiguous case of two tagged spools that
    // are identical in material profile and color.
    // ---------------------------------------------------------------------

    // Full Spoolman spool list for the assignment picker
    app.get("/api/spoolman/spools", async (req, res) => {
        try {
            res.json(await getSpoolmanSpools());
        } catch (err) {
            console.error("Server", serverLogFilePath, "Could not load Spoolman spools:", err?.message);
            res.status(502).json({ ok: false, error: err?.message || "Could not load Spoolman spools" });
        }
    });

    app.get("/api/mappings/:printerId", (req, res) => {
        const printer = printers.find(p => p.id === req.params.printerId);
        if (!printer) return res.status(404).json({ ok: false, error: "Printer not found" });
        res.json(getMappings(printer.id));
    });

    app.put("/api/mappings/:printerId/:amsId", async (req, res) => {
        const { printerId, amsId } = req.params;
        const printer = printers.find(p => p.id === printerId);
        if (!printer) return res.status(404).json({ ok: false, error: "Printer not found" });

        const spoolId = Number(req.body?.spoolId);
        if (!Number.isInteger(spoolId) || spoolId <= 0) {
            return res.status(400).json({ ok: false, error: "spoolId must be a positive integer" });
        }

        const uiSpool = (printer.spoolData || []).find(s => s.amsId === amsId);
        if (!uiSpool) return res.status(404).json({ ok: false, error: "AMS slot not found" });

        try {
            const spools = await getSpoolmanSpools();
            const spool = spools.find(s => s.id === spoolId);
            if (!spool) return res.status(404).json({ ok: false, error: `Spool ${spoolId} not found in Spoolman` });

            const mapping = setMapping(printerId, amsId, spoolId, uiSpool.slot);
            applyMappingToUiSpool(printer, uiSpool, spool);
            console.log(printer.name, printer.logFilePath, `[Mapping] ${amsId} assigned to Spoolman spool ${spoolId} (${spool.filament?.name ?? "?"})`);

            res.json({ ok: true, mapping });
        } catch (err) {
            console.error("Server", serverLogFilePath, "Could not set spool mapping:", err?.message);
            res.status(500).json({ ok: false, error: err?.message || "Could not set spool mapping" });
        }
    });

    app.delete("/api/mappings/:printerId/:amsId", (req, res) => {
        const { printerId, amsId } = req.params;
        const printer = printers.find(p => p.id === printerId);
        if (!printer) return res.status(404).json({ ok: false, error: "Printer not found" });

        const existed = clearMapping(printerId, amsId);

        const uiSpool = (printer.spoolData || []).find(s => s.amsId === amsId);
        if (uiSpool) applyMappingToUiSpool(printer, uiSpool, null);
        if (existed) console.log(printer.name, printer.logFilePath, `[Mapping] ${amsId} assignment removed`);

        res.json({ ok: true, removed: existed });
    });
}

/**
 * Reflects a mapping change in the cached slot data right away and pushes it to
 * connected clients. Without this the overview would keep showing the old state
 * until the next AMS update happens to rebuild printer.spoolData.
 */
function applyMappingToUiSpool(printer, uiSpool, spool) {
    uiSpool.existingSpool        = spool;
    uiSpool.connectedViaMapping  = !!spool;
    uiSpool.option               = spool ? "Unassign Spool" : "Assign Spool";
    uiSpool.enableButton         = "true";
    // correctedWeight came from the assigned spool, so it has to go with it —
    // 3rd-party slots report tray_weight 0 and have no weight of their own.
    uiSpool.correctedWeight      = spool?.remaining_weight ?? null;

    broadcastSlotUpdate(printer.id, uiSpool);
}
