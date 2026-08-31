import express from "express";
import fs from "fs-extra";
import os from "os";
import path from "path";

/**
 * Starts the HTTP API against a throwaway data directory.
 *
 * The routes are registered on a bare Express app rather than through
 * `backend.js`, so nothing waits for Spoolman and no monitor loop is started.
 * DATA_DIR and LOG_DIR are pointed at a temporary directory before the modules
 * are imported, which is what keeps the write paths, printers.json,
 * settings.json and the log files, away from a real installation. They are read
 * once at import time, so this has to run before the first import and each test
 * file gets its own process anyway.
 *
 * @returns {Promise<{url: string, dataDir: string, close: function(): Promise<void>, readJson: function(string): object|null}>}
 */
export async function startTestApp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-test-"));
    process.env.DATA_DIR = path.join(dir, "printers");
    process.env.LOG_DIR = path.join(dir, "logs");
    fs.ensureDirSync(process.env.DATA_DIR);
    fs.ensureDirSync(process.env.LOG_DIR);

    const { registerRoutes } = await import("../../src/routes.js");
    const { printers } = await import("../../src/printers.js");

    const app = express();
    app.use(express.json());
    registerRoutes(app, printers);

    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));

    return {
        url: `http://127.0.0.1:${server.address().port}`,
        dataDir: process.env.DATA_DIR,
        readJson(name) {
            try {
                return JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, name), "utf-8"));
            } catch {
                return null;
            }
        },
        async close() {
            await new Promise(resolve => server.close(resolve));
            fs.removeSync(dir);
        },
    };
}

/** Small fetch wrapper returning status and parsed body together. */
export async function call(url, method = "GET", body) {
    const response = await fetch(url, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    return { status: response.status, body: await response.json().catch(() => null) };
}
