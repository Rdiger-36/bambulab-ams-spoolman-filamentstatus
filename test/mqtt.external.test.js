import test from "node:test";
import assert from "node:assert/strict";

import { externalSpoolUnits } from "../src/mqtt.js";
import { processData, slotIsOccupied } from "../src/ams.js";
import { convertAMSandSlot, EXTERNAL_SLOT } from "../src/utils.js";

// The external spool holder as a P2S reports it, copied from a live report. It
// is field for field a chipless AMS tray, which is why it is handed to the same
// pipeline as a unit of its own rather than given a branch of its own.
const virSlot = {
    bed_temp: "0",
    bed_temp_type: "0",
    cali_idx: -1,
    cols: ["9D432CFF"],
    ctype: 2,
    drying_temp: "0",
    drying_time: "0",
    id: "255",
    nozzle_temp_max: "240",
    nozzle_temp_min: "190",
    remain: 0,
    tag_uid: "0000000000000000",
    total_len: 330000,
    tray_color: "9D432CFF",
    tray_diameter: "1.75",
    tray_id_name: "",
    tray_info_idx: "GFA00",
    tray_sub_brands: "",
    tray_type: "PLA",
    tray_uuid: "00000000000000000000000000000000",
    tray_weight: "0",
    xcam_info: "000000000000000000000000",
};

test("the holder is read as a unit of its own", () => {
    const [unit] = externalSpoolUnits({ vir_slot: [virSlot] });

    assert.equal(unit.id, "255");
    assert.equal(unit.tray.length, 1);
    assert.equal(convertAMSandSlot(unit.id, unit.tray[0].id), EXTERNAL_SLOT);
});

test("the holder classifies as the chipless spool it is", () => {
    const [unit] = processData(externalSpoolUnits({ vir_slot: [virSlot] }));
    const [tray] = unit.tray;

    assert.equal(slotIsOccupied(tray), true);
    // An all zero uuid is what sends processSlot into the 3rd party branch, so
    // the holder becomes assignable rather than read-only
    assert.equal(tray.tray_uuid, "N/A");
    assert.equal(tray.tray_sub_brands, "N/A");
    assert.deepEqual(tray.cols, ["9D432CFF"]);
});

test("older firmware reports the same thing as a single object", () => {
    // vt_tray is what this was before vir_slot. The P2S measured here no longer
    // sends the key at all, so both shapes have to be read.
    const [unit] = externalSpoolUnits({ vt_tray: virSlot });
    assert.equal(unit.tray.length, 1);
    assert.equal(unit.tray[0].tray_color, "9D432CFF");
});

test("a holder with nothing on it yields no unit", () => {
    // What the printer reports for an empty holder has not been observed. An
    // entry of empty strings would still carry its temperature fields into
    // slotIsOccupied() and read as a loaded spool nobody can identify, so the
    // row is left out until there is something in it.
    assert.deepEqual(externalSpoolUnits({ vir_slot: [] }), []);
    assert.deepEqual(externalSpoolUnits({}), []);
    assert.deepEqual(externalSpoolUnits({ vir_slot: [{ id: "255", tray_type: "", tray_info_idx: "", cols: [] }] }), []);
});

test("a holder is one filament, never part of a four slot unit", () => {
    // orderedAmsSlots() must not place it: the slicer lists it after the AMS
    // units and where exactly is not pinned down by any observed file.
    assert.equal(EXTERNAL_SLOT.startsWith("HT-"), false);
    assert.equal("ABCD".includes(EXTERNAL_SLOT[0]), false);
});
