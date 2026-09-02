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
