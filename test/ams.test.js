import test from "node:test";
import assert from "node:assert/strict";

import { correctRemainInt, haveSpoolDataChanged, slotIsOccupied, extractComparableTrayData, processData } from "../src/ams.js";

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

// The AMS reports remain -1 for the first 15 to 20 seconds after a spool goes
// in, and permanently for a chipless one. Captured on a P2S: at 11:39:10 the
// slot read `remain=-1 state=27 sub="PLA Matte"`, at 11:39:25 `remain=100`.
test("processData keeps an unreported remain unknown instead of calling it empty", () => {
    const [ams] = processData([{ id: "0", tray: [
        { id: "0", state: 27, remain: -1, tray_type: "PLA", tray_sub_brands: "PLA Matte", tray_color: "FFFFFFFF", tray_weight: "1000", tray_uuid: "A5F4AA83" },
        { id: "1", state: 11, remain: 0,  tray_type: "PLA", tray_sub_brands: "PLA Basic", tray_color: "000000FF", tray_weight: "1000", tray_uuid: "18F1DE9B" },
    ] }]);

    assert.equal(ams.tray[0].remain, null, "-1 means the AMS has not read it yet");
    assert.equal(ams.tray[1].remain, 0, "a real 0 is a reading and has to survive");
});

test("processData does not write the normalised remain back onto the raw slot", () => {
    // The raw value is what the next report is compared against.
    const raw = { id: "0", state: 27, remain: -1, tray_color: "FFFFFFFF", tray_sub_brands: "PLA Matte", tray_weight: "1000", tray_uuid: "A5F4AA83" };
    processData([{ id: "0", tray: [raw] }]);
    assert.equal(raw.remain, -1);
});

test("correctRemainInt reports an unknown remain as null, never as 0", () => {
    assert.equal(correctRemainInt(null, "1000", "PLA"), null);
    assert.equal(correctRemainInt(undefined, "1000", "PLA"), null);
    // A spool created from a null here was booked as fully used and came out
    // at 0 g left, with nothing in G-code mode to correct it afterwards.
    assert.equal(correctRemainInt(0, "1000", "PLA"), 0);
    assert.equal(correctRemainInt(100, "1000", "PLA"), 100);
    assert.equal(correctRemainInt(25, "250", "PLA"), 100);
});

// Real tray payloads captured from a P2S with two AMS 2 Pro units. A loaded
// slot always carries the full record, whether the chip was read or not; an
// empty slot carries `id` and `state` and nothing else. `state` separates
// nothing: 9 and 10 appear on empty slots, 11 and 27 on loaded ones.
const bambuTray = { id: "0", state: 11, cols: ["000000FF"], tag_uid: "55650E0F00000100", tray_diameter: "1.75", tray_info_idx: "GFA00", tray_type: "PLA", tray_sub_brands: "PLA Basic", tray_color: "000000FF", tray_weight: "1000", tray_uuid: "18F1DE9B", remain: 27 };
const thirdParty = { id: "0", state: 11, cols: ["0ACC38FF"], tag_uid: "0000000000000000", tray_diameter: "1.75", tray_info_idx: "GFL99", tray_type: "PLA", tray_sub_brands: "N/A", tray_color: "0ACC38FF", tray_weight: "0", tray_uuid: "N/A", remain: 0 };
const emptyTray = { id: "1", state: 10, remain: 0, tray_color: "N/A", tray_sub_brands: "N/A", tray_weight: 0, tray_uuid: "N/A" };

test("slotIsOccupied separates an unidentified spool from an empty slot", () => {
    assert.equal(slotIsOccupied(emptyTray), false);
    assert.equal(slotIsOccupied(thirdParty), true);
    assert.equal(slotIsOccupied(bambuTray), true);
});

test("slotIsOccupied ignores state", () => {
    // The empty slot reports state 10 and the loaded ones report 11, so reading
    // "non zero means occupied" made every empty slot look like a 3rd party
    // spool. Flipping the value must change nothing in either direction.
    assert.equal(slotIsOccupied({ ...emptyTray, state: 0 }), false);
    assert.equal(slotIsOccupied({ ...emptyTray, state: 27 }), false);
    assert.equal(slotIsOccupied({ ...thirdParty, state: 0 }), true);
});

test("slotIsOccupied handles a missing slot", () => {
    assert.equal(slotIsOccupied(undefined), false);
    assert.equal(slotIsOccupied(null), false);
});

test("extractComparableTrayData notices a 3rd party spool arriving", () => {
    const before = [{ id: "0", tray: [{ ...emptyTray, id: "1" }] }];
    const after  = [{ id: "0", tray: [{ ...thirdParty, id: "1" }] }];
    assert.notDeepEqual(extractComparableTrayData(before), extractComparableTrayData(after));
});

test("extractComparableTrayData notices a 3rd party spool being removed", () => {
    const before = [{ id: "0", tray: [{ ...thirdParty, id: "1" }] }];
    const after  = [{ id: "0", tray: [{ ...emptyTray, id: "1" }] }];
    assert.notDeepEqual(extractComparableTrayData(before), extractComparableTrayData(after));
});

test("extractComparableTrayData notices material and colour set on the printer", () => {
    // The AMS keeps the slot unidentified, so only the fields the user set on
    // the printer change. Comparing occupancy alone hid this completely.
    const before = [{ id: "0", tray: [{ ...thirdParty, tray_type: "", tray_info_idx: "", tray_color: "N/A" }] }];
    const after  = [{ id: "0", tray: [thirdParty] }];
    assert.notDeepEqual(extractComparableTrayData(before), extractComparableTrayData(after));
});

test("extractComparableTrayData notices one chipless spool swapped for another", () => {
    const before = [{ id: "0", tray: [thirdParty] }];
    const after  = [{ id: "0", tray: [{ ...thirdParty, cols: ["F98C36FF"], tray_color: "F98C36FF" }] }];
    assert.notDeepEqual(extractComparableTrayData(before), extractComparableTrayData(after));
});

test("extractComparableTrayData ignores the state value of an unidentified spool", () => {
    // It varies between reports about the same unchanged slot, so comparing it
    // would trigger a reprocess on nothing.
    const a = [{ id: "0", tray: [{ ...thirdParty, state: 10 }] }];
    const b = [{ id: "0", tray: [{ ...thirdParty, state: 20 }] }];
    assert.deepEqual(extractComparableTrayData(a), extractComparableTrayData(b));
});

test("extractComparableTrayData still tracks identified spools by their data", () => {
    const a = [{ id: "0", tray: [{ ...bambuTray, id: "0", remain: 50 }] }];
    const b = [{ id: "0", tray: [{ ...bambuTray, id: "0", remain: 40 }] }];
    assert.notDeepEqual(extractComparableTrayData(a), extractComparableTrayData(b));

    const same = [{ id: "0", tray: [{ ...bambuTray, id: "0", remain: 50 }] }];
    assert.deepEqual(extractComparableTrayData(a), extractComparableTrayData(same));
});
