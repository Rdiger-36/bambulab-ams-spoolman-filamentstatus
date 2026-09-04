import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { startTestApp, call } from "./helpers/app.js";

// Everything that leaves the server for a client goes through toClientSpool(),
// so this file covers both what it hands out and the broadcast decision built
// on top of it.
let app, toClientSpool, hasSpoolUiChanged, printers;

before(async () => {
    app = await startTestApp();
    ({ toClientSpool } = await import("../src/uispool.js"));
    ({ hasSpoolUiChanged } = await import("../src/ams.js"));
    ({ printers } = await import("../src/printers.js"));
});
after(async () => { await app.close(); });

/** A UI spool as processSlot() builds it for an identified Bambu Lab spool. */
function uiSpool(overrides = {}) {
    return {
        amsId: "A1",
        slot: {
            id: 0,
            tray_uuid: "ABCD",
            tray_type: "PLA",
            tray_sub_brands: "PLA Basic",
            tray_color: "F98C36FF",
            tray_info_idx: "GFA00",
            tray_weight: "1000",
            remain: 63,
            // Fields the printer sends and the UI never shows
            bed_temp: "45",
            nozzle_temp_max: "240",
            state: 11,
        },
        existingSpool: {
            id: 42,
            remaining_weight: 640,
            remaining_percentage: 64,
            initial_weight: 1000,
            last_used: "2026-08-31T10:00:00Z",
            filament: { id: 7, name: "Orange", material: "PLA", weight: 1000, color_hex: "F98C36", vendor: { id: 3, name: "Bambu Lab" } },
        },
        mergeableSpool: null,
        matchingInternalFilament: null,
        matchingExternalFilament: null,
        connectedViaTag: true,
        connectedViaMapping: false,
        correctedRemain: 63,
        correctedWeight: 630,
        option: "No actions available",
        enableButton: "false",
        slotState: "Loaded (Bambu Lab)",
        error: false,
        printerName: "Test printer",
        logFilePath: "/logs/test.log",
        ...overrides,
    };
}

test("the projection keeps the server's own fields and the firmware noise out", () => {
    const client = toClientSpool(uiSpool());

    assert.equal(client.printerName, undefined);
    assert.equal(client.logFilePath, undefined);
    assert.equal(client.slot.bed_temp, undefined);
    assert.equal(client.slot.state, undefined);
    assert.equal(client.existingSpool.last_used, undefined);

    // What the dashboard reads has to survive
    assert.equal(client.slot.tray_uuid, "ABCD");
    assert.equal(client.slot.tray_weight, "1000");
    assert.equal(client.existingSpool.remaining_weight, 640);
    assert.equal(client.existingSpool.filament.vendor.name, "Bambu Lab");
    assert.equal(client.correctedWeight, 630);
    assert.equal(client.option, "No actions available");
});

test("the readable name and the consumption key are derived once, on the server", () => {
    const linked = toClientSpool(uiSpool());
    assert.equal(linked.vendor, "Bambu Lab");
    assert.equal(linked.material, "PLA");
    assert.equal(linked.filamentName, "Orange");
    assert.equal(linked.spoolmanId, 42);
    assert.equal(linked.key, "GFA00|F98C36");

    // Without a linked spool the AMS slot and the catalogue entry fill in
    const unlinked = toClientSpool(uiSpool({
        existingSpool: null,
        matchingExternalFilament: { id: 9, name: "Orange", manufacturer: "Bambu Lab", material: "PLA", density: 1.24, diameter: 1.75 },
    }));
    assert.equal(unlinked.vendor, "Bambu Lab");
    assert.equal(unlinked.filamentName, "Orange");
    assert.equal(unlinked.spoolmanId, null);
});

test("a missing assignment reads as false rather than absent", () => {
    // The UI branches on these, so an undefined would silently render as "not
    // tracked" wherever a builder forgot to set it
    const client = toClientSpool({ amsId: "A2", slot: {}, slotState: "Empty" });

    assert.equal(client.connectedViaTag, false);
    assert.equal(client.connectedViaMapping, false);
    assert.equal(client.correctedWeight, null);
    assert.equal(client.enableButton, "false");
});

