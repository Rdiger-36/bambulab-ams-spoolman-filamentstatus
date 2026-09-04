import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { startTestApp, call } from "./helpers/app.js";

// PATCH /api/spoolman/spool/:id is the write path behind the spool detail
// dialog. It accepts three fields and refuses the remaining weight whenever
// something else is about to write that same number: a running print books its
// consumption onto the spool when it ends, and legacy mode writes the weight
// from the AMS RFID reading (covered in routes.spooledit.legacy.test.js).
//
// Nothing here reaches Spoolman: every case below is refused before the request
// would be made, which is what makes it testable without a Spoolman instance.

let app;
let printer;

const SERIAL = "01P00A000000010";
const SPOOL_ID = 42;

before(async () => {
    app = await startTestApp({
        seedPrinters: [{ id: SERIAL, code: "12345678", ip: "127.0.0.1", name: "Test Printer" }],
    });

    const { printers } = await import("../src/printers.js");
    printer = printers.find(p => p.id === SERIAL);
    printer.currentGcodeState = "IDLE";
    printer.spoolData = [{
        amsId: "A1",
        slotState: "Loaded (Bambu Lab)",
        existingSpool: { id: SPOOL_ID, remaining_weight: 500, filament: { name: "spool 42" } },
        slot: { tray_uuid: "uuid-A1" },
    }];
});

after(async () => { await app.close(); });

test("a spool id that is not a positive integer is refused", async () => {
    const read = await call(`${app.url}/api/spoolman/spool/nope`);
    assert.equal(read.status, 400);

    const write = await call(`${app.url}/api/spoolman/spool/0`, "PATCH", { comment: "x" });
    assert.equal(write.status, 400);
});

test("a negative remaining weight is refused", async () => {
    const { status, body } = await call(`${app.url}/api/spoolman/spool/${SPOOL_ID}`, "PATCH", { remainingWeight: -1 });

    assert.equal(status, 400);
    assert.match(body.error, /remaining weight/i);
});

test("a request that carries no editable field is refused", async () => {
    // Everything but the four editable fields is dropped, so a payload of only
    // unknown fields must not reach Spoolman as an empty patch.
    const { status, body } = await call(`${app.url}/api/spoolman/spool/${SPOOL_ID}`, "PATCH", { price: 5, vendor: "someone" });

    assert.equal(status, 400);
    assert.equal(body.error, "Nothing to change");
});

test("the archived flag has to be a boolean", async () => {
    // A form that sends "false" as a string would otherwise archive the spool,
    // because every non empty string is truthy.
    const { status, body } = await call(`${app.url}/api/spoolman/spool/${SPOOL_ID}`, "PATCH", { archived: "false" });

    assert.equal(status, 400);
    assert.match(body.error, /archived flag/i);
});

test("the remaining weight cannot be changed while the spool is in a running print", async () => {
    printer.currentGcodeState = "RUNNING";

    const blocked = await call(`${app.url}/api/spoolman/spool/${SPOOL_ID}`, "PATCH", { remainingWeight: 800 });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.printInFlight, true);
    assert.match(blocked.body.error, /Test Printer is printing \(RUNNING\)/);

    // A spool that is not loaded in that printer is unaffected: the block is
    // about the spool being consumed, not about the printer being busy.
    const other = await call(`${app.url}/api/spoolman/spool/${SPOOL_ID + 1}`, "PATCH", { remainingWeight: 800 });
    assert.notEqual(other.status, 409);

    printer.currentGcodeState = "IDLE";
});
