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
        amsId: "A0",
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
    const client = toClientSpool({ amsId: "A1", slot: {}, slotState: "Empty" });

    assert.equal(client.connectedViaTag, false);
    assert.equal(client.connectedViaMapping, false);
    assert.equal(client.correctedWeight, null);
    assert.equal(client.enableButton, "false");
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
