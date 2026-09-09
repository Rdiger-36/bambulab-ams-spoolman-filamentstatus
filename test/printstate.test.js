import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";

// The module reads its path from config.js at import time, so DATA_DIR has to
// point at a throwaway directory before the first import.
let dir, printStatePath, rememberPrintStart, recallPrintStart, forgetPrintStart, resetPrintStateForTests, handlePrintStateChange, deltaAsReport;

before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-printstate-"));
    process.env.DATA_DIR = path.join(dir, "printers");
    process.env.LOG_DIR = path.join(dir, "logs");
    fs.ensureDirSync(process.env.DATA_DIR);
    fs.ensureDirSync(process.env.LOG_DIR);

    ({ printStatePath } = await import("../src/config.js"));
    ({ rememberPrintStart, recallPrintStart, forgetPrintStart, resetPrintStateForTests } = await import("../src/printstate.js"));
    ({ handlePrintStateChange, deltaAsReport } = await import("../src/mqtt.js"));
});

after(() => { fs.removeSync(dir); });

test("a start is remembered for the job, survives a reload, and is forgotten at the end", () => {
    rememberPrintStart("SERIAL", "Cube", Date.now() - 1000);
    const stored = JSON.parse(fs.readFileSync(printStatePath, "utf-8"));
    assert.equal(stored.printers.SERIAL.jobName, "Cube");

    resetPrintStateForTests();
    assert.equal(typeof recallPrintStart("SERIAL", "Cube"), "number");
    // Another job, or another printer, gets nothing
    assert.equal(recallPrintStart("SERIAL", "Other"), null);
    assert.equal(recallPrintStart("OTHER", "Cube"), null);

    forgetPrintStart("SERIAL");
    assert.equal(recallPrintStart("SERIAL", "Cube"), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(printStatePath, "utf-8")).printers, {});
});

test("a start older than a week is not trusted", () => {
    rememberPrintStart("SERIAL", "Cube", Date.now() - 8 * 24 * 60 * 60 * 1000);
    assert.equal(recallPrintStart("SERIAL", "Cube"), null);
    forgetPrintStart("SERIAL");
});

const printer = (over = {}) => ({
    id: "SERIAL",
    name: "Test Printer",
    logFilePath: "/dev/null",
    currentGcodeState: "IDLE",
    currentJobName: null,
    currentLayerNum: 0,
    currentSliceInfo: null,
    sliceFetchDone: true,
    consumptionBooked: false,
    currentMapping: null,
    pendingMapping: null,
    lastPrintSummary: null,
    lastPrintError: null,
    printStartedAt: null,
    stateSeenSinceStart: false,
    ...over,
});

test("a restart mid print keeps the print's start time, a new print starts its own", async () => {
    // The process that saw the print begin
    const before = printer();
    await handlePrintStateChange(before, { gcode_state: "IDLE" });
    await handlePrintStateChange(before, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 1 });
    const started = before.printStartedAt;
    assert.equal(typeof started, "number");

    // The process after a restart: its first report already says RUNNING
    const after = printer();
    await new Promise(resolve => setTimeout(resolve, 5));
    await handlePrintStateChange(after, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 7 });
    assert.equal(after.printStartedAt, started);

    // The print ends, the start is forgotten, and the same job printed again
    // later starts a clock of its own
    await handlePrintStateChange(after, { gcode_state: "FINISH", subtask_name: "Cube", layer_num: 11 });
    assert.equal(recallPrintStart("SERIAL", "Cube"), null);

    const again = printer();
    await handlePrintStateChange(again, { gcode_state: "IDLE" });
    await handlePrintStateChange(again, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 1 });
    assert.notEqual(again.printStartedAt, started);
    assert.ok(again.printStartedAt > started);
});

test("only the first report after a start may take an old start over", async () => {
    rememberPrintStart("SERIAL", "Cube", Date.now() - 60_000);
    const p = printer();
    // A report was already read, so this is a print that begins now
    await handlePrintStateChange(p, { gcode_state: "IDLE" });
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 1 });
    assert.ok(Date.now() - p.printStartedAt < 5_000);
    forgetPrintStart("SERIAL");
});

