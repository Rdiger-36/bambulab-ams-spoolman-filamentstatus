import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { flushLogs, trimLogFile } from "../src/logger.js";

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

test("a log file past the limit is trimmed to its last lines", async () => {
    // Nothing truncates these files, they are only appended to, so this is what
    // keeps a long running installation from filling its volume.
    const file = tmpLog("trim.log");
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    fs.writeFileSync(file, lines.join("\n") + "\n");

    await trimLogFile(file, 1024, 100);

    const kept = readLines(file);
    assert.equal(kept.length, 100);
    assert.equal(kept.at(-1), "line 4999");
    assert.equal(kept[0], "line 4900");
});

test("a log file below the limit is left alone", async () => {
    const file = tmpLog("small.log");
    fs.writeFileSync(file, "one\ntwo\n");

    await trimLogFile(file, 1024, 100);

    assert.equal(fs.readFileSync(file, "utf8"), "one\ntwo\n");
});
