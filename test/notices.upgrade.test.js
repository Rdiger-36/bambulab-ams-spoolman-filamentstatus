import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { startTestApp, call } from "./helpers/app.js";

// Its own app, started on what a 1.2.x installation leaves behind: a
// printers.json and no settings.json. That is the whole signal the upgrade
// notice goes on, so it cannot share a data directory with a suite that has
// saved anything.
let app;

before(async () => {
    app = await startTestApp({
        seedPrinters: [{ id: "01P00A000000001", code: "12345678", ip: "127.0.0.1", name: "Test Printer" }],
    });
});
after(async () => { await app.close(); });

test("a printers.json without a settings.json raises the upgrade notice", async () => {
    const { status, body } = await call(`${app.url}/api/notices`);

    assert.equal(status, 200);
    assert.equal(body["upgrade-1.3.0"].active, true);
    assert.equal(body["upgrade-1.3.0"].acknowledged, false);
    assert.match(body["upgrade-1.3.0"].docs, /^https:\/\//);
    // Nothing has been written for it: the mark is held in memory until
    // something else writes the file.
    assert.equal(app.readJson("settings.json"), null);
});

test("a save before the dashboard was opened carries the pending notice into the file", async () => {
    const { status } = await call(`${app.url}/api/settings`, "PUT", { MAX_RETRIES: 4 });
    assert.equal(status, 200);

    // Persisted as pending, so a restart after this save, which finds a
    // settings.json and would not raise the notice again on its own, still
    // shows it.
    const stored = app.readJson("settings.json");
    assert.equal(stored.values.MAX_RETRIES, 4);
    assert.equal(stored.notices["upgrade-1.3.0"], false);
    assert.equal((await call(`${app.url}/api/notices`)).body["upgrade-1.3.0"].active, true);
});

test("dismissing it stores the acknowledgement and ends the notice", async () => {
    const { status, body } = await call(`${app.url}/api/notices/upgrade-1.3.0/ack`, "POST", {});
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const stored = app.readJson("settings.json");
    assert.equal(stored.notices["upgrade-1.3.0"], true);
    assert.equal(stored.values.MAX_RETRIES, 4);

    const notice = (await call(`${app.url}/api/notices`)).body["upgrade-1.3.0"];
    assert.equal(notice.active, false);
    assert.equal(notice.acknowledged, true);
});
