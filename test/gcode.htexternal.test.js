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
import { loadedSlotIds } from "../src/uispool.js";

// A real print off a single nozzle P1S with two AMS units, an AMS HT and a
// spool on the external holder, sliced in Bambu Studio 02.08.02.61. The printer
// was read out over MQTT while this was written, so the slots below are what it
// actually reports rather than a plausible layout, and the project's nine
// filaments match those nine loaded slots one for one, in order.
//
// That correspondence is the measurement this fixture exists for, because it
// settles two things `orderedAmsSlots()` could only assume, and both are what
// it now does:
//
//   - the empty B3 takes no position. The list runs A0 to A3, then B0 to B2,
//     and the next entry is already the external holder
//   - the external holder comes before the AMS HT, although the printer numbers
//     the holder 254 and the HT 128, so the order is not a sort by unit id
//
// The plate prints four of those nine, at the positions 0, 6, 7 and 8. The
// booking does not rest on the position alone: the shuffled layout below moves
// every spool and lands on the same spools, because the slot refuses a position
// that does not hold what was sliced and profile plus colour decide instead.
//
// The plate is printed by object, which gives each filament one closed layer
// range and makes this the fixture for what a cancelled sequential print books.

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "p1s_ht_external.config");
const p1s = parseSliceInfo(fs.readFileSync(fixturePath, "utf-8"));

/** One loaded slot, in the shape `consumptionCandidate()` reads. */
const slot = (amsId, idx, type, color, { id = null, tag = true } = {}) => ({
    amsId,
    slotState: "Loaded (Bambu Lab)",
    connectedViaTag: tag,
    connectedViaMapping: false,
    existingSpool: id ? { id } : null,
    slot: { tray_type: type, tray_info_idx: idx, tray_color: color, cols: [color], tray_weight: "1000", remain: 50 },
});

/** What the printer reports, slot for slot. B3 holds nothing. */
const printerSlots = () => [
    slot("A0", "GFA00", "PLA", "FF6A13FF", { id: 1 }),
    slot("A1", "GFA00", "PLA", "000000FF", { id: 2 }),
    slot("A2", "GFA01", "PLA", "FFFFFFFF", { id: 3 }),
    slot("A3", "GFG02", "PETG", "0086D6FF", { id: 4 }),
    slot("B0", "GFA05", "PLA", "D4AF37FF", { id: 5 }),
    slot("B1", "GFU01", "TPU", "1F1F1FFF", { id: 6 }),
    slot("B2", "GFA00", "PLA", "00AE42FF", { id: 7 }),
    { amsId: "B3", slotState: "Empty", connectedViaTag: false, connectedViaMapping: false, existingSpool: null, slot: {} },
    slot("HT-A", "GFB00", "ABS", "E4E4E4FF", { id: 8 }),
    slot("External", "GFG00", "PETG", "0000FFFF", { id: 9 }),
];

/** The positions this service estimates, the way `/api/print` builds them. */
const estimatedPositions = (spools) => orderedAmsSlots(loadedSlotIds(spools));

/** The slot every sliced filament ends up matched to, in slicer list order. */
function matchedSlots(consumption, slots, reportedByPrinter, spools) {
    const entries = Object.values(resolveSliceSlots(consumption, slots, { reportedByPrinter }));
    const candidates = spools.filter(s => s.slotState !== "Empty").map(consumptionCandidate);
    const matched = matchConsumption(entries, candidates);
    return entries.map(entry => matched.get(entry)?.[0]?.amsId ?? null);
}

test("the four printed filaments are read off a nine filament project", () => {
    // The project keeps the entries it does not print, so the ids are not
    // contiguous and it is id - 1 that indexes the layer lists.
    assert.deepEqual(p1s.filaments.map(f => f.id), [1, 7, 8, 9]);
    assert.deepEqual(p1s.filaments.map(f => f.index), [0, 6, 7, 8]);
    assert.deepEqual(p1s.filaments.map(f => f.tray_info_idx), ["GFA00", "GFA00", "GFG00", "GFB00"]);
    assert.deepEqual(p1s.filaments.map(f => f.color), ["#FF6A13", "#00AE42", "#0000FF", "#E4E4E4"]);
    assert.deepEqual(p1s.filaments.map(f => f.used_g), [6.93, 7.33, 6.49, 5.39]);
    assert.equal(p1s.totalLayers, 511);   // 512 layers, numbered from 0
});

