import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { startTestApp, call } from "./helpers/app.js";

// What happens to a finished print on the dashboard: it is shown with its
// booking label, it clears itself after PRINT_RESET_MINUTES or when somebody
// says so, and its summary stays readable afterwards.
//
// The one thing worth a test of its own is that clearing survives the printer
// repeating itself. A P2S sends its terminal `gcode_state` in every report for
// as long as it sits there, so a cleared result that were derived from the
// state alone would come straight back on the next report.

let app;
let printer;
let sliceInfo;
let settings;

const SERIAL = "01P00A000000009";

const loadedSlot = (amsId, { id, idx, type, color }) => ({
    amsId,
    slotState: "Loaded (Bambu Lab)",
    connectedViaTag: true,
    connectedViaMapping: false,
    existingSpool: { id, remaining_weight: 500, initial_weight: 1000, filament: { name: `spool ${id}` } },
    slot: {
        tray_uuid: `uuid-${amsId}`,
        tray_type: type,
        tray_info_idx: idx,
        tray_color: color,
        cols: [color],
        tray_weight: "1000",
        remain: 50,
    },
});

before(async () => {
    app = await startTestApp({
        seedPrinters: [{ id: SERIAL, code: "12345678", ip: "127.0.0.1", name: "Test Printer" }],
    });

    const { parseSliceInfo } = await import("../src/gcode.js");
    const { printers } = await import("../src/printers.js");
    ({ settings } = await import("../src/settings.js"));

    const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "four_colours.config");
    sliceInfo = parseSliceInfo(fs.readFileSync(fixture, "utf-8"));

    printer = printers.find(p => p.id === SERIAL);
});

after(async () => { await app.close(); });

/** A printer sitting on a finished print, the way the MQTT handler leaves it. */
beforeEach(() => {
    const f0 = sliceInfo.filaments[0];

    printer.currentJobName        = "four colours";
    printer.currentGcodeState     = "FINISH";
    printer.currentLayerNum       = 40;
    printer.currentSliceInfo      = sliceInfo;
    printer.currentMapping        = null;
    printer.consumptionBooked     = true;
    printer.printResultDismissed  = false;
    printer.printResetAt          = Date.now() + 10 * 60_000;
    printer.printStartedAt        = Date.now() - 90_000;
    printer.lastPrintSummary      = {
        state: "FINISH",
        jobName: "four colours",
        endedAt: Date.now(),
        startedAt: printer.printStartedAt,
        durationMs: 90_000,
        layerNum: 40,
        totalLayers: sliceInfo.totalLayers,
        printError: null,
        note: null,
        rows: [{ amsId: "A1", type: "PLA", color: "#FFFFFF", grams: 12.5, status: "booked", spoolId: 101 }],
    };
    printer.spoolData = [
        loadedSlot("A1", { id: 101, idx: f0.tray_info_idx, type: "PLA", color: f0.color.replace("#", "") }),
    ];
});

test("a finished print is reported with its booking label and its deadline", async () => {
    const { status, body } = await call(`${app.url}/api/print/${SERIAL}`);

    assert.equal(status, 200);
    assert.equal(body.gcodeState, "FINISH");
    assert.equal(body.jobName, "four colours");
    assert.equal(body.consumptionBooked, true);
    assert.equal(body.printResultCleared, false);
    assert.ok(body.printResetAt > Date.now());
    // The figures are still on the card, which is what the columns show.
    assert.ok(body.fullConsumption);
});

test("clearing it by hand empties the card but keeps the summary", async () => {
    const cleared = await call(`${app.url}/api/print/${SERIAL}/clear`, "POST");
    assert.equal(cleared.status, 200);

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);

    assert.equal(body.gcodeState, "IDLE");
    assert.equal(body.jobName, null);
    assert.equal(body.consumptionBooked, false);
    assert.equal(body.printResultCleared, true);
    // The "Needed" and "After print" columns read these two, so both have to be
    // gone or the finished print keeps standing in the table.
    assert.equal(body.fullConsumption, null);
    assert.equal(body.consumption, null);
    assert.equal(body.sliceInfo, null);

    // The dialog behind the button is still there.
    assert.equal(body.lastPrintSummary.jobName, "four colours");
    assert.equal(body.lastPrintSummary.rows.length, 1);
});

