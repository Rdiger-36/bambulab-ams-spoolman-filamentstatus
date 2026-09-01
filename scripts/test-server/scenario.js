/**
 * What the mock printer reports and what the mock Spoolman starts out holding.
 *
 * The point of the scenario is the colour swatch, so it fills every AMS unit
 * this service can address with the multi colour filaments from the three Bambu
 * Lab hex code tables, and keeps a few single colour spools next to them as a
 * control. Four regular AMS units carry four slots each, the eight AMS HT units
 * one each, which is 24 slots.
 *
 * Every colour below is the value from the datasheet, with the alpha byte the
 * AMS appends. The order is the datasheet order, which is not the order
 * SpoolmanDB stores, on purpose: matching compares the colours as a set and
 * must not depend on it.
 */

/**
 * One tray record in the shape a P2S reports for an identified Bambu Lab spool.
 *
 * `cols` holds every colour of the filament and `tray_color` only the first of
 * them, which is exactly the split that makes a multi colour spool worth
 * testing: anything reading the single field alone sees a plain spool.
 */
function bambuTray(id, { colors, material, type, idx, name, uuid, tagUid, remain = 100, weight = "1000", nozzleMin = "210", nozzleMax = "230", bedTemp = "35" }) {
    return {
        id: String(id),
        state: 11,
        bed_temp: bedTemp,
        bed_temp_type: "1",
        cali_idx: -1,
        cols: colors,
        ctype: 1,
        drying_temp: "55",
        drying_time: "8",
        nozzle_temp_max: nozzleMax,
        nozzle_temp_min: nozzleMin,
        remain,
        tag_uid: tagUid,
        tray_color: colors[0],
        tray_diameter: "1.75",
        tray_id_name: name,
        tray_info_idx: idx,
        tray_sub_brands: material,
        tray_type: type,
        tray_uuid: uuid,
        tray_weight: weight,
        xcam_info: "AC0D88132003E803CDCC4C3F",
    };
}

/** An empty slot, which reports its id and its state and nothing else. */
const emptyTray = id => ({ id: String(id), state: 10 });

/**
 * A slot the AMS is currently pulling filament into. Byte for byte an empty
 * slot, which is why `slotIsBusy()` has to read `state` to tell them apart.
 */
const busyTray = id => ({ id: String(id), state: 17 });

/**
 * A spool with no readable RFID chip. The AMS fills the record from its own
 * defaults and from what the user set on the printer, so it carries a material
 * and a colour but an all zero uuid.
 */
function thirdPartyTray(id, color) {
    return {
        id: String(id),
        state: 11,
        bed_temp: "35",
        bed_temp_type: "1",
        cali_idx: -1,
        cols: [color],
        ctype: 0,
        nozzle_temp_max: "240",
        nozzle_temp_min: "190",
        remain: -1,
        tag_uid: "0000000000000000",
        tray_color: color,
        tray_diameter: "1.75",
        tray_id_name: "",
        tray_info_idx: "GFL99",
        tray_sub_brands: "",
        tray_type: "PLA",
        tray_uuid: "00000000000000000000000000000000",
        tray_weight: "0",
        xcam_info: "000000000000000000000000",
    };
}

// PLA Silk Multi-Color. Two colours side by side down the strand, which
// SpoolmanDB calls "coaxial" and the datasheet draws as a hard split.
// GFA05 is the real profile id, read off a Gilded Rose spool on a P2S.
const SILK = { type: "PLA", material: "PLA Silk", idx: "GFA05", name: "A05-T1", nozzleMin: "210", nozzleMax: "230" };

// PLA Basic Gradient. One colour fading into the next along the length of the
// filament, which SpoolmanDB calls "longitudinal".
//
// GFA00 and "PLA Basic" are read off a real slice: Bambu Studio writes
// filament_ids GFA00 and filament_settings_id "Bambu PLA Basic @BBL P2S" for a
// gradient spool, so it is not a profile of its own. That is what makes a
// gradient collide with the plain spool of the same first colour, which C0 and
// D1 below both do.
const GRADIENT = { type: "PLA", material: "PLA Basic", idx: "GFA00", name: "A00-T0", nozzleMin: "190", nozzleMax: "230" };

// TPU 90A, the datasheet with both kinds in it: two gradient colours and four
// plain ones. This profile id is still a guess, no TPU 90A spool was sliced.
const TPU = { type: "TPU", material: "TPU 90A", idx: "GFU02", name: "U02-T0", nozzleMin: "200", nozzleMax: "240", bedTemp: "30" };

/**
 * The AMS units as `print.ams.ams` carries them.
 *
 * The ids are the full range `convertAMSandSlot()` knows: 0 to 3 for the
 * regular units, giving A0 to D3, and 128 to 135 for the single slot AMS HT
 * units, giving HT-A to HT-H.
 */
