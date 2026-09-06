import test from "node:test";
import assert from "node:assert/strict";

import { colorSetDistance, spoolFitsSlot, spoolIsChipless, uniqueSpoolForSlot } from "../public/match.js";

const slot = (over = {}) => ({ tray_info_idx: "GFL99", tray_type: "PLA", tray_color: "0EE2A0FF", cols: ["0EE2A0FF"], ...over });
const spool = (id, over = {}) => ({
    id,
    archived: false,
    extra: {},
    filament: { material: "PLA", color_hex: "0EE2A0", name: `spool ${id}` },
    ...over,
});
const withFilament = (id, filament, over = {}) => spool(id, { filament: { material: "PLA", color_hex: "0EE2A0", ...filament }, ...over });

/* ---- colorSetDistance ---- */

test("the same colours are no distance apart, a missing side is infinitely far", () => {
    assert.equal(colorSetDistance(["0ee2a0"], ["0ee2a0"]), 0);
    assert.equal(colorSetDistance(["0ee2a0"], []), Infinity);
    assert.equal(colorSetDistance([], []), Infinity);
});

test("a two colour spool is not identical to one of its colours alone", () => {
    assert.ok(colorSetDistance(["0ee2a0", "000000"], ["0ee2a0"]) > 0);
    assert.equal(colorSetDistance(["0ee2a0", "000000"], ["000000", "0ee2a0"]), 0);
});

/* ---- spoolFitsSlot ---- */

test("a spool fits on material family and identical colour", () => {
    assert.equal(spoolFitsSlot(slot(), spool(1)), true);
    // "PLA Silk" is PLA, the way the picker ranks it
    assert.equal(spoolFitsSlot(slot(), withFilament(2, { material: "PLA Silk" })), true);
});

test("a close shade or another material does not fit", () => {
    assert.equal(spoolFitsSlot(slot(), withFilament(3, { color_hex: "0EE2A1" })), false);
    assert.equal(spoolFitsSlot(slot(), withFilament(4, { material: "PETG" })), false);
    assert.equal(spoolFitsSlot(slot({ tray_type: "", tray_info_idx: "" }), spool(5)), false);
});

test("a chipless slot set to a Bambu preset fits on the material the preset prints", () => {
    // GFA00 is Bambu PLA Basic; a P2S reports it for a chipless spool whose
    // slot was set to that preset, with the tag all zeros
    assert.equal(spoolFitsSlot(slot({ tray_info_idx: "GFA00" }), spool(6)), true);
});

/* ---- spoolIsChipless ---- */

test("a tagged or archived spool is never the chipless one", () => {
    assert.equal(spoolIsChipless(spool(1)), true);
    assert.equal(spoolIsChipless(spool(2, { extra: { tag: '"83362CE8"' } })), false);
    assert.equal(spoolIsChipless(spool(3, { archived: true })), false);
});

/* ---- uniqueSpoolForSlot ---- */

test("exactly one fitting spool is the answer", () => {
    const spools = [spool(1), withFilament(2, { material: "PETG" }), withFilament(3, { color_hex: "000000" })];
    assert.equal(uniqueSpoolForSlot(slot(), spools)?.id, 1);
});

test("two fitting spools are nobody's answer, the printer cannot tell them apart", () => {
    assert.equal(uniqueSpoolForSlot(slot(), [spool(1), spool(2)]), null);
});

test("a tagged twin does not count, a twin assigned to another slot does not count", () => {
    assert.equal(uniqueSpoolForSlot(slot(), [spool(1), spool(2, { extra: { tag: '"B3B31439"' } })])?.id, 1);
    assert.equal(uniqueSpoolForSlot(slot(), [spool(1), spool(2)], new Set([2]))?.id, 1);
    assert.equal(uniqueSpoolForSlot(slot(), [spool(1)], new Set([1])), null);
});

test("no spools, or none fitting, is no answer", () => {
    assert.equal(uniqueSpoolForSlot(slot(), []), null);
    assert.equal(uniqueSpoolForSlot(slot(), [withFilament(1, { material: "ABS" })]), null);
});
