import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    normColor,
    slotColors,
    filamentColors,
    correctRemainInt,
    spoolWeightLimit,
} from "../public/shared.js";

import * as utils from "../src/utils.js";
import * as gcode from "../src/gcode.js";
import * as ams from "../src/ams.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ---- normColor ---- */

test("normColor strips the leading # and any alpha byte", () => {
    assert.equal(normColor("#00AE42"), "00AE42");   // slice format
    assert.equal(normColor("00ae42ff"), "00AE42");  // AMS format
});

test("normColor turns every absent colour into the same empty string", () => {
    assert.equal(normColor(null), "");
    assert.equal(normColor(undefined), "");
    assert.equal(normColor(""), "");
});

/* ---- slotColors ---- */

test("slotColors reads the whole set from cols, in the printer's order", () => {
    assert.deepEqual(
        slotColors({ cols: ["8EC9E9FF", "E7C1D5FF"], tray_color: "8EC9E9FF" }),
        ["8ec9e9", "e7c1d5"],
    );
});

test("slotColors falls back to tray_color only when cols has nothing", () => {
    assert.deepEqual(slotColors({ cols: [], tray_color: "00AE42FF" }), ["00ae42"]);
    assert.deepEqual(slotColors({ tray_color: "00AE42FF" }), ["00ae42"]);
});

test("slotColors drops the N/A placeholder rather than treating it as a colour", () => {
    // An occupied but unidentified slot reports this, and the dashboard used to
    // build "#N/A" out of it and hand that to CSS as a background.
    assert.deepEqual(slotColors({ cols: [], tray_color: "N/A" }), []);
    assert.deepEqual(slotColors({ cols: ["N/A", "00AE42FF"] }), ["00ae42"]);
});

test("slotColors survives a slot that is not there at all", () => {
    assert.deepEqual(slotColors(null), []);
    assert.deepEqual(slotColors({}), []);
});

/* ---- filamentColors ---- */

test("filamentColors reads a multi colour record as the whole set", () => {
    assert.deepEqual(
        filamentColors({ multi_color_hexes: "8EC9E9,E7C1D5" }),
        ["8ec9e9", "e7c1d5"],
    );
});

test("filamentColors ignores an empty entry from a trailing separator", () => {
    assert.deepEqual(filamentColors({ multi_color_hexes: "8EC9E9,E7C1D5," }), ["8ec9e9", "e7c1d5"]);
});

test("filamentColors reads a single colour record as a set of one", () => {
    assert.deepEqual(filamentColors({ color_hex: "00AE42" }), ["00ae42"]);
    assert.deepEqual(filamentColors({ color_hex: "#00AE42" }), ["00ae42"]);
});

test("filamentColors says nothing about a filament that carries no colour", () => {
    assert.deepEqual(filamentColors({}), []);
    assert.deepEqual(filamentColors(null), []);
});

test("a slot and the filament of its spool compare directly", () => {
    // The point of the two living in one file: both sides lowercase, both drop
    // the alpha byte, so a caller can compare the sorted sets without knowing
    // which side produced which.
    const slot = { cols: ["8EC9E9FF", "E7C1D5FF"] };
    const filament = { multi_color_hexes: "e7c1d5,8ec9e9" };

    assert.deepEqual(
        [...slotColors(slot)].sort(),
        [...filamentColors(filament)].sort(),
    );
});

/* ---- correctRemainInt ---- */

test("correctRemainInt passes a full size spool through unchanged", () => {
    assert.equal(correctRemainInt(63, 1000, "PLA"), 63);
});

test("correctRemainInt rescales a spool smaller than 1kg to its real size", () => {
    // 25% on a 1kg basis is a full 250g spool.
    assert.equal(correctRemainInt(25, 250, "PLA"), 100);
    assert.equal(correctRemainInt(10, 500, "PLA"), 20);
});

test("correctRemainInt leaves support material alone, whatever its size", () => {
    // Support material is measured against its own spool already.
    assert.equal(correctRemainInt(40, 500, "PLA-S"), 40);
});

test("correctRemainInt reports no reading rather than an empty spool", () => {
    // The AMS sends nothing for the first seconds after a spool goes in, and
    // 0% would read as an empty spool on the dashboard.
    assert.equal(correctRemainInt(null, 1000, "PLA"), null);
    assert.equal(correctRemainInt("", 1000, "PLA"), null);
    assert.equal(correctRemainInt("not a number", 1000, "PLA"), null);
});

test("correctRemainInt clamps a reading that scales past the ends", () => {
    assert.equal(correctRemainInt(120, 500, "PLA"), 100);
    assert.equal(correctRemainInt(-5, 500, "PLA"), 0);
});

/* ---- spoolWeightLimit ---- */

test("spoolWeightLimit takes the filament's full weight", () => {
    assert.equal(spoolWeightLimit({ initial_weight: 750, filament: { weight: 1000 } }), 1000);
});

test("spoolWeightLimit takes the spool's own weight when that is the larger one", () => {
    // The spool really did hold this much, so refusing to write it back would
    // be the wrong way round.
    assert.equal(spoolWeightLimit({ initial_weight: 1200, filament: { weight: 1000 } }), 1200);
});

