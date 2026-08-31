import test from "node:test";
import assert from "node:assert/strict";

import { correctRemainInt, haveSpoolDataChanged, slotIsOccupied, extractComparableTrayData } from "../src/ams.js";

test("correctRemainInt passes through a full-size spool unchanged", () => {
    assert.equal(correctRemainInt(63, 1000, "PLA"), 63);
});

test("correctRemainInt rescales a sub-1kg spool from the 1kg basis", () => {
    // The AMS reports 25% of 1000g = 250g left, which is all of a 250g spool
    assert.equal(correctRemainInt(25, 250, "PLA"), 100);
    // 10% of 1000g = 100g left on a 500g spool -> 20%
    assert.equal(correctRemainInt(10, 500, "PLA"), 20);
});

test("correctRemainInt leaves support material alone", () => {
    // Support material is already measured against its real spool size, so
    // rescaling it would report far more than is actually left.
    assert.equal(correctRemainInt(40, 250, "PLA-S"), 40);
});

test("correctRemainInt clamps the rescaled value to 100%", () => {
    assert.equal(correctRemainInt(90, 250, "PLA"), 100);
});

const spool = (id, tag, remaining) => ({
    id,
    extra: { tag: `"${tag}"` },
    remaining_weight: remaining,
    used_weight: 1000 - remaining,
    filament: { id, name: "Black", material: "PLA" },
});

test("haveSpoolDataChanged treats an unseeded baseline as changed", async () => {
    assert.equal(await haveSpoolDataChanged([spool(1, "AAA", 800)], null), true);
});

test("haveSpoolDataChanged detects the first spool on a previously empty Spoolman", async () => {
    // The fresh-install case: the baseline is genuinely empty and the first
    // created spool has to register as a change.
    assert.equal(await haveSpoolDataChanged([spool(1, "AAA", 800)], []), true);
});

test("haveSpoolDataChanged ignores the order of the Spoolman response", async () => {
    const a = spool(1, "AAA", 800);
    const b = spool(2, "BBB", 500);
    assert.equal(await haveSpoolDataChanged([a, b], [b, a]), false);
});

test("haveSpoolDataChanged detects a changed remaining weight", async () => {
    assert.equal(await haveSpoolDataChanged([spool(1, "AAA", 700)], [spool(1, "AAA", 800)]), true);
});

// Real tray payloads observed on a P2S with two AMS units: a Bambu Lab spool,
// two 3rd party spools the printer cannot identify, and an empty slot. Only
// `state` tells the last three apart.
const bambuTray = { state: 11, tray_type: "PLA", tray_sub_brands: "PLA Basic", tray_color: "000000FF", tray_weight: "1000", tray_uuid: "18F1DE9B" };
const thirdParty10 = { id: "2", state: 10, remain: 0, tray_color: "N/A", tray_sub_brands: "N/A", tray_weight: 0, tray_uuid: "N/A" };
const thirdParty20 = { id: "2", state: 20, remain: 0, tray_color: "N/A", tray_sub_brands: "N/A", tray_weight: 0, tray_uuid: "N/A" };
const emptyTray = { id: "0", state: 0, remain: 0, tray_color: "N/A", tray_sub_brands: "N/A", tray_weight: 0, tray_uuid: "N/A" };

test("slotIsOccupied separates an unidentified spool from an empty slot", () => {
    assert.equal(slotIsOccupied(emptyTray), false);
    assert.equal(slotIsOccupied(thirdParty10), true);
    assert.equal(slotIsOccupied(thirdParty20), true);
    assert.equal(slotIsOccupied(bambuTray), true);
});

test("slotIsOccupied treats a missing state as not occupied", () => {
    // Rather than inventing spools on firmware that does not report the field
    assert.equal(slotIsOccupied({ tray_uuid: "N/A" }), false);
    assert.equal(slotIsOccupied({ state: null }), false);
    assert.equal(slotIsOccupied(undefined), false);
});

test("slotIsOccupied reads a state sent as a string", () => {
    assert.equal(slotIsOccupied({ state: "0" }), false);
    assert.equal(slotIsOccupied({ state: "10" }), true);
});

test("extractComparableTrayData notices a 3rd party spool arriving", () => {
    const before = [{ id: "0", tray: [{ ...emptyTray, id: "1" }] }];
    const after  = [{ id: "0", tray: [{ ...thirdParty10, id: "1" }] }];
    assert.notDeepEqual(extractComparableTrayData(before), extractComparableTrayData(after));
});

test("extractComparableTrayData ignores the state value of an unidentified spool", () => {
    // 10 and 20 both mean "loaded but unknown"; flipping between them must not
    // look like a change and trigger a reprocess.
    const a = [{ id: "0", tray: [{ ...thirdParty10, id: "1" }] }];
    const b = [{ id: "0", tray: [{ ...thirdParty20, id: "1" }] }];
    assert.deepEqual(extractComparableTrayData(a), extractComparableTrayData(b));
});

test("extractComparableTrayData still tracks identified spools by their data", () => {
    const a = [{ id: "0", tray: [{ ...bambuTray, id: "0", remain: 50 }] }];
    const b = [{ id: "0", tray: [{ ...bambuTray, id: "0", remain: 40 }] }];
    assert.notDeepEqual(extractComparableTrayData(a), extractComparableTrayData(b));

    const same = [{ id: "0", tray: [{ ...bambuTray, id: "0", remain: 50 }] }];
    assert.deepEqual(extractComparableTrayData(a), extractComparableTrayData(same));
});
