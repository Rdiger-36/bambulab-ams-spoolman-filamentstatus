import test from "node:test";
import assert from "node:assert/strict";

import { buildFilamentPayload } from "../src/spoolman.js";
import { state } from "../src/state.js";

state.vendorID = 1;

// Real SpoolmanDB entries, as returned by GET /api/v1/external/filament.
const supportForPla = {
    id: "bambulab_pla_supportforplawhite_500_175_n",
    manufacturer: "Bambu Lab",
    name: "Support for PLA White",
    material: "PLA",
    density: 1.33,
    diameter: 1.75,
    weight: 500.0,
    spool_weight: 250.0,
    color_hex: "FFFFFF",
    color_hexes: null,
    extruder_temp: 225,
    bed_temp: 40,
    multi_color_direction: null,
};

const plaBlack = {
    id: "bambulab_pla_black_1000_175_n",
    name: "Black",
    density: 1.24,
    diameter: 1.75,
    weight: 1000.0,
    spool_weight: 250.0,
    color_hex: "000000",
    color_hexes: null,
    extruder_temp: 220,
    bed_temp: 60,
    multi_color_direction: null,
};

const slot = (subBrands, trayWeight) => ({ tray_sub_brands: subBrands, tray_weight: trayWeight });

test("filament weight comes from SpoolmanDB, not a hardcoded 1kg", () => {
    // Support for PLA only exists as a 500g entry; it used to be created as 1000g.
    const p = buildFilamentPayload({
        slot: slot("Support for PLA", "250"),
        matchingExternalFilament: supportForPla,
    });
    assert.equal(p.weight, 500);
    assert.equal(p.spool_weight, 250);
});

test("a 1kg filament keeps its catalogue weight", () => {
    const p = buildFilamentPayload({
        slot: slot("PLA Basic", "1000"),
        matchingExternalFilament: plaBlack,
    });
    assert.equal(p.weight, 1000);
    assert.equal(p.spool_weight, 250);
});

test("material is the AMS sub brand, the rest comes from the catalogue entry", () => {
    const p = buildFilamentPayload({
        slot: slot("Support for PLA", "250"),
        matchingExternalFilament: supportForPla,
    });
    assert.equal(p.material, "Support for PLA");
    assert.equal(p.name, "Support for PLA White");
    assert.equal(p.density, 1.33);
    assert.equal(p.diameter, 1.75);
    assert.equal(p.color_hex, "FFFFFF");
    assert.equal(p.external_id, "bambulab_pla_supportforplawhite_500_175_n");
    assert.equal(p.settings_extruder_temp, 225);
    assert.equal(p.settings_bed_temp, 40);
    assert.equal(p.vendor_id, 1);
});

test("multi colour hexes are joined, and empty when the entry has none", () => {
    const single = buildFilamentPayload({ slot: slot("PLA Basic", "1000"), matchingExternalFilament: plaBlack });
    assert.equal(single.multi_color_hexes, "");

    const multi = buildFilamentPayload({
        slot: slot("PLA Galaxy", "1000"),
        matchingExternalFilament: { ...plaBlack, color_hexes: ["FF0000", "00FF00"], multi_color_direction: "coaxial" },
    });
    assert.equal(multi.multi_color_hexes, "FF0000,00FF00");
    assert.equal(multi.multi_color_direction, "coaxial");
});

test("fields Spoolman does not accept are not sent", () => {
    const p = buildFilamentPayload({
        slot: slot("PLA Basic", "1000"),
        matchingExternalFilament: { ...plaBlack, spool_type: "plastic", finish: "matte", pattern: null, translucent: false, glow: false },
    });
    for (const key of ["spool_type", "finish", "pattern", "translucent", "glow"]) {
        assert.equal(key in p, false, `${key} should not be part of the payload`);
    }
});