test("the report that starts a job still carries the previous job's last layer, and a job starts at 0", async () => {
    const p = printer();
    await handlePrintStateChange(p, { gcode_state: "FINISH", subtask_name: "Old", layer_num: 11 });
    // Measured on a P2S: FINISH to RUNNING with layer_num 11, then 0 five seconds later
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 11 });
    assert.equal(p.currentLayerNum, 0);
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 0 });
    assert.equal(p.currentLayerNum, 0);
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 4 });
    // A stale lower value in the next report does not pull it back
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 3 });
    assert.equal(p.currentLayerNum, 4);
    await handlePrintStateChange(p, { gcode_state: "FINISH", subtask_name: "Cube", layer_num: 11 });
    assert.equal(p.currentLayerNum, 11);
    forgetPrintStart("SERIAL");
});

test("the first report after the service came up takes the running print's layer", async () => {
    const p = printer();
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 7 });
    assert.equal(p.currentLayerNum, 7);
    forgetPrintStart("SERIAL");
});

// A P1S sends a full report every few minutes and only what changed in between.
// The deltas below are taken from the raw trace of 2026-09-09: layer_num on its
// own, print_error three seconds ahead of FAILED, and a job start without
// subtask_name because the name had not changed.

test("a delta with only the layer is read as a report of the running state", async () => {
    const p = printer();
    await handlePrintStateChange(p, { gcode_state: "IDLE" });
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 0 });

    const delta = deltaAsReport(p, { layer_num: 5 });
    assert.equal(delta.gcode_state, "RUNNING");
    await handlePrintStateChange(p, delta);
    assert.equal(p.currentLayerNum, 5);

    // A full report with a stale layer next to it does not pull it back
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 4 });
    assert.equal(p.currentLayerNum, 5);

    await handlePrintStateChange(p, { gcode_state: "FAILED", subtask_name: "Cube" });
    assert.equal(p.lastPrintSummary.layerNum, 5);
    forgetPrintStart("SERIAL");
});

test("a delta ahead of the first report with a state is dropped, so the restart rule still holds", async () => {
    const p = printer();
    assert.equal(deltaAsReport(p, { layer_num: 7 }), null);
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 7 });
    assert.equal(p.currentLayerNum, 7);
    forgetPrintStart("SERIAL");
});

test("a delta that says nothing about the print is dropped", async () => {
    const p = printer();
    await handlePrintStateChange(p, { gcode_state: "IDLE" });
    assert.equal(deltaAsReport(p, { bed_temper: 40, wifi_signal: "-48dBm" }), null);
    assert.equal(deltaAsReport(p, { gcode_state: "RUNNING" }), null);
    assert.equal(deltaAsReport(p, null), null);
});

test("the error a P1S names in a delta before FAILED lands in the summary", async () => {
    const p = printer();
    await handlePrintStateChange(p, { gcode_state: "IDLE", print_error: 0 });
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 0, print_error: 0 });
    await handlePrintStateChange(p, deltaAsReport(p, { print_error: 50348044 }));
    await handlePrintStateChange(p, { gcode_state: "FAILED" });
    assert.match(p.lastPrintSummary.printError, /^Printer error 50348044/);
    forgetPrintStart("SERIAL");
});

test("a delta without the error fields does not clear the error the print started with", async () => {
    const p = printer();
    await handlePrintStateChange(p, { gcode_state: "FAILED", print_error: 50348044 });
    // The report that starts the next print still carries the old complaint
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 0, print_error: 50348044 });
    await handlePrintStateChange(p, deltaAsReport(p, { layer_num: 1 }));
    assert.equal(p.lastPrintError, null);
    // Only a report that names the field again moves the printer on
    await handlePrintStateChange(p, deltaAsReport(p, { print_error: 0 }));
    await handlePrintStateChange(p, deltaAsReport(p, { print_error: 50348044 }));
    assert.match(p.lastPrintError, /^Printer error 50348044/);
    forgetPrintStart("SERIAL");
});

test("a job with the same name as the last one takes its name from the Studio echo", async () => {
    // After a restart nothing remembers the last name, and the P1S leaves
    // subtask_name out of the report that starts the job
    const p = printer({ currentJobName: null, pendingMapping: { jobName: "Würfel", slots: ["A1", "A3", "A4"] } });
    await handlePrintStateChange(p, { gcode_state: "FAILED", subtask_name: "Würfel" });
    await handlePrintStateChange(p, { gcode_state: "PREPARE", gcode_file: "Würfel.3mf" });
    assert.equal(p.currentJobName, "Würfel");
    assert.equal(p.currentGcodeFile, "Würfel.3mf");
    assert.deepEqual(p.currentMapping, ["A1", "A3", "A4"]);
    forgetPrintStart("SERIAL");
});