test("spoolWeightLimit falls back to whichever of the two is known", () => {
    assert.equal(spoolWeightLimit({ initial_weight: 500, filament: null }), 500);
    assert.equal(spoolWeightLimit({ filament: { weight: 1000 } }), 1000);
});

test("spoolWeightLimit answers null when nothing says", () => {
    assert.equal(spoolWeightLimit({}), null);
    assert.equal(spoolWeightLimit({ initial_weight: 0, filament: { weight: null } }), null);
    assert.equal(spoolWeightLimit(null), null);
});

/* ---- one implementation, not two ---- */

test("the server re-exports these rather than keeping a copy", () => {
    // Identity, not behaviour: a second implementation that happens to agree
    // today is exactly what this file exists to prevent.
    assert.equal(utils.slotColors, slotColors);
    assert.equal(utils.filamentColors, filamentColors);
    assert.equal(gcode.normColor, normColor);
    assert.equal(ams.correctRemainInt, correctRemainInt);
    assert.equal(utils.spoolWeightLimit, spoolWeightLimit);
});

test("the dashboard imports them rather than keeping a copy", () => {
    // public/ has no module loader in the tests, so this reads the file. The
    // four names below were a second implementation until they were not, and a
    // new one would go unnoticed for as long as the last one did.
    const frontend = fs.readFileSync(path.join(root, "public", "frontend.js"), "utf8");

    assert.match(frontend, /import\s*\{[^}]*\}\s*from\s*"\.\/shared\.js"/);
    for (const gone of ["normColorJS", "slotColorsJS", "filamentColorsJS", "correctRemainIntJS"]) {
        assert.equal(frontend.includes(gone), false, `${gone} is back in public/frontend.js`);
    }
});

// The layer counter of the dashboard, and the off-by-one that reached it.
//
// A P2S printing the 26 layer "Cube" plate showed "Layer 27 / 26" and 104% on
// its last layer: the slice reports the highest layer index (25) while the
// printer reports the layer count (26) once it is done, and one was added to
// both.
test("the layer counter never runs past the end of the print", async () => {
    const { humanLayers } = await import("../public/shared.js");

    // The slice's 25 is a highest index, so the plate has 26 layers.
    assert.deepEqual(humanLayers(0, 25),  { layer: 1,  total: 26, percent: 4 });
    assert.deepEqual(humanLayers(12, 25), { layer: 13, total: 26, percent: 50 });
    assert.deepEqual(humanLayers(25, 25), { layer: 26, total: 26, percent: 100 });

    // What the P2S reports when it has finished: the count, one past the last
    // index. This is the case that produced 27 / 26 and 104%.
    assert.deepEqual(humanLayers(26, 25), { layer: 26, total: 26, percent: 100 });
    // And anything further out, for a printer that counts differently again.
    assert.deepEqual(humanLayers(99, 25), { layer: 26, total: 26, percent: 100 });
});

test("the layer counter copes with either number missing", async () => {
    const { humanLayers } = await import("../public/shared.js");

    // No slice info: the layer is still worth showing, the total is not known.
    assert.deepEqual(humanLayers(3, null), { layer: 4, total: null, percent: null });
    // No report yet, which is what an idle printer looks like.
    assert.deepEqual(humanLayers(null, 25), { layer: 1, total: 26, percent: 4 });
    assert.deepEqual(humanLayers(null, null), { layer: 1, total: null, percent: null });
});

// The clock behind the two counters on the dashboard: how long the print has
// been running, and how long its result still has before it clears itself.
test("a counter reads HH:mm:ss whatever the duration", async () => {
    const { formatCounter } = await import("../public/shared.js");
    const s = 1000, m = 60 * s, h = 60 * m;

    // Padded from the first second, so nothing on the line moves as it counts.
    assert.equal(formatCounter(0), "00:00:00");
    assert.equal(formatCounter(5 * s), "00:00:05");
    assert.equal(formatCounter(90 * s), "00:01:30");
    assert.equal(formatCounter(59 * m + 59 * s), "00:59:59");
    assert.equal(formatCounter(h), "01:00:00");
    assert.equal(formatCounter(5 * h + 13 * m + 44 * s), "05:13:44");

    // A negative deadline is one that has passed, not a count upwards again.
    assert.equal(formatCounter(-5 * s), "00:00:00");
});

test("a print running over days counts the days in front", async () => {
    const { formatCounter } = await import("../public/shared.js");
    const s = 1000, m = 60 * s, h = 60 * m, d = 24 * h;

    // The hours roll into a day rather than growing past 24.
    assert.equal(formatCounter(23 * h + 59 * m + 59 * s), "23:59:59");
    assert.equal(formatCounter(d), "01 Days 00:00:00");
    assert.equal(formatCounter(2 * d + 5 * h + 13 * m + 44 * s), "02 Days 05:13:44");
    // Always "Days": the singular is a character shorter and would move the
    // clock behind it on the second day.
    assert.match(formatCounter(d), /^01 Days /);
    assert.equal(formatCounter(12 * d), "12 Days 00:00:00");
});