test("the N/A placeholder does not reach a client", () => {
    // processData writes "N/A" into every field the printer left out. It is a
    // backend marker, and a client that receives it renders it, which is how an
    // emptied slot ended up labelled "N/A" with a `#N/A` colour swatch.
    const client = toClientSpool({
        amsId: "A1",
        slotState: "Empty",
        slot: { id: 0, state: 10, remain: 0, tray_color: "N/A", tray_sub_brands: "N/A", tray_weight: 0, tray_uuid: "N/A" },
    });

    assert.equal(client.slot.tray_uuid, null);
    assert.equal(client.slot.tray_color, null);
    assert.equal(client.slot.tray_sub_brands, null);
    assert.equal(client.slot.tray_type, null);
    assert.equal(client.filamentName, null);
    assert.equal(client.material, null);
});

test("a 3rd party slot keeps what the printer does know", () => {
    // Material and colour set on the AMS are real values and have to survive,
    // even though the same record carries placeholders next to them.
    const client = toClientSpool({
        amsId: "B1",
        slotState: "Loaded (3rd party)",
        slot: { id: 0, state: 11, tray_info_idx: "GFL99", tray_type: "PLA", tray_sub_brands: "N/A", tray_color: "0ACC38FF", tray_weight: "0", tray_uuid: "N/A", remain: 0 },
    });

    assert.equal(client.slot.tray_type, "PLA");
    assert.equal(client.slot.tray_color, "0ACC38FF");
    assert.equal(client.slot.tray_uuid, null);
    assert.equal(client.material, "PLA");
    assert.equal(client.filamentName, null);
    assert.equal(client.key, "GFL99|0ACC38");
});

test("a change the UI does not show does not trigger a broadcast", () => {
    const prev = uiSpool();
    const next = uiSpool({ slot: { ...uiSpool().slot, bed_temp: "60", nozzle_temp_max: "250" } });

    assert.equal(hasSpoolUiChanged(next, prev), false);
});

test("a displayed change does trigger one", () => {
    const prev = uiSpool();

    // The remaining weight of the linked spool is a column in both tables. The
    // old key list compared existingSpool.id only, so this went unnoticed.
    const booked = uiSpool({ existingSpool: { ...uiSpool().existingSpool, remaining_weight: 500 } });
    assert.equal(hasSpoolUiChanged(booked, prev), true);

    // And an assignment, which the old list did not cover either
    const assigned = uiSpool({ connectedViaMapping: true, option: "Unassign Spool" });
    assert.equal(hasSpoolUiChanged(assigned, prev), true);

    // An unknown previous state always counts as changed
    assert.equal(hasSpoolUiChanged(prev, undefined), true);
});

test("the dashboard and the print endpoint report the same slots", async () => {
    await call(`${app.url}/api/printers`, "POST", {
        id: "01P00A000000009", ip: "127.0.0.1", code: "12345678", name: "Projection printer",
    });
    const printer = printers.find(p => p.id === "01P00A000000009");
    printer.spoolData = [uiSpool({ connectedViaTag: false, connectedViaMapping: true, option: "Unassign Spool" })];

    const spools = await call(`${app.url}/api/spools/01P00A000000009`);
    const print = await call(`${app.url}/api/print/01P00A000000009`);

    assert.equal(spools.status, 200);
    assert.equal(print.status, 200);
    assert.deepEqual(print.body.loadedSpools, spools.body);

    // The reason this endpoint exists: it can answer whether the slot is booked
    assert.equal(print.body.loadedSpools[0].connectedViaMapping, true);
    assert.equal(print.body.loadedSpools[0].key, "GFA00|F98C36");
});

