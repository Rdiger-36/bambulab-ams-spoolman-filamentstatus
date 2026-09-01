import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { startTestApp, call } from "./helpers/app.js";

// Its own app, and therefore its own empty data directory: the point of the
// acknowledgement is that it writes settings.json without putting a single
// value in it, which can only be checked while nothing else has been saved.
let app;

before(async () => { app = await startTestApp(); });
after(async () => { await app.close(); });

test("the deprecation notice is served with the variables it found", async () => {
    const { status, body } = await call(`${app.url}/api/notices`);

    assert.equal(status, 200);
    // Whether it is active depends on the environment the tests run in, the
    // shape does not.
    assert.equal(typeof body["env-config"].active, "boolean");
    assert.ok(Array.isArray(body["env-config"].variables));
    assert.equal(body["env-config"].acknowledged, false);
});

test("acknowledging the notice does not hand a single setting to the file", async () => {
    const before = await call(`${app.url}/api/settings`);
    assert.equal(app.readJson("settings.json"), null);

    const { status, body } = await call(`${app.url}/api/notices/env-config/ack`, "POST", {});
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    // Storing the acknowledgement beside the values rather than among them is
    // what keeps this true: the file now exists, but owns nothing, so every
    // environment variable still seeds its setting exactly as before.
    const stored = app.readJson("settings.json");
    assert.deepEqual(stored.values, {});
    assert.equal(stored.notices["env-config"], true);

    const after = await call(`${app.url}/api/settings`);
    assert.deepEqual(after.body.sources, before.body.sources);
    assert.equal((await call(`${app.url}/api/notices`)).body["env-config"].acknowledged, true);
});

test("a saved setting survives an acknowledgement written after it", async () => {
    await call(`${app.url}/api/settings`, "PUT", { MAX_RETRIES: 4 });
    await call(`${app.url}/api/notices/env-config/ack`, "POST", {});

    const stored = app.readJson("settings.json");
    assert.equal(stored.values.MAX_RETRIES, 4);
    assert.equal(stored.notices["env-config"], true);
});

test("an unknown notice is refused", async () => {
    const { status } = await call(`${app.url}/api/notices/whatever/ack`, "POST", {});
    assert.equal(status, 404);
});
