import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
    parseSliceInfo,
    calcFullConsumption,
    calcPartialConsumption,
    resolveSliceSlots,
    orderedAmsSlots,
    decodePrintMapping,
} from "../src/gcode.js";
import { matchConsumption, consumptionCandidate } from "../src/ams.js";

// A real print off a dual nozzle H2C, sliced in Bambu Studio 02.07.01.62:
// two AMS units, an AMS HT and a spool on the external holder, four filaments
// spread over all four of those places. It answers a question none of the
// single nozzle fixtures could: on a printer with two extruders the slicer
// orders its filament list by extruder group, not by AMS unit, so the position
// in that list is not the slot. Here position 0 is the AMS HT and position 1
// the external holder, while the two AMS units come last.
//
// That is the case `orderedAmsSlots` cannot estimate, and the print still lands
// on the right slots: every position it names is refused by `slotConfirmsSlice`
// because the slot holds something else, and the identity stages below it
// decide. The tests below hold that end to end, for the printer that reports
// `print.mapping` and for the one that does not.

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "h2c_dual_nozzle.config");
const h2c = parseSliceInfo(fs.readFileSync(fixturePath, "utf-8"));

/** One loaded slot, in the shape `consumptionCandidate()` reads. */
const slot = (amsId, idx, type, color, { id = null, tag = false } = {}) => ({
    amsId,
    slotState: "Loaded (Bambu Lab)",
    connectedViaTag: tag,
    connectedViaMapping: false,
    existingSpool: id ? { id } : null,
    slot: { tray_type: type, tray_info_idx: idx, tray_color: color, cols: [color], tray_weight: "1000", remain: 50 },
});

// What the printer of this print reports: ten slots, six of which have nothing
// to do with the job. Two 3rd party spools without a usable profile, a PETG in
// A2, and three PLA Basic spools in the B unit that share the GFA00 profile
// with two of the sliced filaments and differ from them only in colour.
const loadedSlots = () => [
    slot("A0", "GFL99", "PLA", "C8B48CFF"),
    slot("A1", "GFL99", "PLA", "FFFFFFFF"),
    slot("A2", "GFG01", "PETG", "FFFFFFFF", { id: 9, tag: true }),
    slot("A3", "GFA00", "PLA", "C12E1FFF", { id: 6, tag: true }),
    slot("B0", "GFA00", "PLA", "9D432CFF", { id: 5, tag: true }),
    slot("B1", "GFA00", "PLA", "8E9089FF", { id: 14, tag: true }),
    slot("B2", "GFA00", "PLA", "000000FF", { id: 1, tag: true }),
    slot("B3", "GFG99", "PETG", "FFFFFFFF"),
    slot("HT-A", "GFA01", "PLA", "9B9EA0FF", { id: 15, tag: true }),
    slot("External", "GFU99", "TPU", "898989FF"),
];

/** The slot every sliced filament ends up matched to, in slicer list order. */
function matchedSlots(consumption, slots, reportedByPrinter, spools = loadedSlots()) {
    const entries = Object.values(resolveSliceSlots(consumption, slots, { reportedByPrinter }));
    const matched = matchConsumption(entries, spools.map(consumptionCandidate));
    return entries.map(entry => matched.get(entry)?.[0]?.amsId ?? null);
}

test("the four filaments of the H2C print are read with their grams", () => {
    assert.equal(h2c.filaments.length, 4);
    assert.deepEqual(h2c.filaments.map(f => f.tray_info_idx), ["GFA01", "GFU99", "GFA00", "GFA00"]);
    assert.deepEqual(h2c.filaments.map(f => f.color), ["#9B9EA0", "#898989", "#000000", "#C12E1F"]);
    assert.deepEqual(h2c.filaments.map(f => f.used_g), [22.09, 20.56, 20.93, 20.85]);
    assert.equal(h2c.totalLayers, 164);
});