test("a multi colour slot carries its whole colour set to the client", () => {
    // `tray_color` holds only the first colour, so a client that reads it alone
    // draws a two colour spool as if it were plain orange.
    const client = toClientSpool(uiSpool({
        slot: {
            id: 0,
            state: 11,
            cols: ["FF9425FF", "FCA2BFFF"],
            tray_uuid: "0417584A3ABE4274838571DB6AA6CABA",
            tray_type: "PLA",
            tray_sub_brands: "PLA Silk",
            tray_color: "FF9425FF",
            tray_info_idx: "GFA05",
            tray_weight: "1000",
            remain: 80,
        },
    }));

    assert.deepEqual(client.slot.cols, ["ff9425", "fca2bf"]);
    // Still sent, because the consumption key and the mapping fingerprint are
    // built from it on both sides and have to keep agreeing.
    assert.equal(client.slot.tray_color, "FF9425FF");
    // The whole set is in the key, so this slot is no longer indistinguishable
    // from a plain orange PLA Silk on the same profile.
    assert.equal(client.key, "GFA05|FF9425|FCA2BF+FF9425");
});

test("a slot without cols still reports the one colour the printer sends", () => {
    const client = toClientSpool(uiSpool({
        slot: { id: 0, tray_uuid: "ABCD", tray_type: "PLA", tray_sub_brands: "PLA Basic", tray_color: "F98C36FF", tray_weight: "1000", remain: 63 },
    }));
    assert.deepEqual(client.slot.cols, ["f98c36"]);
});

test("an empty slot reports no colours at all", () => {
    const client = toClientSpool({
        amsId: "A2",
        slotState: "Empty",
        slot: { id: 1, state: 10, remain: 0, tray_color: "N/A", tray_sub_brands: "N/A", tray_weight: 0, tray_uuid: "N/A" },
    });
    assert.deepEqual(client.slot.cols, []);
});

test("a multi colour Spoolman filament keeps its colours and its direction", () => {
    // Spoolman stores the two mutually exclusively: a multi colour filament has
    // no color_hex, so sending only that field left it with nothing to draw.
    const client = toClientSpool(uiSpool({
        existingSpool: {
            id: 42,
            remaining_weight: 640,
            initial_weight: 1000,
            filament: {
                id: 7,
                name: "Gilded Rose (Pink-Gold)",
                material: "PLA Silk",
                color_hex: null,
                multi_color_hexes: "FF9425,FCA2BF",
                multi_color_direction: "coaxial",
                vendor: { id: 3, name: "Bambu Lab" },
            },
        },
    }));

    assert.equal(client.existingSpool.filament.multi_color_hexes, "FF9425,FCA2BF");
    assert.equal(client.existingSpool.filament.multi_color_direction, "coaxial");
    assert.equal(client.existingSpool.filament.color_hex, null);
});

test("a single colour filament reports no multi colour fields", () => {
    // buildFilamentPayload writes an empty string for a single colour spool,
    // and an empty string must not reach a client any more than "N/A" does.
    const client = toClientSpool(uiSpool({
        existingSpool: {
            id: 42,
            filament: { id: 7, name: "Orange", material: "PLA", color_hex: "F98C36", multi_color_hexes: "", multi_color_direction: null },
        },
    }));
    assert.equal(client.existingSpool.filament.multi_color_hexes, null);
    assert.equal(client.existingSpool.filament.multi_color_direction, null);
});

test("an unmatched slot learns how its colours sit from the catalogue", () => {
    // The AMS reports which colours are on the filament but not whether they
    // fade into each other or run side by side, so for a slot with no Spoolman
    // spool yet the catalogue entry is the only source for that.
    const client = toClientSpool(uiSpool({
        existingSpool: null,
        matchingExternalFilament: {
            id: "bambulab_pla_arcticwhisper_1000_175_n",
            name: "Arctic Whisper",
            manufacturer: "Bambu Lab",
            material: "PLA",
            density: 1.24,
            diameter: 1.75,
            multi_color_direction: "longitudinal",
        },
    }));

    assert.equal(client.matchingExternalFilament.multi_color_direction, "longitudinal");
});
