// Legacy mode is read once at startup, so it has to be set before the first
// import rather than through the settings API.
process.env.LEGACY_MODE = "true";

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { startTestApp, call } from "./helpers/app.js";

// In legacy mode the service writes the remaining weight from the AMS RFID
// remain percentage on every slot change, so a value corrected by hand
// disappears again on its own. The dialog disables the field; this covers that
// a direct call is refused as well.

let app;

before(async () => { app = await startTestApp(); });
after(async () => { await app.close(); });

test("editing a spool is refused in legacy mode", async () => {
    const { status, body } = await call(`${app.url}/api/spoolman/spool/42`, "PATCH", { comment: "corrected by hand" });

    assert.equal(status, 409);
    assert.match(body.error, /Legacy mode/);
});
