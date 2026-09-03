import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

import { startTestApp } from "./helpers/app.js";

// config.js reads DATA_DIR and LOG_DIR when it is first imported, so they are
// pointed at a temporary directory before anything under src/ is loaded. See
// test/auth.test.js, which does the same for the same reason.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-apikeys-"));
process.env.DATA_DIR = path.join(tempDir, "printers");
process.env.LOG_DIR = path.join(tempDir, "logs");
fs.ensureDirSync(process.env.DATA_DIR);
fs.ensureDirSync(process.env.LOG_DIR);

const {
    apiKeyFromRequest,
    createApiKey,
    hashApiKey,
    listApiKeys,
    removeApiKey,
    resetApiKeyCache,
    verifyApiKey,
} = await import("../src/apikeys.js");
const { hashPassword } = await import("../src/passwords.js");
const { settings } = await import("../src/settings.js");
const { apiKeysPath } = await import("../src/config.js");

test.after(() => fs.removeSync(tempDir));

/** Leaves the key file and the shared settings as this file found them. */
function reset() {
    settings.AUTH_PASSWORD = null;
    fs.removeSync(apiKeysPath);
    resetApiKeyCache();
}

test("a key is created once, stored as a hash and verified against it", () => {
    reset();
    try {
        const created = createApiKey("Home Assistant");
        assert.equal(created.ok, true);
        assert.match(created.key, /^ams_[\w-]{40,}$/);
        // What the caller is handed back never carries the hash
        assert.equal(created.entry.hash, undefined);

        assert.equal(verifyApiKey(created.key)?.name, "Home Assistant");
        assert.equal(verifyApiKey(`${created.key}x`), null);
        assert.equal(verifyApiKey(""), null);
        assert.equal(verifyApiKey(undefined), null);

        // The file carries the hash and not the key
        const stored = fs.readJsonSync(apiKeysPath);
        assert.equal(stored.length, 1);
        assert.equal(stored[0].hash, hashApiKey(created.key));
        assert.equal(JSON.stringify(stored).includes(created.key), false);

        // And what a client is shown leaves the hash out
        assert.deepEqual(Object.keys(listApiKeys()[0]).sort(), ["createdAt", "id", "lastUsedAt", "name"]);
    } finally {
        reset();
    }
});

test("two keys are generated differently and each is only itself", () => {
    reset();
    try {
        const first = createApiKey("first");
        const second = createApiKey("second");
        assert.notEqual(first.key, second.key);

        assert.equal(verifyApiKey(first.key).name, "first");
        assert.equal(verifyApiKey(second.key).name, "second");
    } finally {
        reset();
    }
});

test("a name is required and has to be unique", () => {
    reset();
    try {
        assert.equal(createApiKey("").ok, false);
        assert.equal(createApiKey("   ").ok, false);
        assert.equal(createApiKey("x".repeat(65)).ok, false);

        assert.equal(createApiKey(" Node-RED ").ok, true);
        // Trimmed on the way in, so the list shows what was meant
        assert.equal(listApiKeys()[0].name, "Node-RED");
        // And a second key under the same name would leave a list nobody can
        // revoke the right half of
        assert.equal(createApiKey("node-red").ok, false);
    } finally {
        reset();
    }
});

test("revoking one key leaves the others working", () => {
    reset();
    try {
        const kept = createApiKey("kept");
        const gone = createApiKey("gone");

        const removed = removeApiKey(gone.entry.id);
        assert.equal(removed.name, "gone");
        assert.equal(removed.hash, undefined);
        assert.equal(removeApiKey(gone.entry.id), null);

        assert.equal(verifyApiKey(gone.key), null);
        assert.equal(verifyApiKey(kept.key).name, "kept");
        assert.equal(listApiKeys().length, 1);
    } finally {
        reset();
    }
});

