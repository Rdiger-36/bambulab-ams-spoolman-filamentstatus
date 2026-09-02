import test from "node:test";
import assert from "node:assert/strict";

import { catalogueFacet, filterCatalogue } from "../src/utils.js";

// The SpoolmanDB catalogue is around seven thousand entries and a few megabytes,
// and the create-spool dialog queries it while the user types. Filtering happens
// on the server for that reason, so this covers what leaves it.

const CATALOGUE = [
    {
        id: "sunlu_pla+_grey_1000_175_n", manufacturer: "SUNLU", name: "Grey", material: "PLA+",
        density: 1.24, diameter: 1.75, weight: 1000, spool_weight: 220,
        extruder_temp: 210, bed_temp: 60, color_hex: "808080", color_hexes: null,
        multi_color_direction: null, pattern: null, translucent: false, glow: false,
    },
    {
        id: "bambulab_pla_black_1000_175_n", manufacturer: "Bambu Lab", name: "Black", material: "PLA Matte",
        density: 1.24, diameter: 1.75, weight: 1000, spool_weight: 250,
        extruder_temp: 220, bed_temp: 45, color_hex: "000000", color_hexes: null,
    },
    {
        id: "bambulab_abs_red_1000_175_n", manufacturer: "Bambu Lab", name: "Red", material: "ABS",
        density: 1.06, diameter: 1.75, weight: 1000, spool_weight: 250,
        extruder_temp: 260, bed_temp: 90, color_hex: "FF0000", color_hexes: null,
    },
];

test("a material matches its whole family, not only its exact spelling", () => {
    // The printer reports "PLA", and the useful suggestions sit in the catalogue
    // under "PLA+" and "PLA Matte".
    const names = filterCatalogue(CATALOGUE, { material: "PLA" }).map(e => e.name);
    assert.deepEqual(names, ["Grey", "Black"]);
});

test("a manufacturer has to match, whatever case it was typed in", () => {
    const names = filterCatalogue(CATALOGUE, { manufacturer: "bambu lab" }).map(e => e.name);
    assert.deepEqual(names, ["Black", "Red"]);
});

test("the search term is looked for in the manufacturer, the name and the material", () => {
    assert.equal(filterCatalogue(CATALOGUE, { q: "grey" }).length, 1);
    assert.equal(filterCatalogue(CATALOGUE, { q: "sunlu" }).length, 1);
    assert.equal(filterCatalogue(CATALOGUE, { q: "abs" }).length, 1);
});

test("the filters narrow each other", () => {
    assert.equal(filterCatalogue(CATALOGUE, { manufacturer: "Bambu Lab", material: "PLA" }).length, 1);
    assert.equal(filterCatalogue(CATALOGUE, { manufacturer: "SUNLU", material: "ABS" }).length, 0);
});

test("an entry carries only the fields the dialog fills in", () => {
    const [entry] = filterCatalogue(CATALOGUE, { q: "grey" });

    assert.deepEqual(Object.keys(entry).sort(), [
        "bed_temp", "color_hex", "color_hexes", "density", "diameter", "extruder_temp",
        "id", "manufacturer", "material", "multi_color_direction", "name", "spool_weight", "weight",
    ]);
    // Everything the catalogue carries beyond that stays on the server.
    assert.equal("translucent" in entry, false);
    assert.equal("pattern" in entry, false);
});

test("the answer is capped, and a caller cannot ask for the whole catalogue", () => {
    const many = Array.from({ length: 900 }, (_, i) => ({ ...CATALOGUE[0], id: `pla-${i}` }));

    assert.equal(filterCatalogue(many, { limit: 5 }).length, 5);
    assert.equal(filterCatalogue(many).length, 100);
    assert.equal(filterCatalogue(many, { limit: 9000 }).length, 500);
    assert.equal(filterCatalogue(many, { limit: 0 }).length, 100);
});

test("no filters and no catalogue are both answered rather than thrown at", () => {
    assert.equal(filterCatalogue(CATALOGUE).length, 3);
    assert.deepEqual(filterCatalogue(null), []);
    assert.deepEqual(filterCatalogue(undefined, { material: "PLA" }), []);
});

/* ---- catalogueFacet ---- */

test("the manufacturers on offer are listed, sorted and without duplicates", () => {
    assert.deepEqual(catalogueFacet(CATALOGUE, "manufacturer"), ["Bambu Lab", "SUNLU"]);
});

test("a chosen manufacturer narrows the materials still on offer", () => {
    assert.deepEqual(catalogueFacet(CATALOGUE, "material", { manufacturer: "Bambu Lab" }), ["ABS", "PLA Matte"]);
    assert.deepEqual(catalogueFacet(CATALOGUE, "material", { manufacturer: "SUNLU" }), ["PLA+"]);
});

test("the field being listed does not filter itself", () => {
    // Otherwise picking "PLA Matte" would leave "PLA Matte" as the only choice,
    // and the list could never be widened again.
    assert.deepEqual(
        catalogueFacet(CATALOGUE, "material", { manufacturer: "Bambu Lab", material: "ABS" }),
        ["ABS", "PLA Matte"],
    );
});

test("a material narrows the manufacturers, by family rather than by spelling", () => {
    assert.deepEqual(catalogueFacet(CATALOGUE, "manufacturer", { material: "PLA" }), ["Bambu Lab", "SUNLU"]);
    assert.deepEqual(catalogueFacet(CATALOGUE, "manufacturer", { material: "ABS" }), ["Bambu Lab"]);
});

test("an empty catalogue is answered with an empty list", () => {
    assert.deepEqual(catalogueFacet(null, "manufacturer"), []);
});
