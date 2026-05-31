import { createReadStream } from "fs";
import mime from "mime-types";
import path from "path";
import { serverLogFilePath, PORT, version, SPOOLMAN_URL, SPOOLMAN_FQDN, MODE, MAX_RETRIES } from "./config.js";
import { state } from "./state.js";
import { tailFileLines } from "./logger.js";
import { createSpool, createFilamentAndSpool, mergeSpool } from "./spoolman.js";
import { setupMqtt } from "./mqtt.js";

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
        res.json(printers);
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
            console.log(printer.name, printer.logFilePath, `Monitoring enabled for ${printer.name} - ${printer.id}`);

            if (MAX_RETRIES > 0) {
                console.log(printer.name, printer.logFilePath, "Monitoring re-enabled → resetting state & restarting MQTT");
                printer.reconnectAttempts = 0;
                printer.mqttRunning = false;
                printer.mqttStatus = "Reconnecting";
                setupMqtt(printer);
            } else {
                console.log(printer.name, printer.logFilePath, "Monitoring re-enabled (MAX_RETRIES = 0 → unlimited). Nothing to restart.");
            }
        }
    });
}
