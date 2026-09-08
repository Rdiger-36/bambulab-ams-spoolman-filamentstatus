import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";

// The module reads its path from config.js at import time, so DATA_DIR has to
// point at a throwaway directory before the first import.
let dir, printStatePath, rememberPrintStart, recallPrintStart, forgetPrintStart, resetPrintStateForTests, handlePrintStateChange;

before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-printstate-"));
    process.env.DATA_DIR = path.join(dir, "printers");
    process.env.LOG_DIR = path.join(dir, "logs");
    fs.ensureDirSync(process.env.DATA_DIR);
    fs.ensureDirSync(process.env.LOG_DIR);

    ({ printStatePath } = await import("../src/config.js"));
    ({ rememberPrintStart, recallPrintStart, forgetPrintStart, resetPrintStateForTests } = await import("../src/printstate.js"));
    ({ handlePrintStateChange } = await import("../src/mqtt.js"));
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
