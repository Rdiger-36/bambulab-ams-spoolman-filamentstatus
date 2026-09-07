import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
    parseSliceInfo,
    calcFullConsumption,
    resolveSliceSlots,
    orderedAmsSlots,
} from "../src/gcode.js";
import { matchConsumption, consumptionCandidate } from "../src/ams.js";
import { loadedSlotIds } from "../src/uispool.js";

// The print that settled what an empty AMS slot does to the slicer's filament
// list. A P2S with two AMS units and a spool on the external holder was emptied
// at A3 and at B2 on purpose, synchronised in Bambu Studio 02.08.02.61, and
// sliced. Seven slots hold something and the project carries seven filaments,
// so a gap takes no position at all and everything after it moves up.
//
// The printer was read out over MQTT at the same time, which is where the slot
// contents below come from:
//
//   pos 0  A1        GFA00 PLA Basic  #F55A74
//   pos 1  A2        GFA06 PLA Silk+  #C8C8C8
//   pos 2  A4        GFA00 PLA Basic  #000000     A3 is empty and absent
//   pos 3  B1        GFA00 PLA Basic  #F7E6DE
//   pos 4  B3        GFB00 ABS        #000000     B2 is empty and absent
//   pos 5  B4        GFG02 PETG HF    #000000
//   pos 6  External  GFL99 PLA        #FFF144
//
// Counting all four slots of every attached unit, which is what this service
// did before, put the two gaps back in and pushed the last three filaments one
// and then two positions to the right.

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "p2s_empty_slots.config");
const p2s = parseSliceInfo(fs.readFileSync(fixturePath, "utf-8"));

/** One loaded slot, in the shape `consumptionCandidate()` reads. */
const slot = (amsId, idx, type, color, id) => ({
    amsId,
    slotState: "Loaded (Bambu Lab)",
    connectedViaTag: true,
    connectedViaMapping: false,
    existingSpool: { id },
    slot: { tray_type: type, tray_info_idx: idx, tray_color: color, cols: [color], tray_weight: "1000", remain: 50 },
});

/** An AMS slot the printer reports with nothing in it. */
const empty = (amsId) => ({
    amsId, slotState: "Empty", connectedViaTag: false, connectedViaMapping: false, existingSpool: null, slot: {},
});

/** What the printer reports, slot for slot, with the two gaps in the middle. */
const printerSlots = () => [
    slot("A1", "GFA00", "PLA", "F55A74FF", 1),
    slot("A2", "GFA06", "PLA", "C8C8C8FF", 2),
    empty("A3"),
    slot("A4", "GFA00", "PLA", "000000FF", 3),
    slot("B1", "GFA00", "PLA", "F7E6DEFF", 4),
    empty("B2"),
    slot("B3", "GFB00", "ABS", "000000FF", 5),
    slot("B4", "GFG02", "PETG", "000000FF", 6),
    slot("External", "GFL99", "PLA", "FFF144FF", 7),
];

test("an empty slot takes no position", () => {
    // Seven loaded slots, and the project the printer was synchronised into
    // carries seven filaments. The gaps at A3 and B2 are simply not there.
    assert.deepEqual(
        orderedAmsSlots(loadedSlotIds(printerSlots())),
        ["A1", "A2", "A4", "B1", "B3", "B4", "External"],
    );
});

test("the plate's four filaments sit at the positions the gaps left them", () => {
    // Ids 2, 5, 6 and 7, so the positions 1, 4, 5 and 6, and every one of them
    // is past at least one gap except the first.
    assert.deepEqual(p2s.filaments.map(f => f.id), [2, 5, 6, 7]);
    assert.deepEqual(p2s.filaments.map(f => f.index), [1, 4, 5, 6]);

    const slots = orderedAmsSlots(loadedSlotIds(printerSlots()));
    const entries = Object.values(resolveSliceSlots(calcFullConsumption(p2s), slots, { reportedByPrinter: false }));

    assert.deepEqual(entries.map(e => e.amsId), ["A2", "B3", "B4", "External"]);
    assert.deepEqual(entries.map(e => e.grams), [8.42, 6.28, 7.65, 7.65]);
});

test("every named position is confirmed by what the slot holds", () => {
    // The point of the correction: the position now names the slot the print
    // really runs from, so the first stage decides all four rather than three
    // of them falling through to the colour stages.
    const spools = printerSlots();
    const slots = orderedAmsSlots(loadedSlotIds(spools));
    const entries = Object.values(resolveSliceSlots(calcFullConsumption(p2s), slots, { reportedByPrinter: false }));

    const candidates = spools.filter(s => s.slotState !== "Empty").map(consumptionCandidate);
    const matched = matchConsumption(entries, candidates);

    assert.deepEqual(entries.map(e => matched.get(e)?.[0]?.amsId ?? null), ["A2", "B3", "B4", "External"]);
});

test("counting the empty slots too would book three of the four wrong", () => {
    // What the old ordering produced. B1 holds the beige PLA and B2 nothing at
    // all, so the ABS and the PETG were named for slots they are not in, and
    // the yellow PLA on the holder was named for B3.
    const withGaps = ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4", "External"];
    const entries = Object.values(resolveSliceSlots(calcFullConsumption(p2s), withGaps, { reportedByPrinter: false }));
    assert.deepEqual(entries.map(e => e.amsId), ["A2", "B1", "B2", "B3"]);

    // It stayed harmless only because none of those slots holds what was
    // sliced, so `slotConfirmsSlice` refused all three and profile plus colour
    // found the right spools anyway.
    const spools = printerSlots();
    const candidates = spools.filter(s => s.slotState !== "Empty").map(consumptionCandidate);
    const matched = matchConsumption(entries, candidates);
    assert.deepEqual(entries.map(e => matched.get(e)?.[0]?.amsId ?? null), ["A2", "B3", "B4", "External"]);
});