test("the last use is recorded, and not on every single request", () => {
    reset();
    try {
        const created = createApiKey("polling");
        assert.equal(listApiKeys()[0].lastUsedAt, null);

        const start = Date.parse("2026-09-03T10:00:00.000Z");
        verifyApiKey(created.key, start);
        assert.equal(listApiKeys()[0].lastUsedAt, new Date(start).toISOString());

        // A home automation polls several times a minute; that must not rewrite
        // the file every time
        verifyApiKey(created.key, start + 5000);
        assert.equal(listApiKeys()[0].lastUsedAt, new Date(start).toISOString());

        const later = start + 90 * 1000;
        verifyApiKey(created.key, later);
        assert.equal(listApiKeys()[0].lastUsedAt, new Date(later).toISOString());
    } finally {
        reset();
    }
});

test("the key is read out of both headers and out of nothing else", () => {
    assert.equal(apiKeyFromRequest({ headers: { authorization: "Bearer ams_abc" } }), "ams_abc");
    assert.equal(apiKeyFromRequest({ headers: { authorization: "bearer   ams_abc  " } }), "ams_abc");
    assert.equal(apiKeyFromRequest({ headers: { "x-api-key": "ams_abc" } }), "ams_abc");
    assert.equal(apiKeyFromRequest({ headers: { authorization: "Basic ams_abc" } }), undefined);
    assert.equal(apiKeyFromRequest({ headers: {} }), undefined);
    assert.equal(apiKeyFromRequest({}), undefined);
});

test("a key opens the API while a password is set, and only the right one does", async () => {
    reset();
    const app = await startTestApp();
    // The app helper points DATA_DIR at its own directory, so the keys created
    // here live there rather than in the one this file set up.
    resetApiKeyCache();
    settings.AUTH_PASSWORD = hashPassword("secret");

    try {
        const created = createApiKey("Home Assistant");

        assert.equal((await fetch(`${app.url}/api/settings`)).status, 401);

        for (const header of [{ Authorization: `Bearer ${created.key}` }, { "X-API-Key": created.key }]) {
            const allowed = await fetch(`${app.url}/api/settings`, { headers: header });
            assert.equal(allowed.status, 200, JSON.stringify(header));
        }

        const wrong = await fetch(`${app.url}/api/settings`, { headers: { Authorization: "Bearer ams_nope" } });
        assert.equal(wrong.status, 401);

        // A key writes as well, which is the point of it
        const write = await fetch(`${app.url}/api/monitoring/stop`, {
            method: "POST",
            headers: { "X-API-Key": created.key, "Content-Type": "application/json" },
            body: "{}",
        });
        assert.equal(write.status, 200);

        // Revoked through the API, with the key itself: a key is a full session
        const revoked = await fetch(`${app.url}/api/apikeys/${created.entry.id}`, {
            method: "DELETE",
            headers: { "X-API-Key": created.key },
        });
        assert.equal(revoked.status, 200);
        assert.equal((await revoked.json()).keys.length, 0);

        assert.equal((await fetch(`${app.url}/api/settings`, { headers: { "X-API-Key": created.key } })).status, 401);
    } finally {
        settings.AUTH_PASSWORD = null;
        resetApiKeyCache();
        await app.close();
    }
});

test("the API creates a key, shows it once and never again", async () => {
    reset();
    const app = await startTestApp();
    resetApiKeyCache();

    try {
        const created = await (await fetch(`${app.url}/api/apikeys`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Node-RED" }),
        })).json();

        assert.equal(created.ok, true);
        assert.match(created.key, /^ams_/);

        const listed = await (await fetch(`${app.url}/api/apikeys`)).json();
        assert.equal(listed.keys.length, 1);
        assert.equal(listed.keys[0].name, "Node-RED");
        // Neither the key nor its hash is ever listed again
        assert.equal(JSON.stringify(listed).includes(created.key), false);
        assert.equal(listed.keys[0].hash, undefined);

        const duplicate = await fetch(`${app.url}/api/apikeys`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Node-RED" }),
        });
        assert.equal(duplicate.status, 400);

        assert.equal((await fetch(`${app.url}/api/apikeys/nope`, { method: "DELETE" })).status, 404);
    } finally {
        resetApiKeyCache();
        await app.close();
    }
});
