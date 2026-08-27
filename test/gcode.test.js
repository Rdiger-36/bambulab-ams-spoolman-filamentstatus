import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
    parseSliceInfo,
    calcFullConsumption,
    calcPartialConsumption,
    normColor,
    consumptionKey,
} from "../src/gcode.js";

const fixture = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "slice_info.config"),
    "utf-8"
);

// The fixture is a two-material print: PLA on layers 0-89, PETG on 90-119.
const sliceInfo = parseSliceInfo(fixture);

const PLA_KEY  = "GFA00|00AE42";
const PETG_KEY = "GFG00|1A1A1A";

test("normColor strips the leading # and any alpha byte", () => {
    assert.equal(normColor("#00AE42"), "00AE42");   // slice format
    assert.equal(normColor("00ae42ff"), "00AE42");  // AMS format
    assert.equal(normColor(null), "");
});

test("consumptionKey combines profile and colour", () => {
    // Same profile, different colour must not collapse into one key
    assert.notEqual(consumptionKey("GFA00", "#000000"), consumptionKey("GFA00", "#FFFFFF"));
    assert.equal(consumptionKey(null, "#00AE42"), "?|00AE42");
});

test("parseSliceInfo reads filaments with their non-contiguous ids", () => {
    assert.equal(sliceInfo.filaments.length, 2);

    const [pla, petg] = sliceInfo.filaments;
    assert.deepEqual(pla,  { id: 1, index: 0, tray_info_idx: "GFA00", type: "PLA",  color: "#00AE42", used_m: 7.32, used_g: 21.83 });
    // id 3 -> index 2: ids are 1-based and may skip numbers
    assert.deepEqual(petg, { id: 3, index: 2, tray_info_idx: "GFG00", type: "PETG", color: "#1A1A1A", used_m: 3.11, used_g: 9.42 });
});

test("parseSliceInfo reads layer ranges and the total layer count", () => {
    assert.equal(sliceInfo.totalLayers, 119);
    assert.deepEqual(sliceInfo.rangesByFilamentIdx[0], [[0, 89]]);
    assert.deepEqual(sliceInfo.rangesByFilamentIdx[2], [[90, 119]]);
});

test("calcFullConsumption sums grams per profile and colour", () => {
    const full = calcFullConsumption(sliceInfo);
    assert.equal(full[PLA_KEY].grams, 21.83);
    assert.equal(full[PETG_KEY].grams, 9.42);
    assert.equal(full[PLA_KEY].type, "PLA");
});

test("calcPartialConsumption scales each filament by its own printed layers", () => {
    // Layer 44 completed: 45 of the PLA's 90 layers, none of the PETG's
    const part = calcPartialConsumption(sliceInfo, 44);
    assert.equal(part[PLA_KEY].grams, 10.92); // 21.83 * 0.5, rounded to 2 decimals
    assert.equal(part[PETG_KEY].grams, 0);
});

test("calcPartialConsumption at the last layer matches the full consumption", () => {
    const part = calcPartialConsumption(sliceInfo, 119);
    const full = calcFullConsumption(sliceInfo);
    assert.deepEqual(part, full);
});

test("calcPartialConsumption falls back to overall progress without layer data", () => {
    const noRanges = { ...sliceInfo, rangesByFilamentIdx: {} };
    const part = calcPartialConsumption(noRanges, 59);
    // 60 of 120 layers -> half of every filament
    assert.equal(part[PLA_KEY].grams, 10.92);
    assert.equal(part[PETG_KEY].grams, 4.71);
});
