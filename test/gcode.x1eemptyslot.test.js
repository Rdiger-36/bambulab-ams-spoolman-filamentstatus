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
    decodePrintMapping,
} from "../src/gcode.js";
import { matchConsumption, consumptionCandidate } from "../src/ams.js";
import { loadedSlotIds } from "../src/uispool.js";

// The print that settled the empty slot rule on a second printer family, and
// the only one where the printer itself says where each filament went. An X1E
// with one original AMS was loaded at A1, A2 and A4, A3 left empty on purpose,
// synchronised in Bambu Studio 02.08.02.61 and sliced: three loaded slots,
// three filaments. The printer reported `print.mapping` [0, 1, 3] for the
// whole print, that is A1, A2 and A4, which is exactly what the estimate from
// the list order names once the gap takes no position.
//
// Read off the raw MQTT trace of 2026-09-07 alongside the sliced file:
//
//   pos 0  A1  GFA00 PLA Basic  #C12E1F
//   pos 1  A2  GFA00 PLA Basic  #FF6A13
//   pos 2  A4  GFA00 PLA Basic  #8E9089     A3 is empty and absent
//
// The service booked from the printer's mapping there, so nothing depended on
// the estimate. On a P1S or an A1, which report no mapping, the estimate is the
// only answer, and counting the empty A3 would have named it for the grey PLA.

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "x1e_third_slot_empty.config");
const x1e = parseSliceInfo(fs.readFileSync(fixturePath, "utf-8"));

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

/** What the X1E reported, slot for slot, with the gap at A3. */
const printerSlots = () => [
    slot("A1", "GFA00", "PLA", "C12E1FFF", 1),
    slot("A2", "GFA00", "PLA", "FF6A13FF", 2),
    empty("A3"),
    slot("A4", "GFA00", "PLA", "8E9089FF", 3),
];

test("the printer's own mapping and the estimate name the same slots", () => {
    // `print.mapping` [0, 1, 3]: unit 0 in the high byte, the slot in the low
    // one, so 0x0003 is the fourth slot of the first unit, A4.
    const reported = decodePrintMapping([0x0000, 0x0001, 0x0003]);
    assert.deepEqual(reported, ["A1", "A2", "A4"]);

    assert.deepEqual(orderedAmsSlots(loadedSlotIds(printerSlots())), reported);
});

test("the three filaments land on the three loaded slots", () => {
    assert.deepEqual(x1e.filaments.map(f => f.index), [0, 1, 2]);

    const slots = orderedAmsSlots(loadedSlotIds(printerSlots()));
    const entries = Object.values(resolveSliceSlots(calcFullConsumption(x1e), slots, { reportedByPrinter: false }));

    assert.deepEqual(entries.map(e => e.amsId), ["A1", "A2", "A4"]);
    assert.deepEqual(entries.map(e => e.grams), [3.99, 1.91, 4.21]);

    const candidates = printerSlots().filter(s => s.slotState !== "Empty").map(consumptionCandidate);
    const matched = matchConsumption(entries, candidates);
    assert.deepEqual(entries.map(e => matched.get(e)?.[0]?.amsId ?? null), ["A1", "A2", "A4"]);
});

test("counting the empty slot would name it for the grey PLA", () => {
    // What the old ordering produced: position 2 is A3, and A3 holds nothing.
    // The three spools are the same profile and each a different colour, so the
    // colour stage still found the right one. Two grey spools would not have
    // been told apart.
    const withGap = ["A1", "A2", "A3", "A4"];
    const entries = Object.values(resolveSliceSlots(calcFullConsumption(x1e), withGap, { reportedByPrinter: false }));
    assert.deepEqual(entries.map(e => e.amsId), ["A1", "A2", "A3"]);

    const candidates = printerSlots().filter(s => s.slotState !== "Empty").map(consumptionCandidate);
    const matched = matchConsumption(entries, candidates);
    assert.deepEqual(entries.map(e => matched.get(e)?.[0]?.amsId ?? null), ["A1", "A2", "A4"]);
});