test("a cleared result stays cleared when the printer repeats FINISH", async () => {
    await call(`${app.url}/api/print/${SERIAL}/clear`, "POST");

    // What every further report does: it sets the state again, unchanged.
    printer.currentGcodeState = "FINISH";

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);
    assert.equal(body.gcodeState, "IDLE");
    assert.equal(body.printResultCleared, true);
});

test("the deadline clears the result without anybody pressing anything", async () => {
    printer.printResetAt = Date.now() - 1;

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);
    assert.equal(body.gcodeState, "IDLE");
    assert.equal(body.printResultCleared, true);
    assert.equal(body.lastPrintSummary.jobName, "four colours");
});

test("without a deadline the result waits to be cleared by hand", async () => {
    // What PRINT_RESET_MINUTES of 0 leaves behind
    printer.printResetAt = null;

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);
    assert.equal(body.gcodeState, "FINISH");
    assert.equal(body.printResultCleared, false);
    assert.equal(body.printResetAt, null);
});

test("a running print cannot be cleared", async () => {
    printer.currentGcodeState = "RUNNING";
    printer.consumptionBooked = false;

    const { status, body } = await call(`${app.url}/api/print/${SERIAL}/clear`, "POST");

    assert.equal(status, 409);
    assert.match(body.error, /is printing/);
});

test("the manual FTPS test is not affected by a cleared result", async () => {
    await call(`${app.url}/api/print/${SERIAL}/clear`, "POST");

    // ?job= names its own file and does not read the printer's state, so it has
    // to keep reaching the download rather than being answered as idle. There
    // is no FTPS server here, so the error is the proof it tried.
    const { body } = await call(`${app.url}/api/print/${SERIAL}?job=whatever`);
    assert.match(body.error, /FTPS fetch failed/);
});

test("PRINT_RESET_MINUTES keeps 0 and clamps what is out of range", async () => {
    const { coerceSetting } = await import("../src/settings.js");

    // 0 is a value, not an empty field: it is what "never clear it on its own"
    // is stored as, so it has to survive coercion rather than fall back to the
    // default of 10.
    assert.deepEqual(coerceSetting("PRINT_RESET_MINUTES", "0"), { value: 0 });
    assert.deepEqual(coerceSetting("PRINT_RESET_MINUTES", "10"), { value: 10 });
    // Integers are clamped rather than refused here, like every other one in
    // the schema. Both ends land somewhere usable: a negative value becomes
    // "never", and an absurd one the 4 hour maximum.
    assert.deepEqual(coerceSetting("PRINT_RESET_MINUTES", "-1"), { value: 0 });
    assert.deepEqual(coerceSetting("PRINT_RESET_MINUTES", "9999"), { value: 240 });
    assert.equal(settings.PRINT_RESET_MINUTES, 10);
});

test("an unbooked filament is told apart from one no slot carried", async () => {
    const { unbookedReason } = await import("../src/mqtt.js");

    // In the plate, and a slot ran it, but nothing links that slot to Spoolman.
    // This is the one a user can fix, so it says how.
    const inSlot = unbookedReason({ amsId: "A4" });
    assert.match(inSlot, /sliced file/);
    assert.match(inSlot, /A4 printed it/);
    assert.match(inSlot, /Assign it in the Web UI/);

    // In the plate and nothing on the printer carried it: the dashboard's
    // "required but not loaded". Nothing to assign, so it does not ask.
    const noSlot = unbookedReason({ amsId: null });
    assert.match(noSlot, /sliced file/);
    assert.match(noSlot, /no slot of the printer carried it/);
    assert.equal(/Assign it in the Web UI/.test(noSlot), false);
});