export const AMS_UNITS = [
    {
        id: "0",
        humidity: "4",
        temp: "28.5",
        tray: [
            // Already connected to a Spoolman spool below, so this slot proves
            // the colours survive the round trip through a filament record.
            bambuTray(0, { ...SILK, colors: ["FF9425FF", "FCA2BFFF"], uuid: "0417584A3ABE4274838571DB6AA6CABA", tagUid: "BAA8227400000100", remain: 78 }),
            // An untagged Spoolman spool matches this one, so it offers a merge.
            bambuTray(1, { ...SILK, colors: ["60A4E8FF", "4CE4A0FF"], uuid: "1C3F90B27D5E4A118C6427A0F1D3E845", tagUid: "BAA8227400000101", remain: 100 }),
            // These two share their first colour and their profile id, so the
            // consumption key built from `tray_info_idx` and `tray_color` is
            // identical for both and the dashboard marks them as ambiguous.
            // Only the second colour tells them apart, which is the whole point.
            bambuTray(2, { ...SILK, colors: ["0047BBFF", "7D1B49FF"], uuid: "5B8E1A4C9F2D48E7B0A36D5C8E914F72", tagUid: "BAA8227400000102", remain: 64 }),
            bambuTray(3, { ...SILK, colors: ["0047BBFF", "BB22A3FF"], uuid: "9D2A7C15E834B6F0A19C4E7D3B85206F", tagUid: "BAA8227400000103", remain: 41 }),
        ],
    },
    {
        id: "1",
        humidity: "5",
        temp: "28.1",
        tray: [
            bambuTray(0, { ...SILK, colors: ["000000FF", "A34342FF"], uuid: "3E6B9F04C71D42A8B5E092F7A4C61D38", tagUid: "BAA8227400000110", remain: 92 }),
            bambuTray(1, { ...SILK, colors: ["1E63BFFF", "713D9CFF"], uuid: "7A41D8E52B6C4390A8F1057E9C2B4D66", tagUid: "BAA8227400000111", remain: 55 }),
            // Neither of these two is in SpoolmanDB, so nothing matches them and
            // the slot reports that it cannot be handled automatically. The
            // swatch still has to draw both colours.
            bambuTray(2, { ...SILK, colors: ["720062FF", "3A913FFF"], uuid: "C05E2B738A9146D2BF74E1039A5C8B24", tagUid: "BAA8227400000112", remain: 87 }),
            bambuTray(3, { ...SILK, colors: ["F772A4FF", "00918BFF"], uuid: "48D9A0F61C3B47E5980A2D7F6B1E5C93", tagUid: "BAA8227400000113", remain: 30 }),
        ],
    },
    {
        id: "2",
        humidity: "4",
        temp: "27.8",
        tray: [
            // Connected to a Spoolman spool below as well, and longitudinal, so
            // the two ways of drawing a colour set sit next to each other.
            bambuTray(0, { ...GRADIENT, colors: ["FFFFFFFF", "9CDBD9FF"], uuid: "2F7C4E8A19B34D60A7E5C381FB92046D", tagUid: "BAA8227400000120", remain: 83 }),
            bambuTray(1, { ...GRADIENT, colors: ["54FF9BFF", "307FE2FF"], uuid: "B6194A2D7E8C4F31905B6D2A8C74E0F5", tagUid: "BAA8227400000121", remain: 100 }),
            bambuTray(2, { ...GRADIENT, colors: ["E7C1D5FF", "8EC9E9FF"], uuid: "D82605C74A1B49F3B7E081A25D6C93E4", tagUid: "BAA8227400000122", remain: 71 }),
            bambuTray(3, { ...GRADIENT, colors: ["6FCAEFFF", "8573DDFF"], uuid: "6E3B097F51D24C8AA0B92E4D7C186F35", tagUid: "BAA8227400000123", remain: 12 }),
        ],
    },
    {
        id: "3",
        humidity: "6",
        temp: "27.4",
        tray: [
            bambuTray(0, { ...GRADIENT, colors: ["4EC939FF", "B6FF43FF"], uuid: "A19D573E0B4C48F2861E9D3A5F7C204B", tagUid: "BAA8227400000130", remain: 96 }),
            bambuTray(1, { ...GRADIENT, colors: ["FFFFFFFF", "E94B3CFF"], uuid: "F4082C6B9A5D41E7B3160F8D2E9A7C51", tagUid: "BAA8227400000131", remain: 68 }),
            bambuTray(2, { ...GRADIENT, colors: ["F78F77FF", "E4505AFF"], uuid: "50C7E38146AB429DB8F0736E1C4A9D82", tagUid: "BAA8227400000132", remain: 23 }),
            // Not in SpoolmanDB either.
            bambuTray(3, { ...GRADIENT, colors: ["ED9558FF", "CE4406FF"], uuid: "8B26F1D40E7C43A59D14C8B036E27F9A", tagUid: "BAA8227400000133", remain: 49 }),
        ],
    },

    // The AMS HT units. One slot each, and no slot number in the label.
    htUnit(128, [bambuTray(0, { ...TPU, colors: ["F1AAA8FF", "D21B3CFF"], uuid: "17E9B4C82A6D40F5931C7E0B58A46D23", tagUid: "BAA8227400000140", remain: 74 })]),
    htUnit(129, [bambuTray(0, { ...TPU, colors: ["FFFFFFFF", "40B6E4FF"], uuid: "9C4A2E70D18B45F6A2E837C51B90D64F", tagUid: "BAA8227400000141", remain: 88 })]),
    // Single colour, and the control for the whole exercise: these two must
    // still render as one flat square, not as a gradient of one colour.
    htUnit(130, [bambuTray(0, { ...TPU, colors: ["000000FF"], uuid: "E30D9A6C24F84B17805E1D9B7A3C62F8", tagUid: "BAA8227400000142", remain: 35 })]),
    htUnit(131, [bambuTray(0, { ...TPU, colors: ["FFFFFFFF"], uuid: "4B72C08E5D1A49F3B69C0A73E285D14C", tagUid: "BAA8227400000143", remain: 61 })]),
    // Four colours, which no Bambu Lab filament in SpoolmanDB has. The swatch
    // has to divide the box into four rather than assume a pair.
    htUnit(132, [bambuTray(0, { ...SILK, colors: ["EC984CFF", "6CD4BCFF", "A66EB9FF", "D87694FF"], uuid: "AF15D6820C934E7BA05F31C86D2E9074", tagUid: "BAA8227400000144", remain: 100 })]),
    htUnit(133, [emptyTray(0)]),
    htUnit(134, [busyTray(0)]),
    htUnit(135, [thirdPartyTray(0, "0ACC38FF")]),
];

