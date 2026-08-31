import { createReadStream } from "fs";
import mime from "mime-types";
import path from "path";
import { serverLogFilePath, version } from "./config.js";
import { settings, spoolmanUrl, buildSpoolmanUrl, getSettingsView, updateSettings, coerceSetting, legacyMode } from "./settings.js";
import { addPrinter, updatePrinter, removePrinter, syncPrinterIntervals } from "./printers.js";
import { restartSpoolmanConnection } from "./service.js";
import { state } from "./state.js";
import { tailFileLines } from "./logger.js";
import {
    createSpool,
    createFilamentAndSpool,
    mergeSpool,
    getSpoolmanSpools,
    getSpoolmanVendors,
    getSpoolmanLocations,
    getSpoolmanMaterials,
    getSpoolmanExternalMaterials,
    getSpoolmanInternalFilaments,
    createNamedVendor,
    createFilament,
    createSpoolRecord,
    checkSpoolmanHealth,
} from "./spoolman.js";
import { fetchSliceInfo, calcFullConsumption, calcPartialConsumption, consumptionKey, testFtpsConnection } from "./gcode.js";
import { setupMqtt, broadcastSlotUpdate, broadcastSSE, testMqttConnection } from "./mqtt.js";
import { getMappings, setMapping, clearMapping, clearPrinterMappings } from "./mappings.js";

/** Strips server-only fields from a UI spool before it goes out to a client. */
function sanitizeSpoolForClient({ logFilePath, printerName, ...rest }) {
    return rest;
}

/**
 * Looks up the cached UI spool for a printer and slot, answering with a 404 and
 * returning null when either does not exist. Callers must stop on null; the
 * response has already been sent.
 *
 * @param {{printerId: string, amsId: string}} params - route parameters
 * @param {object[]} printers - the printer list
 * @param {object} res - the Express response, used for the 404
 * @returns {object|null} the cached UI spool, or null
 */
function resolveSpoolData({ printerId, amsId }, printers, res) {
    const printer = printers.find(p => p.id === printerId);
    if (!printer) { res.status(404).json({ ok: false, error: "Printer not found" }); return null; }
    const spoolData = (printer.spoolData || []).find(s => s.amsId === amsId);
    if (!spoolData) { res.status(404).json({ ok: false, error: "Spool not found" }); return null; }
    return spoolData;
}

/**
 * Rejects the manual assignment endpoints while legacy mode is on.
 *
 * Assignments exist to tell the G-code booking which physical spool to charge.
 * Legacy mode books nothing, it writes the weight straight onto the spool the
 * RFID tag already identifies, so an assignment there would change nothing. The
 * UI hides these actions, and this stops a direct call from creating a mapping
 * that would silently take effect on the next mode switch.
 *
 * @returns {boolean} true when the request was answered and the caller must stop
 */
function rejectInLegacyMode(res) {
    if (!legacyMode()) return false;
    res.status(409).json({ ok: false, error: "Manual spool assignment is not available in legacy mode" });
    return true;
}

