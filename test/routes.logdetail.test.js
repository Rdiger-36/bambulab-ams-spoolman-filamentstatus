import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

import { startTestApp, call, UI_HEADERS } from "./helpers/app.js";

// The per-printer log override and the raw MQTT trace, over HTTP against a
// throwaway data directory, so the write path into printers.json is covered
// rather than only the pure functions behind it.
const SERIAL = "22E8BJ581201877";

let app;

before(async () => {
    app = await startTestApp({
        seedPrinters: [{ id: SERIAL, code: "12345678", ip: "192.168.1.50", name: "P2S" }],
    });
});
after(async () => { await app.close(); });

/** Writes a line into a printer's trace file, the way appendTrace would. */
function seedTrace(line) {
    const file = path.join(process.env.LOG_DIR, `${SERIAL}.mqtt.log`);
    fs.writeFileSync(file, `${line}\n`);
    return file;
}

test("a printer starts out following the global log settings", async () => {
    const { status, body } = await call(`${app.url}/api/printers/config`);

    assert.equal(status, 200);
    assert.deepEqual(body[0].logDetail, {});
    // Nothing is written for a printer that decided nothing
    assert.equal("logDetail" in app.readJson("printers.json")[0], false);
});

test("an override is stored and handed back", async () => {
    const { status, body } = await call(`${app.url}/api/printers/${SERIAL}/logdetail`, "PUT", {
        level: "trace",
        categories: ["mqtt", "ams"],
        mqttTrace: true,
    });

    assert.equal(status, 200);
    assert.deepEqual(body.printer.logDetail, {
        level: "trace",
        categories: ["mqtt", "ams"],
        mqttTrace: true,
    });

    assert.deepEqual(app.readJson("printers.json")[0].logDetail, {
        level: "trace",
        categories: ["mqtt", "ams"],
        mqttTrace: true,
    });
});

test("an empty body puts the printer back on the global settings", async () => {
    await call(`${app.url}/api/printers/${SERIAL}/logdetail`, "PUT", { level: "trace" });

    const { status, body } = await call(`${app.url}/api/printers/${SERIAL}/logdetail`, "PUT", {});

    assert.equal(status, 200);
    assert.deepEqual(body.printer.logDetail, {});
    // Absent rather than an empty object, so the file of an installation that
    // tried the dialog once looks like one that never did
    assert.equal("logDetail" in app.readJson("printers.json")[0], false);
});

test("a value the schema does not know is dropped, not refused", async () => {
    const { status, body } = await call(`${app.url}/api/printers/${SERIAL}/logdetail`, "PUT", {
        level: "loud",
        categories: ["mqtt", "telepathy"],
    });

    assert.equal(status, 200);
    assert.deepEqual(body.printer.logDetail, { categories: ["mqtt"] });

    await call(`${app.url}/api/printers/${SERIAL}/logdetail`, "PUT", {});
});

test("an override for a printer that does not exist is a 404", async () => {
    const { status } = await call(`${app.url}/api/printers/NOSUCHPRINTER/logdetail`, "PUT", { level: "debug" });

    assert.equal(status, 404);
});

test("the trace is read through the log route as a stream of its own", async () => {
    seedTrace('{"print":{"gcode_state":"RUNNING"}}');

    const log = await call(`${app.url}/api/logs/${SERIAL}?limit=10`);
    const trace = await call(`${app.url}/api/logs/${SERIAL}?limit=10&stream=mqtt`);

    assert.equal(trace.status, 200);
    assert.equal(trace.body.logs.length, 1);
    assert.match(trace.body.logs[0], /gcode_state/);
    // The two files are separate: the ordinary log never carries the reports
    assert.equal(log.body.logs.some(line => line.includes("gcode_state")), false);
});

test("the server has no trace to ask for", async () => {
    const { status } = await call(`${app.url}/api/logs/server?stream=mqtt`);

    assert.equal(status, 404);
});

test("the trace download is named apart from the log download", async () => {
    seedTrace('{"print":{}}');

    const response = await fetch(`${app.url}/api/logs/${SERIAL}/download?stream=mqtt&anonymize=false`, { headers: UI_HEADERS });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition"), /_mqtt_full\.log/);
});

test("the anonymised trace download loses the serial the reports carry", async () => {
    seedTrace(`{"dev_id":"${SERIAL}","print":{"ams":{}}}`);

    const response = await fetch(`${app.url}/api/logs/${SERIAL}/download?stream=mqtt`, { headers: UI_HEADERS });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.equal(text.includes(SERIAL), false);
});