test("the print books onto the slots the printer really holds them in", () => {
    // The orange PLA sits in A0, the green one in B2, the blue PETG on the
    // external holder and the ABS in the AMS HT. Nothing else in the printer
    // shares both a profile and a colour with any of them.
    const spools = printerSlots();
    assert.deepEqual(
        matchedSlots(calcFullConsumption(p1s), estimatedPositions(spools), false, spools),
        ["A0", "B2", "External", "HT-A"],
    );
});

test("the answer does not depend on where the spools sit", () => {
    // The same nine spools, shuffled across the same slots. Position 0 now
    // names A0 for the orange PLA and A0 holds the white PLA Matte, so it is
    // refused rather than booked on.
    const shuffled = [
        slot("A0", "GFA01", "PLA", "FFFFFFFF", { id: 3 }),
        slot("A1", "GFA00", "PLA", "FF6A13FF", { id: 1 }),
        slot("A2", "GFU01", "TPU", "1F1F1FFF", { id: 6 }),
        slot("A3", "GFA00", "PLA", "00AE42FF", { id: 7 }),
        slot("B0", "GFG02", "PETG", "0086D6FF", { id: 4 }),
        slot("B1", "GFA00", "PLA", "000000FF", { id: 2 }),
        slot("B2", "GFA05", "PLA", "D4AF37FF", { id: 5 }),
        slot("HT-A", "GFG00", "PETG", "0000FFFF", { id: 9 }),
        slot("External", "GFB00", "ABS", "E4E4E4FF", { id: 8 }),
    ];
    assert.deepEqual(
        matchedSlots(calcFullConsumption(p1s), estimatedPositions(shuffled), false, shuffled),
        ["A1", "A3", "HT-A", "External"],
    );
});

test("what the printer reports carries the unused filaments as gaps", () => {
    // One entry per filament of the project, so nine, and 0xFFFF for every one
    // the plate does not print. Decoding those as a slot would name the
    // external holder, which is unit 255 slot 0.
    const slots = decodePrintMapping([0x0000, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0x0102, 0xFF00, 0x8000]);
    assert.deepEqual(slots, ["A0", null, null, null, null, null, "B2", "External", "HT-A"]);

    const spools = printerSlots();
    assert.deepEqual(matchedSlots(calcFullConsumption(p1s), slots, true, spools), ["A0", "B2", "External", "HT-A"]);
});

test("the estimated positions are the ones the slicer used", () => {
    // Read off the printer: the nine filaments of the project are its nine
    // loaded slots, in this order. The empty B3 has no position, and the holder
    // comes before the AMS HT although the printer numbers it 254 against the
    // HT's 128.
    const measured = ["A0", "A1", "A2", "A3", "B0", "B1", "B2", "External", "HT-A"];
    assert.deepEqual(estimatedPositions(printerSlots()), measured);

    // So the position alone names every slot this print runs from, and each of
    // the four is confirmed by what the slot holds.
    const entries = Object.values(resolveSliceSlots(calcFullConsumption(p1s), measured, { reportedByPrinter: false }));
    assert.deepEqual(entries.map(e => e.amsId), ["A0", "B2", "External", "HT-A"]);
});

test("a print by object gives every filament a range of its own", () => {
    // Four cubes printed one after the other, 128 layers each, and the slicer
    // numbers the layers straight through the plate rather than restarting per
    // object.
    assert.deepEqual(p1s.rangesByFilamentIdx, {
        0: [[256, 383]],
        6: [[128, 255]],
        7: [[0, 127]],
        8: [[384, 511]],
    });
});

test("a cancelled sequential print books only the objects that were printed", () => {
    // Cancelled after the second cube: the PETG and the green PLA are whole,
    // and the two cubes that never started book nothing at all. A proportion of
    // the whole print would have charged every spool a quarter of its amount.
    const grams = (layer) => Object.values(calcPartialConsumption(p1s, layer)).map(e => e.grams);

    assert.deepEqual(grams(127), [0, 0, 6.49, 0]);
    assert.deepEqual(grams(255), [0, 7.33, 6.49, 0]);
    assert.deepEqual(grams(383), [6.93, 7.33, 6.49, 0]);
    assert.deepEqual(grams(511), [6.93, 7.33, 6.49, 5.39]);

    // Halfway through the third cube, and only that cube's filament is partial.
    assert.deepEqual(grams(319), [3.47, 7.33, 6.49, 0]);
});

test("a cancelled sequential print still lands on the right slots", () => {
    const spools = printerSlots();
    assert.deepEqual(
        matchedSlots(calcPartialConsumption(p1s, 319), estimatedPositions(spools), false, spools),
        ["A0", "B2", "External", "HT-A"],
    );
});
