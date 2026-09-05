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
// Only the total is corrected. The slice reports the highest layer index (25 for
// a 26 layer plate) while `layer_num` off the wire is already a count, and
// adding one to that put the dashboard a layer ahead of the printer's own
// display and of Bambu Studio for the whole print.
test("the layer counter reads the way the printer and the slicer count", async () => {
    const { humanLayers } = await import("../public/shared.js");

    // The slice's 25 is a highest index, so the plate has 26 layers.
    // layer_num is shown as it stands: nothing printed yet is 0 of 26.
    assert.deepEqual(humanLayers(0, 25),  { layer: 0,  total: 26, percent: 0 });
    assert.deepEqual(humanLayers(13, 25), { layer: 13, total: 26, percent: 50 });
    assert.deepEqual(humanLayers(26, 25), { layer: 26, total: 26, percent: 100 });

    // Measured on a P2S across a whole print: on a 15 layer plate, whose slice
    // reports 14 as its highest index, layer_num ran 0 to 15 and stayed at 15
    // through FINISH. It reaches the count, which no 0-based index could.
    assert.deepEqual(humanLayers(0, 14),  { layer: 0,  total: 15, percent: 0 });
    assert.deepEqual(humanLayers(15, 14), { layer: 15, total: 15, percent: 100 });
});

test("the layer counter never runs past the end of the print", async () => {
    const { humanLayers } = await import("../public/shared.js");

    // A printer that counts differently again must not produce "27 / 26" and
    // 104%, which is what an earlier version did on its last layer.
    assert.deepEqual(humanLayers(27, 25), { layer: 26, total: 26, percent: 100 });
    assert.deepEqual(humanLayers(99, 25), { layer: 26, total: 26, percent: 100 });
});

test("the layer counter copes with either number missing", async () => {
    const { humanLayers } = await import("../public/shared.js");

    // No slice info: the layer is still worth showing, the total is not known.
    assert.deepEqual(humanLayers(3, null), { layer: 3, total: null, percent: null });
    // No report yet, which is what an idle printer looks like.
    assert.deepEqual(humanLayers(null, 25), { layer: 0, total: 26, percent: 0 });
    assert.deepEqual(humanLayers(null, null), { layer: 0, total: null, percent: null });
});

// The clock behind the two counters on the dashboard: how long the print has
// been running, and how long its result still has before it clears itself.
// Three shapes, because a print is anything from a ten minute plate to a five
// day one and no single one reads well across that.
test("a duration under an hour is minutes and seconds", async () => {
    const { formatCounter } = await import("../public/shared.js");
    const s = 1000, m = 60 * s;

    assert.equal(formatCounter(0), "00:00");
    assert.equal(formatCounter(5 * s), "00:05");
    assert.equal(formatCounter(90 * s), "01:30");
    assert.equal(formatCounter(59 * m + 59 * s), "59:59");

    // A deadline that has passed, not a count upwards again.
    assert.equal(formatCounter(-5 * s), "00:00");
});

test("an hour brings the hours in, a day drops the seconds", async () => {
    const { formatCounter } = await import("../public/shared.js");
    const s = 1000, m = 60 * s, h = 60 * m, d = 24 * h;

    assert.equal(formatCounter(h), "01:00:00");
    assert.equal(formatCounter(5 * h + 13 * m + 44 * s), "05:13:44");
    assert.equal(formatCounter(23 * h + 59 * m + 59 * s), "23:59:59");

    // At this length the seconds are noise, so they go.
    assert.equal(formatCounter(d), "1 Days 00:00");
    assert.equal(formatCounter(2 * d + 5 * h + 13 * m + 44 * s), "2 Days 05:13");
    // Days are not padded, unlike everything behind them.
    assert.equal(formatCounter(12 * d + 7 * h), "12 Days 07:00");
});

test("both ends of a print are written the same way", async () => {
    const { allToday, formatMoment } = await import("../public/shared.js");

    const today = new Date();
    today.setHours(13, 4, 17, 0);
    const alsoToday = new Date(today);
    alsoToday.setHours(17, 49, 3, 0);
    const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);

    assert.equal(allToday(today.getTime(), alsoToday.getTime()), true);
    assert.equal(allToday(yesterday.getTime(), today.getTime()), false);
    // A start lost to a restart is not "today", so the pair takes the long form.
    assert.equal(allToday(null, today.getTime()), false);
    assert.equal(allToday(), true);

    // The time alone while it all happens today, the full date once it does not.
    assert.equal(formatMoment(today.getTime(), false), "13:04");
    assert.match(formatMoment(today.getTime(), true), /^\d{2}\.\d{2}\.\d{4} 13:04:17$/);
});

// The time a print has left. The printer reports whole minutes and revises them
// as it goes, so this one is deliberately not the clock shape the counters use:
// "03:00 left" claimed a second hand the number does not have.
test("the remaining time is stated at the precision the printer has", async () => {
    const { formatRemaining } = await import("../public/shared.js");

    assert.equal(formatRemaining(3), "~ 3 min");
    assert.equal(formatRemaining(59), "~ 59 min");
    assert.equal(formatRemaining(90), "~ 1 hour 30 min");
    assert.equal(formatRemaining(270), "~ 4 hours 30 min");
    assert.equal(formatRemaining(8910), "~ 6 Days 4 hours 30 min");

    // Nothing larger to carry it, so the minutes stay; something larger and
    // exact, so they go rather than reading "4 hours 0 min".
    assert.equal(formatRemaining(60), "~ 1 hour");
    assert.equal(formatRemaining(1440), "~ 1 Day");
    assert.equal(formatRemaining(1470), "~ 1 Day 30 min");

    // The printer sends 0 for the last stretch, and "~ 0 min" reads like a
    // stopped clock.
    assert.equal(formatRemaining(0), "< 1 min");
    assert.equal(formatRemaining(null), null);
    assert.equal(formatRemaining(undefined), null);
});
