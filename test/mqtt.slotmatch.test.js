import test from "node:test";
import assert from "node:assert/strict";

import { slotConfirmsSlice } from "../src/mqtt.js";

// The position of a filament in the slicer's list is the AMS slot it was sliced
// for, which is the only thing that can tell two identical spools apart. The
// printer is free to remap slots when a job is sent, and slice_info.config is
// written before that, so the slot is confirmed against what the AMS reports
// for it now rather than taken on trust.

const candidate = (idx, colors) => ({ id: 1, amsId: "B0", mapped: false, idx, colors });
const entry = (idx, color, colors = null) => ({ tray_info_idx: idx, color, colors, amsId: "B0" });

test("a slot holding what the slice expected confirms it", () => {
    assert.equal(
        slotConfirmsSlice(candidate("GFA00", ["8ec9e9", "e7c1d5"]), entry("GFA00", "#8EC9E9", ["8EC9E9", "E7C1D5"])),
        true,
    );
});

test("the colour set is compared as a set, not by its first colour", () => {
    // Bambu Studio and the RFID chip need not agree on which colour comes
    // first, and a comparison that depended on it would reject exactly the
    // spools this exists for.
    assert.equal(
        slotConfirmsSlice(candidate("GFA00", ["e7c1d5", "8ec9e9"]), entry("GFA00", "#8EC9E9", ["8EC9E9", "E7C1D5"])),
        true,
    );
});

test("a different profile in the slot refuses it", () => {
    assert.equal(
        slotConfirmsSlice(candidate("GFA05", ["8ec9e9", "e7c1d5"]), entry("GFA00", "#8EC9E9", ["8EC9E9", "E7C1D5"])),
        false,
    );
});

test("a different colour set in the slot refuses it", () => {
    // The remap case: the slot exists and holds the right profile, but another
    // filament. Booking on it would be silent and wrong.
    assert.equal(
        slotConfirmsSlice(candidate("GFA00", ["ffffff", "e94b3c"]), entry("GFA00", "#FFFFFF", ["FFFFFF", "9CDBD9"])),
        false,
    );
});

test("a single colour spool confirms on its one colour", () => {
    assert.equal(slotConfirmsSlice(candidate("GFA00", ["000000"]), entry("GFA00", "#000000")), true);
    assert.equal(slotConfirmsSlice(candidate("GFA00", ["ffffff"]), entry("GFA00", "#000000")), false);
});

test("a multi colour slot does not confirm against a slice that carries no set", () => {
    // An older slicer writes no project_settings.config, so the set is unknown
    // and only the first colour is comparable. Refusing here costs the slot
    // stage and leaves the decision to the stages that existed before it.
    assert.equal(
        slotConfirmsSlice(candidate("GFA00", ["ffffff", "9cdbd9"]), entry("GFA00", "#FFFFFF")),
        false,
    );
});

test("a slot with no profile at all refuses", () => {
    assert.equal(slotConfirmsSlice(candidate(null, ["000000"]), entry("GFA00", "#000000")), false);
    assert.equal(slotConfirmsSlice(candidate("GFA00", []), entry("GFA00", "#000000")), false);
});

/* ---- A reported slot is trusted, an estimated one is confirmed ---- */

// Read off a live print. The slice held Army Green on the external holder, and
// the print was started with the orange spool in A1 selected for that filament
// by mistake. print.mapping said A1, which was right: A1 is what the printer
// would have consumed.
const armyGreenSlice = { index: 3, amsId: "A1", tray_info_idx: "GFL99", color: "#5E6345", colors: null };
const orangeInA1 = { id: 9, amsId: "A1", mapped: true, idx: "GFL99", colors: ["f98c36"] };

test("a slot the printer reported is not checked against the sliced colour", () => {
    // Confirming it rejected the one answer that was right. A filament
    // substituted for the sliced one is not a mistake to catch, it is the
    // substitution the field exists to report, and rejecting it fell through to
    // the colour stages, which found the spool that was sliced rather than the
    // spool that would have been consumed.
    assert.equal(slotConfirmsSlice(orangeInA1, armyGreenSlice), false);

    // Which is why the stage reads the flag rather than the confirmation for a
    // reported slot. Same predicate as bookConsumption's first stage.
    const stage = (candidate, info) =>
        !!info.amsId && candidate.amsId === info.amsId && (info.amsIdFromPrinter || slotConfirmsSlice(candidate, info));

    assert.equal(stage(orangeInA1, { ...armyGreenSlice, amsIdFromPrinter: true }), true);
    assert.equal(stage(orangeInA1, { ...armyGreenSlice, amsIdFromPrinter: false }), false);
});

test("an estimated slot still has to hold what the slice expects", () => {
    // The list order cannot tell whether the project is synchronised with the
    // printer, so its answer is corroborated before anything is booked on it.
    const stage = (candidate, info) =>
        !!info.amsId && candidate.amsId === info.amsId && (info.amsIdFromPrinter || slotConfirmsSlice(candidate, info));

    const matchingSlot = { id: 1, amsId: "A1", mapped: false, idx: "GFL99", colors: ["5e6345"] };
    assert.equal(stage(matchingSlot, { ...armyGreenSlice, amsIdFromPrinter: false }), true);
});