test("on two extruders the list order is not the slot order", () => {
    // The estimate for a ten slot printer starts at A0, and the print takes
    // nothing from A0, A1 or A2 at all. Position 3 lands on A3 by coincidence.
    // The slicer listed these four as HT-A, the holder, B2 and A3.
    assert.deepEqual(
        orderedAmsSlots(loadedSlots().map(s => s.amsId)),
        ["A0", "A1", "A2", "A3", "B0", "B1", "B2", "B3", "External", "HT-A"],
    );
});

test("the print is matched to its real slots without print.mapping", () => {
    // The reproduction of the dashboard: 22.09 g on the AMS HT, 20.56 g on the
    // holder, 20.93 g on B2 and 20.85 g on A3. Three of the four positions the
    // list order estimated are refused, and profile plus colour place them.
    const slots = orderedAmsSlots(loadedSlots().map(s => s.amsId));
    assert.deepEqual(
        matchedSlots(calcFullConsumption(h2c), slots, false),
        ["HT-A", "External", "B2", "A3"],
    );
});

test("the same answer when the printer reports the slots itself", () => {
    // 0x8000 is HT-A, 0xFF00 the external holder, 0x0102 is B2 and 0x0003 A3.
    const slots = decodePrintMapping([0x8000, 0xFF00, 0x0102, 0x0003]);
    assert.deepEqual(slots, ["HT-A", "External", "B2", "A3"]);
    assert.deepEqual(matchedSlots(calcFullConsumption(h2c), slots, true), ["HT-A", "External", "B2", "A3"]);
});

test("the external holder takes an amount even though nothing is linked to it", () => {
    // The TPU sits on the holder as a 3rd party spool with no Spoolman spool
    // behind it, which is what the print in the screenshot looked like. The
    // dashboard still has to show what the print needs from that slot; whether
    // it can be booked is a separate question the route answers elsewhere.
    const slots = orderedAmsSlots(loadedSlots().map(s => s.amsId));
    const entries = Object.values(resolveSliceSlots(calcFullConsumption(h2c), slots, { reportedByPrinter: false }));
    const matched = matchConsumption(entries, loadedSlots().map(consumptionCandidate));

    const tpu = entries.find(e => e.tray_info_idx === "GFU99");
    assert.equal(matched.get(tpu)?.[0]?.amsId, "External");
    assert.equal(matched.get(tpu)?.[0]?.id, null);
});

test("a cancelled print splits the same way", () => {
    // All four filaments span all 165 layers, so 82 of them is just under half
    // of every filament, and it still lands on the same four slots.
    const slots = orderedAmsSlots(loadedSlots().map(s => s.amsId));
    const partial = calcPartialConsumption(h2c, 81);

    assert.deepEqual(Object.values(partial).map(e => e.grams), [10.98, 10.22, 10.4, 10.36]);
    assert.deepEqual(matchedSlots(partial, slots, false), ["HT-A", "External", "B2", "A3"]);
});

test("two identical spools are told apart only by what the printer reports", () => {
    // The limit of the estimate on this printer. With a second Matte Ash Gray
    // spool in A0 the position the list order named for filament 0 does hold
    // the sliced profile and colour, so it confirms, and the amount goes to A0
    // rather than to the AMS HT the print really runs from. Nothing in the
    // sliced file can separate the two.
    const duplicate = [...loadedSlots(), slot("A0", "GFA01", "PLA", "9B9EA0FF", { id: 77, tag: true })]
        .filter((s, i, all) => all.findLastIndex(o => o.amsId === s.amsId) === i);

    const slots = orderedAmsSlots(duplicate.map(s => s.amsId));
    assert.deepEqual(matchedSlots(calcFullConsumption(h2c), slots, false, duplicate)[0], "A0");

    // `print.mapping` is the answer to that, and the printer is trusted where
    // it speaks.
    const reported = decodePrintMapping([0x8000, 0xFF00, 0x0102, 0x0003]);
    assert.deepEqual(matchedSlots(calcFullConsumption(h2c), reported, true, duplicate)[0], "HT-A");
});