/** Wraps a tray list in the AMS unit envelope. */
function htUnit(id, tray) {
    return { id: String(id), humidity: "3", temp: "26.9", tray };
}

/**
 * The external spool holder, which the printer reports outside the AMS block as
 * `print.vir_slot`.
 *
 * Copied from a live P2S report, down to the fields that carry nothing. The
 * holder has no RFID chip, so the record is a chipless tray: an all zero uuid,
 * empty `tray_sub_brands` and `tray_weight` "0". With the 24 AMS slots above it
 * makes 25, which is every position this service can address.
 */
export const EXTERNAL_SPOOL = [
    {
        id: "255",
        bed_temp: "0",
        bed_temp_type: "0",
        cali_idx: -1,
        cols: ["9D432CFF"],
        ctype: 2,
        drying_temp: "0",
        drying_time: "0",
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
    },
];

/**
 * The filaments the mock Spoolman starts with.
 *
 * Only a few, so that the dashboard shows every state at once: a slot already
 * connected through its tag, a slot with a merge candidate, and the rest with
 * nothing in Spoolman yet. A multi colour filament carries no `color_hex` at
 * all, which is why a UI reading only that field had nothing to draw for it.
 */
export const SEED_FILAMENTS = [
    {
        id: 1,
        name: "Gilded Rose (Pink-Gold)",
        material: "PLA Silk",
        density: 1.32,
        diameter: 1.75,
        weight: 1000,
        spool_weight: 250,
        color_hex: null,
        multi_color_hexes: "FF9425,FCA2BF",
        multi_color_direction: "coaxial",
        external_id: "bambulab_pla_gildedrose(pink-gold)_1000_175_n",
    },
    {
        id: 2,
        name: "Blue Hawaii (Blue-Green)",
        material: "PLA Silk",
        density: 1.32,
        diameter: 1.75,
        weight: 1000,
        spool_weight: 250,
        color_hex: null,
        multi_color_hexes: "60A4E8,4CE4A0",
        multi_color_direction: "coaxial",
        external_id: "bambulab_pla_bluehawaii(blue-green)_1000_175_n",
    },
    {
        id: 3,
        name: "Arctic Whisper",
        material: "PLA Basic",
        density: 1.24,
        diameter: 1.75,
        weight: 1000,
        spool_weight: 250,
        color_hex: null,
        multi_color_hexes: "9CDBD9,FFFFFF",
        multi_color_direction: "longitudinal",
        external_id: "bambulab_pla_arcticwhisper_1000_175_n",
    },
    {
        id: 4,
        name: "Black",
        material: "PLA Basic",
        density: 1.24,
        diameter: 1.75,
        weight: 1000,
        spool_weight: 250,
        color_hex: "000000",
        multi_color_hexes: "",
        multi_color_direction: null,
        external_id: "bambulab_pla_black_1000_175_n",
    },
];

/**
 * The spools the mock Spoolman starts with.
 *
 * The two tagged ones are what makes A0 and C0 report as connected. The two
 * untagged ones are merge candidates and fill the assignment picker, where a
 * multi colour spool used to be the entry with no colour next to it.
 */
export const SEED_SPOOLS = [
    { id: 1, filament_id: 1, initial_weight: 1000, used_weight: 220, extra: { tag: '"0417584A3ABE4274838571DB6AA6CABA"' } },
    { id: 2, filament_id: 2, initial_weight: 1000, used_weight: 0, extra: {} },
    { id: 3, filament_id: 3, initial_weight: 1000, used_weight: 170, extra: { tag: '"2F7C4E8A19B34D60A7E5C381FB92046D"' } },
    { id: 4, filament_id: 4, initial_weight: 1000, used_weight: 640, extra: {} },
];