/**
 * Registers every HTTP route on the Express app.
 *
 * The API falls into four groups: read-only status and spool data for the
 * dashboard, the SSE stream at /api/events that pushes live updates, the
 * actions the UI triggers (create, merge, assign a spool, start and stop
 * monitoring), and the log endpoints. Handlers read from the cached
 * printer.spoolData rather than talking to the printer, so a request never
 * blocks on MQTT.
 *
 * @param {object} app - the Express app
 * @param {object[]} printers - the printer list from printers.js
 */
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
            MODE: settings.MODE,
            LEGACY_MODE: legacyMode(),
            SPOOLMAN_URL: spoolmanUrl(),
            VERSION: version,
            SPOOLMAN_FQDN: settings.SPOOLMAN_FQDN,
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
                // non-fatal, surface the error in the response
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
        if (rejectInLegacyMode(res)) return;

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

    // Everything the "new spool" dialog needs to populate its dropdowns, in one
    // round trip. A 3rd party spool tells us only its material and colour, so
    // the rest is picked from what Spoolman already knows.
    app.get("/api/spoolman/lookups", async (req, res) => {
        try {
            const [vendors, materials, externalMaterials, locations, filaments] = await Promise.all([
                getSpoolmanVendors(),
                getSpoolmanMaterials(),
                getSpoolmanExternalMaterials(),
                getSpoolmanLocations(),
                getSpoolmanInternalFilaments(),
            ]);
            res.json({ vendors, materials, externalMaterials, locations, filaments });
        } catch (err) {
            console.error("Server", serverLogFilePath, "Could not load Spoolman lookups:", err?.message);
            res.status(502).json({ ok: false, error: err?.message || "Could not load Spoolman lookups" });
        }
    });

    // Creates a spool for a slot the printer cannot identify by itself and links
    // the slot to it in one step, so the user does not have to assign it
    // separately afterwards. Creates the filament too when none is picked.
    app.post("/api/thirdparty/spool/:printerId/:amsId", async (req, res) => {
        if (rejectInLegacyMode(res)) return;

        const { printerId, amsId } = req.params;
        const printer = printers.find(p => p.id === printerId);
        if (!printer) return res.status(404).json({ ok: false, error: "Printer not found" });

        const uiSpool = (printer.spoolData || []).find(s => s.amsId === amsId);
        if (!uiSpool) return res.status(404).json({ ok: false, error: "AMS slot not found" });

        const { filamentId, filament, spool = {} } = req.body || {};

        try {
            let resolvedFilamentId = Number(filamentId) || null;

            if (!resolvedFilamentId) {
                const error = validateFilamentInput(filament);
                if (error) return res.status(400).json({ ok: false, error });

                let vendorId = Number(filament.vendorId) || null;
                if (!vendorId && filament.vendorName?.trim()) {
                    const vendor = await createNamedVendor(filament.vendorName.trim());
                    vendorId = vendor.id;
                    console.log(printer.name, printer.logFilePath, `[Spool] Created vendor "${vendor.name}" (${vendorId})`);
                }

                const created = await createFilament({
                    name: filament.name?.trim() || null,
                    material: filament.material?.trim() || null,
                    density: Number(filament.density),
                    diameter: Number(filament.diameter),
                    color_hex: normalizeHex(filament.colorHex),
                    weight: numberOrNull(filament.weight),
                    spool_weight: numberOrNull(filament.spoolWeight),
                    settings_extruder_temp: numberOrNull(filament.extruderTemp),
                    settings_bed_temp: numberOrNull(filament.bedTemp),
                    vendor_id: vendorId,
                });
                resolvedFilamentId = created.id;
                console.log(printer.name, printer.logFilePath, `[Spool] Created filament "${created.name ?? "?"}" (${resolvedFilamentId})`);
            }

            const spoolPayload = {
                filament_id: resolvedFilamentId,
                first_used: Date.now(),
                initial_weight: numberOrNull(spool.initialWeight),
                remaining_weight: numberOrNull(spool.remainingWeight),
                location: spool.location?.trim() || null,
                lot_nr: spool.lotNr?.trim() || null,
                comment: spool.comment?.trim() || null,
            };
            const createdSpool = await createSpoolRecord(spoolPayload);

            // The slot has no tag to link it, so the assignment is the link.
            const mapping = setMapping(printerId, amsId, createdSpool.id, uiSpool.slot);
            const spools = await getSpoolmanSpools();
            applyMappingToUiSpool(printer, uiSpool, spools.find(s => s.id === createdSpool.id) ?? createdSpool);

            console.log(printer.name, printer.logFilePath, `[Spool] Created spool ${createdSpool.id} for ${amsId} and assigned it`);
            res.json({ ok: true, spoolId: createdSpool.id, filamentId: resolvedFilamentId, mapping });
        } catch (err) {
            const detail = err.response?.body ? JSON.stringify(err.response.body) : err.message;
            console.error("Server", serverLogFilePath, "Could not create 3rd party spool:", detail);
            res.status(500).json({ ok: false, error: detail || "Could not create spool" });
        }
    });

    app.delete("/api/mappings/:printerId/:amsId", (req, res) => {
        if (rejectInLegacyMode(res)) return;

        const { printerId, amsId } = req.params;
        const printer = printers.find(p => p.id === printerId);
        if (!printer) return res.status(404).json({ ok: false, error: "Printer not found" });

        const existed = clearMapping(printerId, amsId);

        const uiSpool = (printer.spoolData || []).find(s => s.amsId === amsId);
        if (uiSpool) applyMappingToUiSpool(printer, uiSpool, null);
        if (existed) console.log(printer.name, printer.logFilePath, `[Mapping] ${amsId} assignment removed`);

        res.json({ ok: true, removed: existed });
    });

    // ---------------------------------------------------------------------
    // Runtime configuration
    //
    // Everything that used to be an environment variable only. The values are
    // stored in printers/settings.json and applied to the running process right
    // away, except for the fields the schema marks as restart required.
    // ---------------------------------------------------------------------

    app.get("/api/settings", (req, res) => {
        res.json(getSettingsView());
    });

    app.put("/api/settings", (req, res) => {
        const previousUrl = spoolmanUrl();

        let result;
        try {
            result = updateSettings(req.body);
        } catch (err) {
            console.error("Server", serverLogFilePath, "Could not write settings.json:", err?.message);
            return res.status(500).json({ ok: false, error: err?.message || "Could not save the settings" });
        }

        if (!result.ok) return res.status(400).json({ ok: false, error: result.errors.join(" / ") });

        if (result.changed.length) {
            console.log("Server", serverLogFilePath, `[Settings] Changed: ${result.changed.join(", ")}`);
        }
        // The interval is copied onto every printer object, so a change has to
        // be pushed into the running ones.
        if (result.changed.includes("UPDATE_INTERVAL")) syncPrinterIntervals();
        if (spoolmanUrl() !== previousUrl) restartSpoolmanConnection();

        const view = getSettingsView();
        broadcastSSE({ type: "settings_update", values: view.values });

        res.json({ ok: true, ...view, changed: result.changed, restartRequired: result.restartRequired });
    });

    // ---------------------------------------------------------------------
    // Printer management
    //
    // The access code is never sent to a client. An update without a code keeps
    // the stored one, which is how the Web UI edits a printer it cannot display
    // the code of.
    // ---------------------------------------------------------------------

    app.get("/api/printers/config", (req, res) => {
        res.json(printers.map(publicPrinter));
    });

    app.post("/api/printers", (req, res) => {
        const result = addPrinter(req.body);
        if (!result.ok) return res.status(400).json({ ok: false, error: result.error });

        console.log("Server", serverLogFilePath, `[Printer] Added ${result.printer.name} (${result.printer.id})`);
        broadcastSSE({ type: "printers_update" });

        // Connect right away instead of waiting for the next monitor pass.
        setupMqtt(result.printer);

        res.json({ ok: true, printer: publicPrinter(result.printer) });
    });

    app.put("/api/printers/:printerId", (req, res) => {
        const result = updatePrinter(req.params.printerId, req.body);
        if (!result.ok) {
            const status = result.error === "Printer not found" ? 404 : 400;
            return res.status(status).json({ ok: false, error: result.error });
        }

        console.log(result.printer.name, result.printer.logFilePath, `[Printer] Updated ${result.printer.name} (${result.printer.id})`);
        broadcastSSE({ type: "printers_update" });

        if (result.reconnect) {
            disconnectPrinter(result.printer);
            // The cooldown in setupMqtt guards against retry storms, not against
            // a deliberate reconnect, so clear it here.
            result.printer.lastReconnectAttempt = 0;
            result.printer.reconnectAttempts = 0;
            if (result.printer.monitoringEnabled) setupMqtt(result.printer);
        }

        res.json({ ok: true, printer: publicPrinter(result.printer), reconnected: result.reconnect });
    });

    app.delete("/api/printers/:printerId", (req, res) => {
        const printer = printers.find(p => p.id === req.params.printerId);
        if (!printer) return res.status(404).json({ ok: false, error: "Printer not found" });

        printer.monitoringEnabled = false;
        disconnectPrinter(printer);

        const result = removePrinter(printer.id);
        if (!result.ok) return res.status(404).json({ ok: false, error: result.error });

        // The assignments describe slots of a printer that no longer exists.
        clearPrinterMappings(printer.id);

        console.log("Server", serverLogFilePath, `[Printer] Removed ${printer.name} (${printer.id})`);
        broadcastSSE({ type: "printers_update" });

        res.json({ ok: true, removed: printer.id });
    });

    // ---------------------------------------------------------------------
    // Connection tests
    //
    // Both take the values from the form rather than the stored ones, so a
    // setting can be tried before it is saved. Nothing is written here.
    // ---------------------------------------------------------------------

    app.post("/api/test/spoolman", async (req, res) => {
        const candidate = {};
        for (const key of ["SPOOLMAN_ENDPOINT", "SPOOLMAN_IP", "SPOOLMAN_PORT", "SPOOLMAN_SUBFOLDER"]) {
            const result = coerceSetting(key, req.body?.[key]);
            if (result.error) return res.status(400).json({ ok: false, error: result.error });
            candidate[key] = result.value;
        }

        const url = buildSpoolmanUrl(candidate);
        const health = await checkSpoolmanHealth(url);

        res.json({ ...health, url });
    });

    app.post("/api/test/printer", async (req, res) => {
        const id = String(req.body?.id || "").trim().toUpperCase();
        const ip = String(req.body?.ip || "").trim();
        // The Web UI never receives the stored access code, so an empty one in
        // an edit means "test the code that is already stored".
        const known = printers.find(p => p.id === id);
        const code = String(req.body?.code || "").trim() || known?.code || "";

        if (!id) return res.status(400).json({ ok: false, error: "Serial number is required" });
        if (!ip) return res.status(400).json({ ok: false, error: "Address is required" });
        if (!code) return res.status(400).json({ ok: false, error: "Access code is required" });

        // Both checks are independent, and a printer that fails one usually
        // fails the other, so waiting for them one after another only doubles
        // the time until the user sees the result.
        const [mqttResult, ftpsResult] = await Promise.all([
            testMqttConnection({ id, ip, code }),
            testFtpsConnection({ ip, code }),
        ]);

        const target = known ? known.name : id;
        console.log("Server", serverLogFilePath, `[Test] ${target}: MQTT ${mqttResult.ok ? "ok" : `failed (${mqttResult.detail})`}, FTPS ${ftpsResult.ok ? "ok" : `failed (${ftpsResult.detail})`}`);

        res.json({ ok: mqttResult.ok && ftpsResult.ok, mqtt: mqttResult, ftps: ftpsResult });
    });
}

