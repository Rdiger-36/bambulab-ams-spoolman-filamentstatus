import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { flushLogs, logFileSet, rotateLogFile, tailLogLines } from "../src/logger.js";

// Flushing once only awaits what is queued at that moment. Yielding to the event
// loop in between catches a write that was still being scheduled, so the test
// reports a real result instead of racing the logger.
async function settle(file) {
    for (let i = 0; i < 3; i++) {
        await flushLogs(file);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    await flushLogs(file);
}

// One of the messages the logger collapses instead of appending (see
// COLLAPSING_PREFIXES): it repeats every update interval during normal operation.
const COLLAPSING = "No new AMS Data or changes in Spoolman found.";

function tmpLog(name) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "amslog-")), name);
    fs.writeFileSync(file, "");
    return file;
}

const readLines = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

test("a collapsing message does not swallow lines logged around it", async () => {
    // The collapse rewrites the whole file. It used to snapshot the file outside
    // the write queue, so everything appended between that read and the write was
    // lost, in practice almost the entire log.
    const file = tmpLog("interleaved.log");
    const count = 200;

    for (let i = 0; i < count; i++) {
        console.log("dev", file, `payload ${i}`);
        console.log("dev", file, `${COLLAPSING} paused until X`);
    }
    await settle(file);

    const payloads = readLines(file).filter(l => l.includes("payload "));
    assert.equal(payloads.length, count);
});

test("repeated collapsing messages stay a single line", async () => {
    const file = tmpLog("collapsed.log");

    for (let i = 0; i < 50; i++) console.log("dev", file, `${COLLAPSING} paused until ${i}`);
    await settle(file);

    const lines = readLines(file);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].endsWith("paused until 49"), `unexpected last line: ${lines[0]}`);
});

test("a collapsing message appends when it is not the last line", async () => {
    const file = tmpLog("mixed.log");

    console.log("dev", file, `${COLLAPSING} paused until 1`);
    console.log("dev", file, "something else");
    console.log("dev", file, `${COLLAPSING} paused until 2`);
    await settle(file);

    const lines = readLines(file);
    assert.equal(lines.length, 3);
    assert.ok(lines[2].includes("paused until 2"));
});

test("errors and debug output share the queue with everything else", async () => {
    // Both used to append outside the queue, so a concurrent collapse rewrite
    // could drop them.
    const file = tmpLog("levels.log");

    for (let i = 0; i < 100; i++) {
        console.error("dev", file, `boom ${i}`);
        console.log("dev", file, `${COLLAPSING} paused until ${i}`);
    }
    await settle(file);

    const errors = readLines(file).filter(l => l.includes("boom "));
    assert.equal(errors.length, 100);
});

test("a log file past the limit is rotated and the history shifts along", async () => {
    // Nothing truncates these files, they are only appended to, so this is what
    // keeps a long running installation from filling its volume.
    const file = tmpLog("rotate.log");
    fs.writeFileSync(file, "first round\n".repeat(200));

    assert.equal(await rotateLogFile(file, { maxBytes: 100, keep: 2 }), true);
    assert.equal(fs.readFileSync(file, "utf8"), "");
    assert.equal(readLines(`${file}.1`)[0], "first round");

    fs.writeFileSync(file, "second round\n".repeat(200));
    await rotateLogFile(file, { maxBytes: 100, keep: 2 });

    assert.equal(readLines(`${file}.1`)[0], "second round");
    assert.equal(readLines(`${file}.2`)[0], "first round");

    // The third round pushes the oldest one out
    fs.writeFileSync(file, "third round\n".repeat(200));
    await rotateLogFile(file, { maxBytes: 100, keep: 2 });

    assert.equal(readLines(`${file}.1`)[0], "third round");
    assert.equal(readLines(`${file}.2`)[0], "second round");
    assert.equal(fs.existsSync(`${file}.3`), false);
});

test("keeping nothing starts the file over without a history", async () => {
    const file = tmpLog("nokeep.log");
    fs.writeFileSync(file, "gone\n".repeat(200));

    assert.equal(await rotateLogFile(file, { maxBytes: 100, keep: 0 }), true);

    assert.equal(fs.readFileSync(file, "utf8"), "");
    assert.equal(fs.existsSync(`${file}.1`), false);
});

test("a log file below the limit is left alone", async () => {
    const file = tmpLog("small.log");
    fs.writeFileSync(file, "one\ntwo\n");

    assert.equal(await rotateLogFile(file, { maxBytes: 1024, keep: 2 }), false);

    assert.equal(fs.readFileSync(file, "utf8"), "one\ntwo\n");
    assert.equal(fs.existsSync(`${file}.1`), false);
});

test("a missing log file is not an error", async () => {
    const file = tmpLog("gone.log");
    fs.rmSync(file);

    assert.equal(await rotateLogFile(file, { maxBytes: 1, keep: 2 }), false);
});

test("the rotated files are listed newest first, gaps included", async () => {
    // Lowering the keep count leaves the files past it behind, so counting up
    // from .1 would stop before them and lose history the viewer could show.
    const file = tmpLog("set.log");
    fs.writeFileSync(`${file}.1`, "one\n");
    fs.writeFileSync(`${file}.3`, "three\n");

    assert.deepEqual(await logFileSet(file), [file, `${file}.1`, `${file}.3`]);
});

test("a log that has never been written is an empty set", async () => {
    const file = tmpLog("none.log");
    fs.rmSync(file);

    assert.deepEqual(await logFileSet(file), []);
});

test("the tail continues into the rotated files when the current one is short", async () => {
    // Right after a rotation the current file holds almost nothing, and the
    // viewer used to go blank because it only ever read that one file.
    const file = tmpLog("tail.log");
    fs.writeFileSync(`${file}.2`, "oldest 1\noldest 2\n");
    fs.writeFileSync(`${file}.1`, "older 1\nolder 2\n");
    fs.writeFileSync(file, "current 1\n");

    assert.deepEqual(await tailLogLines(file, 5), [
        "oldest 1", "oldest 2", "older 1", "older 2", "current 1",
    ]);

    // Asking for fewer lines stops in the middle of the history
    assert.deepEqual(await tailLogLines(file, 2), ["older 2", "current 1"]);
});

test("the tail of a log without history is the current file alone", async () => {
    const file = tmpLog("single.log");
    fs.writeFileSync(file, "a\nb\n");

    assert.deepEqual(await tailLogLines(file, 10), ["a", "b"]);
});

test("the tail of a log that does not exist yet is empty", async () => {
    const file = tmpLog("missing.log");
    fs.rmSync(file);

    assert.deepEqual(await tailLogLines(file, 10), []);
});
