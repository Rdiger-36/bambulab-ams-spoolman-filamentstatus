import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { appendTrace, debug, flushLogs, setLogDetail, shouldLog, trace, TRACE_SUFFIX } from "../src/logger.js";
import { settings, coerceSetting, migrateStored, LOG_CATEGORIES, LOG_LEVELS } from "../src/settings.js";

// Flushing once only awaits what is queued at that moment. Yielding to the event
// loop in between catches a write that was still being scheduled.
async function settle(file) {
    for (let i = 0; i < 3; i++) {
        await flushLogs(file);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    await flushLogs(file);
}

function tmpFile(name) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "amsdetail-")), name);
    fs.writeFileSync(file, "");
    return file;
}

const readLines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

/** Runs a body with the global settings temporarily set, then puts them back. */
function withSettings(patch, body) {
    const before = { ...settings };
    Object.assign(settings, patch);
    try {
        return body();
    } finally {
        for (const key of Object.keys(patch)) settings[key] = before[key];
    }
}

test("the level is a ladder, quietest first", () => {
    assert.deepEqual(LOG_LEVELS, ["errors", "normal", "debug", "trace"]);
});

test("a line is written while its level sits at or below the configured one", () => {
    const file = "/tmp/ladder.log";

    withSettings({ LOG_LEVEL: "normal" }, () => {
        assert.equal(shouldLog("errors", null, file), true);
        assert.equal(shouldLog("normal", null, file), true);
        assert.equal(shouldLog("debug", "mqtt", file), false);
        assert.equal(shouldLog("trace", "mqtt", file), false);
    });

    withSettings({ LOG_LEVEL: "debug" }, () => {
        assert.equal(shouldLog("debug", "mqtt", file), true);
        // The payload dumps stay out of a debug log, which is what made one
        // unreadable within minutes before the ladder existed
        assert.equal(shouldLog("trace", "mqtt", file), false);
    });

    withSettings({ LOG_LEVEL: "trace" }, () => {
        assert.equal(shouldLog("trace", "mqtt", file), true);
    });

    // "errors" is the quiet end: even the ordinary progress lines stop
    withSettings({ LOG_LEVEL: "errors" }, () => {
        assert.equal(shouldLog("errors", null, file), true);
        assert.equal(shouldLog("normal", null, file), false);
    });
});

test("an unreadable level falls back to normal rather than silencing the log", () => {
    withSettings({ LOG_LEVEL: "verbose" }, () => {
        assert.equal(shouldLog("normal", null, "/tmp/unknown.log"), true);
        assert.equal(shouldLog("debug", "mqtt", "/tmp/unknown.log"), false);
    });
});

test("a category switched off never hides an error or a progress line", () => {
    withSettings({ LOG_LEVEL: "trace", LOG_CATEGORIES: ["spoolman"] }, () => {
        const file = "/tmp/categories.log";

        assert.equal(shouldLog("debug", "mqtt", file), false);
        assert.equal(shouldLog("trace", "mqtt", file), false);
        assert.equal(shouldLog("debug", "spoolman", file), true);

        // Neither of these carries a category, and neither may be filtered
        assert.equal(shouldLog("errors", null, file), true);
        assert.equal(shouldLog("normal", null, file), true);
    });
});

test("a category the schema does not know is never filtered", () => {
    withSettings({ LOG_LEVEL: "debug", LOG_CATEGORIES: [] }, () => {
        // What an uncategorised console.debug produces
        assert.equal(shouldLog("debug", null, "/tmp/unknown-cat.log"), true);
        assert.equal(shouldLog("debug", "invented", "/tmp/unknown-cat.log"), true);
    });
});

test("a per-file override beats the global level in both directions", () => {
    const loud = "/tmp/loud.log";
    const quiet = "/tmp/quiet.log";

    withSettings({ LOG_LEVEL: "normal", LOG_CATEGORIES: [...LOG_CATEGORIES] }, () => {
        setLogDetail(loud, { level: "trace" });
        setLogDetail(quiet, { level: "errors" });

        assert.equal(shouldLog("trace", "mqtt", loud), true);
        assert.equal(shouldLog("normal", null, quiet), false);
        // Everything else still follows the global setting
        assert.equal(shouldLog("debug", "mqtt", "/tmp/untouched.log"), false);

        setLogDetail(loud, null);
        assert.equal(shouldLog("trace", "mqtt", loud), false);
        setLogDetail(quiet, null);
    });
});

test("debug and trace write their level into the line", async () => {
    const file = tmpFile("levels.log");

    await withSettings({ LOG_LEVEL: "trace", LOG_CATEGORIES: [...LOG_CATEGORIES] }, async () => {
        debug("mqtt", "P2S", file, "a debug line");
        trace("mqtt", "P2S", file, "a trace line");
        await settle(file);
    });

    const lines = readLines(file);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\[DEBUG\] .* - P2S - a debug line$/);
    assert.match(lines[1], /^\[TRACE\] .* - P2S - a trace line$/);
});