/** The printer fields a client may see. The access code is deliberately not one of them. */
function publicPrinter(printer) {
    return {
        id: printer.id,
        name: printer.name,
        ip: printer.ip,
        hasCode: !!printer.code,
        mqttStatus: printer.mqttStatus,
        monitoringEnabled: printer.monitoringEnabled,
    };
}

/** Closes the MQTT connection of a printer, if it has one. */
function disconnectPrinter(printer) {
    if (printer.mqttClient) {
        printer.mqttClient.end();
        printer.mqttClient = null;
    }
    printer.mqttRunning = false;
    printer.mqttStatus = "Disconnected";
}

/** Parses a value into a finite number, or null when it is empty or invalid. */
function numberOrNull(value) {
    if (value === "" || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Normalises a colour to a bare 6 digit uppercase hex, or null when invalid. */
function normalizeHex(value) {
    const hex = String(value || "").replace(/^#/, "").slice(0, 6).toUpperCase();
    return /^[0-9A-F]{6}$/.test(hex) ? hex : null;
}

/**
 * Validates the filament details typed into the new spool dialog.
 *
 * Density and diameter are the only fields Spoolman requires on a filament, and
 * neither can be read off a chipless spool.
 *
 * @param {object|undefined} filament - the filament details from the request
 * @returns {string|null} an error message, or null when the input is usable
 */
function validateFilamentInput(filament) {
    if (!filament) return "Either filamentId or filament details are required";
    if (!Number.isFinite(Number(filament.density)) || Number(filament.density) <= 0) return "Density must be a positive number";
    if (!Number.isFinite(Number(filament.diameter)) || Number(filament.diameter) <= 0) return "Diameter must be a positive number";
    return null;
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
    // correctedWeight came from the assigned spool, so it has to go with it.
    // 3rd-party slots report tray_weight 0 and have no weight of their own.
    uiSpool.correctedWeight      = spool?.remaining_weight ?? null;

    broadcastSlotUpdate(printer.id, uiSpool);
}
