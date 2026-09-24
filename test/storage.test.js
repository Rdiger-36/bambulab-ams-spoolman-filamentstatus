import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";

// DATA_DIR and LOG_DIR are read once at import time, so they are set before
// the first import below. The log line noteStorage() writes lands in there.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-storage-"));
process.env.DATA_DIR = path.join(dir, "printers");
process.env.LOG_DIR = path.join(dir, "logs");
fs.ensureDirSync(process.env.DATA_DIR);
fs.ensureDirSync(process.env.LOG_DIR);

const { noteStorage } = await import("../src/mqtt.js");
const { flushLogs } = await import("../src/logger.js");

/** A printer as created by printers.js, reduced to what noteStorage() reads. */
function fakePrinter() {
    return {
        id: "TESTPRINTER0001",
        name: "Test Printer",
        logFilePath: path.join(process.env.LOG_DIR, "TESTPRINTER0001.log"),
        storagePresent: null,
    };
}

/** What the printer's log holds once every queued write has landed. */
async function logged(printer) {
    // The console override writes asynchronously and queues per file; the
    // second wait catches a write that was queued after the first flush.
    await flushLogs(printer.logFilePath);
    await new Promise(resolve => setTimeout(resolve, 20));
    await flushLogs(printer.logFilePath);
    return fs.existsSync(printer.logFilePath) ? fs.readFileSync(printer.logFilePath, "utf-8") : "";
}

test("a report with sdcard sets the value, a report without leaves it alone", () => {
    const printer = fakePrinter();

    assert.equal(noteStorage(printer, { gcode_state: "IDLE" }), false);
    assert.equal(printer.storagePresent, null);

    assert.equal(noteStorage(printer, { sdcard: true }), true);
    assert.equal(printer.storagePresent, true);

    // A delta that says nothing about the storage, the way a P1S sends them,
    // must not be read as "gone".
    assert.equal(noteStorage(printer, { layer_num: 12 }), false);
    assert.equal(printer.storagePresent, true);

    // Anything that is not a boolean is not an answer either.
    assert.equal(noteStorage(printer, { sdcard: "true" }), false);
    assert.equal(printer.storagePresent, true);
});

test("a missing stick is logged once, not on every report", async () => {
    const printer = fakePrinter();

    noteStorage(printer, { sdcard: false });
    noteStorage(printer, { sdcard: false });
    noteStorage(printer, { sdcard: false });

    assert.equal(printer.storagePresent, false);
    const lines = (await logged(printer)).split("\n").filter(line => line.includes("No USB stick or SD card"));
    assert.equal(lines.length, 1);
});

test("the stick coming back is logged, a stick that was always in is not", async () => {
    const present = fakePrinter();
    noteStorage(present, { sdcard: true });
    assert.equal((await logged(present)).includes("again"), false);

    const returned = fakePrinter();
    noteStorage(returned, { sdcard: false });
    noteStorage(returned, { sdcard: true });
    assert.ok((await logged(returned)).includes("in the printer again"));
});
