import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";

import { activeSlotFromReport } from "../src/utils.js";

const REPORTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "reports");

/** The `print` block of one of the real printer reports. */
function printOf(name) {
    return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, `${name}.json`), "utf8")).pushall.print;
}

test("the real reports name the slot in the printing nozzle", () => {
    const expected = {
        // tray_now alone, four slots per unit packed into one number
        "a1": null,
        "p1s": null,
        "x1c-multi-ams": null,
        "p1p-no-ams": "External",
        "misc": "HT-A",
        // snow per nozzle, the unit in the high byte
        "p2s": "A4",
        "h2s": "A1",
        "a2l": null,
        // an H2D printing from its right nozzle with B4 loaded; tray_now says
        // 3 there, which would be A4
        "h2d": "B4",
        "h2d-external-active": "External",
        // the X2D prints from nozzle 1, which holds A2
        "x2d": "A2",
        // the H2D Pro prints from nozzle 1, which is empty
        "h2d-pro": null,
        "h2c": null,
    };

    for (const [name, slot] of Object.entries(expected)) {
        assert.equal(activeSlotFromReport(printOf(name))?.slot, slot, name);
    }
});

test("a report that says nothing about it leaves the last value alone", () => {
    assert.equal(activeSlotFromReport({ layer_num: 12 }), undefined);
    assert.equal(activeSlotFromReport(undefined), undefined);
});

test("a delta without the extruder state keeps the nozzle the last report named", () => {
    const delta = { device: { extruder: { info: [{ id: 0, snow: 0 }, { id: 1, snow: 257 }] } } };

    assert.deepEqual(activeSlotFromReport(delta, 1), { slot: "B2", nozzle: 1 });
    assert.deepEqual(activeSlotFromReport(delta, 0), { slot: "A1", nozzle: 0 });
});
