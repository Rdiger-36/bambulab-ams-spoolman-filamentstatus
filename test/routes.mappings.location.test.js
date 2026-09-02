import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { startTestApp, call } from "./helpers/app.js";

// Assigning and unassigning a spool used to leave the Spoolman location
// untouched: an assigned 3rd party spool never got one, and an unassigned one
// kept naming the slot it had left forever. Both go through src/location.js now,
// and these tests watch what reaches Spoolman.

const patches = [];
const spools = new Map();

const spoolman = http.createServer((req, res) => {
    const path = req.url.split("?")[0];

    if (req.method === "GET" && path === "/api/v1/spool") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify([...spools.values()]));
    }

    const id = Number(path.split("/").pop());

    if (req.method === "GET") {
        const spool = spools.get(id);
        res.writeHead(spool ? 200 : 404, { "content-type": "application/json" });
        return res.end(JSON.stringify(spool ?? { detail: "not found" }));
    }

    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
        const payload = JSON.parse(body || "{}");
        patches.push({ id, payload });
        const spool = spools.get(id);
        if (spool) Object.assign(spool, payload);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(spool ?? { id, ...payload }));
    });
});

await new Promise(resolve => spoolman.listen(0, "127.0.0.1", resolve));

// Read at import time by settings.js, so it has to be set before startTestApp
// pulls the modules in.
process.env.SPOOLMAN_ENDPOINT = `http://127.0.0.1:${spoolman.address().port}`;
process.env.SET_LOCATION = "true";
process.env.LEGACY_MODE = "false";

const SERIAL = "01P00A000000012";

let app;
let printer;

before(async () => {
    app = await startTestApp({
        seedPrinters: [{ id: SERIAL, code: "12345678", ip: "127.0.0.1", name: "Test Printer" }],
    });

    const { printers } = await import("../src/printers.js");
    printer = printers.find(p => p.id === SERIAL);
    printer.currentGcodeState = "IDLE";
});

after(async () => {
    await app.close();
    await new Promise(resolve => spoolman.close(resolve));
});

/** Puts a spool into the fake Spoolman. */
function seed(id, location = null) {
    spools.set(id, { id, location, remaining_weight: 500, filament: { name: `spool ${id}` } });
    return spools.get(id);
}

/** Points the cached slot A0 at a spool, the way an AMS update would. */
function slotHolds(spool) {
    printer.spoolData = [{
        amsId: "A0",
        slotState: "Loaded (3rd party)",
        slot: { tray_uuid: "N/A", tray_type: "PLA", tray_color: "FF0000FF" },
        existingSpool: spool ? { ...spool } : null,
        connectedViaMapping: !!spool,
        connectedViaTag: false,
    }];
}

beforeEach(async () => {
    patches.length = 0;
    spools.clear();
    slotHolds(null);
    await call(`${app.url}/api/mappings/${SERIAL}/A0`, "DELETE");
    patches.length = 0;
});

test("assigning a spool writes the slot as its location", async () => {
    seed(1);

    const { status } = await call(`${app.url}/api/mappings/${SERIAL}/A0`, "PUT", { spoolId: 1 });

    assert.equal(status, 200);
    assert.deepEqual(patches, [{ id: 1, payload: { location: "Test Printer - A0" } }]);
});

test("unassigning a spool clears the location again", async () => {
    const spool = seed(1, "Test Printer - A0");
    slotHolds(spool);

    const { status, body } = await call(`${app.url}/api/mappings/${SERIAL}/A0`, "PUT", { spoolId: 1 });
    assert.equal(status, 200);
    assert.ok(body.ok);
    patches.length = 0;

    const removed = await call(`${app.url}/api/mappings/${SERIAL}/A0`, "DELETE");

    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);
    assert.deepEqual(patches, [{ id: 1, payload: { location: "" } }]);
});

test("unassigning leaves a location the user set by hand alone", async () => {
    const spool = seed(1, "Shelf A");
    slotHolds(spool);
    await call(`${app.url}/api/mappings/${SERIAL}/A0`, "PUT", { spoolId: 1 });
    // The assignment claimed the slot, so put the hand-set location back the way
    // a user editing it in Spoolman afterwards would.
    spools.get(1).location = "Shelf A";
    slotHolds(spools.get(1));
    patches.length = 0;

    await call(`${app.url}/api/mappings/${SERIAL}/A0`, "DELETE");

    assert.deepEqual(patches, []);
    assert.equal(spools.get(1).location, "Shelf A");
});

test("reassigning a slot moves the location from the old spool to the new one", async () => {
    const previous = seed(1, "Test Printer - A0");
    seed(2);
    slotHolds(previous);
    await call(`${app.url}/api/mappings/${SERIAL}/A0`, "PUT", { spoolId: 1 });
    patches.length = 0;

    await call(`${app.url}/api/mappings/${SERIAL}/A0`, "PUT", { spoolId: 2 });

    assert.deepEqual(patches, [
        { id: 1, payload: { location: "" } },
        { id: 2, payload: { location: "Test Printer - A0" } },
    ]);
});

test("unassigning a slot that had nothing assigned writes nothing", async () => {
    seed(1, "Test Printer - A0");

    const { status, body } = await call(`${app.url}/api/mappings/${SERIAL}/A0`, "DELETE");

    assert.equal(status, 200);
    assert.equal(body.removed, false);
    assert.deepEqual(patches, []);
});

test("a rejected assignment writes no location", async () => {
    // Spool 7 is not in Spoolman, so the route answers 404 before anything is
    // stored, and nothing may have been written on the way there either.
    const { status } = await call(`${app.url}/api/mappings/${SERIAL}/A0`, "PUT", { spoolId: 7 });

    assert.equal(status, 404);
    assert.deepEqual(patches, []);
});