test("a trace file keeps every report on one line, timestamped", async () => {
    const file = tmpFile(`22E8BJ581201877${TRACE_SUFFIX}`);

    // A report is one JSON document, but nothing guarantees it holds no newline,
    // and one report per line is what makes the file readable at all
    appendTrace(file, '{"print":{"gcode_state":"RUNNING"}}');
    appendTrace(file, Buffer.from('{"print":\n{"ams":null}}'));
    await settle(file);

    const lines = readLines(file);
    assert.equal(lines.length, 2);
    assert.ok(lines[0].endsWith('{"print":{"gcode_state":"RUNNING"}}'));
    assert.ok(lines[1].endsWith('{"print": {"ams":null}}'));
});

test("the printer's own indentation is folded away with the line break", async () => {
    const file = tmpFile(`PRETTY${TRACE_SUFFIX}`);

    // A P2S pretty-prints. Measured on one: half of every 17 KB report was the
    // indentation, and dropping only the line break left all of it behind.
    const report = '{\n    "print": {\n        "gcode_state": "RUNNING",\n        "layer_num": 3\n    }\n}';
    appendTrace(file, report);
    await settle(file);

    const body = readLines(file)[0].split(" ").slice(1).join(" ");
    assert.equal(body, '{ "print": { "gcode_state": "RUNNING", "layer_num": 3 } }');
    // Folded, not mangled: the document still says what it said
    assert.deepEqual(JSON.parse(body), JSON.parse(report));
});

test("two spaces inside a value survive the fold", async () => {
    const file = tmpFile(`JOBNAME${TRACE_SUFFIX}`);

    // Which is why only the run that follows a line break is folded. A raw line
    // break cannot appear inside a JSON string, so matching it is what makes the
    // fold safe without parsing; collapsing runs of spaces on their own would
    // quietly rewrite a job name.
    appendTrace(file, '{"print":{"subtask_name":"two  spaces.3mf"}}');
    await settle(file);

    assert.ok(readLines(file)[0].includes('"two  spaces.3mf"'));
});

test("the trace is written whatever the log level says", async () => {
    const file = tmpFile(`SILENT${TRACE_SUFFIX}`);

    await withSettings({ LOG_LEVEL: "errors" }, async () => {
        appendTrace(file, '{"print":{}}');
        await settle(file);
    });

    // It is its own file with its own switch: turning the log down must not
    // silently stop a capture somebody started to analyse a problem
    assert.equal(readLines(file).length, 1);
});

test("a set accepts an array, a comma separated string and drops what it does not know", () => {
    assert.deepEqual(coerceSetting("LOG_CATEGORIES", ["mqtt", "ams"]).value, ["mqtt", "ams"]);
    assert.deepEqual(coerceSetting("LOG_CATEGORIES", "mqtt, SPOOLMAN").value, ["mqtt", "spoolman"]);
    assert.deepEqual(coerceSetting("LOG_CATEGORIES", ["mqtt", "mqtt"]).value, ["mqtt"]);
    // An entry a later version removed must not make the whole value unreadable
    assert.deepEqual(coerceSetting("LOG_CATEGORIES", ["mqtt", "telepathy"]).value, ["mqtt"]);
    // Nothing selected is a legitimate answer, not an error
    assert.deepEqual(coerceSetting("LOG_CATEGORIES", []).value, []);
});

test("the level is refused rather than guessed when it is not one of the four", () => {
    assert.ok(coerceSetting("LOG_LEVEL", "loud").error);
    assert.equal(coerceSetting("LOG_LEVEL", "TRACE").value, "trace");
});

test("a stored DEBUG switch becomes the debug level", () => {
    assert.equal(migrateStored({ DEBUG: true }, 1).LOG_LEVEL, "debug");
    assert.equal(migrateStored({ DEBUG: "true" }, 0).LOG_LEVEL, "debug");
    // The key itself is gone, or resolveSettings would report an unknown setting
    assert.equal("DEBUG" in migrateStored({ DEBUG: true }, 1), false);
});

test("a stored DEBUG of false does not make the file own the level", () => {
    // false was the default, and writing "normal" would turn a setting the user
    // never saved into one the settings file owns from then on
    const migrated = migrateStored({ DEBUG: false }, 1);
    assert.equal("DEBUG" in migrated, false);
    assert.equal(migrated.LOG_LEVEL, undefined);
});

test("a level already stored wins over the old switch", () => {
    const migrated = migrateStored({ DEBUG: true, LOG_LEVEL: "errors" }, 1);
    assert.equal(migrated.LOG_LEVEL, "errors");
});
