import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

import { startTestApp, UI_HEADERS } from "./helpers/app.js";

// config.js reads DATA_DIR and LOG_DIR when it is first imported, so they are
// pointed at a temporary directory before anything under src/ is loaded. See
// test/security.test.js, which does the same for the same reason.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-auth-"));
process.env.DATA_DIR = path.join(tempDir, "printers");
process.env.LOG_DIR = path.join(tempDir, "logs");
fs.ensureDirSync(process.env.DATA_DIR);
fs.ensureDirSync(process.env.LOG_DIR);

const { hashPassword, isPasswordHash, verifyPassword } = await import("../src/passwords.js");
const { attemptLogin, lockoutRemaining, readCookie, signSession, verifySession } = await import("../src/auth.js");
const { exportSettings } = await import("../src/anonymize.js");
const { settings, coerceSetting, updateSettings, getSettingsView } = await import("../src/settings.js");
const { state } = await import("../src/state.js");

test.after(() => fs.removeSync(tempDir));

/** Leaves the shared settings and the lockouts as this file found them. */
function reset() {
    settings.AUTH_PASSWORD = null;
    state.loginFailures.clear();
}

test("a password is stored as a hash and verified against it", () => {
    const hash = hashPassword("a good long password");
    assert.equal(isPasswordHash(hash), true);
    assert.equal(isPasswordHash("a good long password"), false);
    assert.equal(verifyPassword("a good long password", hash), true);
    assert.equal(verifyPassword("a good long passworD", hash), false);
    assert.equal(verifyPassword("", hash), false);
    // Two hashes of the same password differ, because each carries its own salt
    assert.notEqual(hash, hashPassword("a good long password"));
});

test("verifying against something that is not a hash never throws", () => {
    for (const stored of [null, undefined, "", "plain", "scrypt$nope"]) {
        assert.equal(verifyPassword("whatever", stored), false);
    }
});

test("the setting hashes a typed password and keeps a stored hash as it is", () => {
    const typed = coerceSetting("AUTH_PASSWORD", "hunter22").value;
    assert.equal(isPasswordHash(typed), true);
    assert.equal(verifyPassword("hunter22", typed), true);

    // What reading settings.json back has to do, or every start would hash the
    // hash of the start before it.
    assert.equal(coerceSetting("AUTH_PASSWORD", typed).value, typed);
    assert.equal(coerceSetting("AUTH_PASSWORD", "").value, null);
});

test("the password is never in what a client or an export is given", () => {
    settings.AUTH_PASSWORD = hashPassword("secret");
    try {
        const view = getSettingsView();
        assert.equal(view.values.AUTH_PASSWORD, null);
        assert.equal(view.hasValue.AUTH_PASSWORD, true);

        // Both variants of the diagnostics bundle, like the access code
        for (const anonymize of [true, false]) {
            const exported = exportSettings({ AUTH_PASSWORD: settings.AUTH_PASSWORD }, anonymize);
            assert.equal(exported.AUTH_PASSWORD, "XXX");
        }
    } finally {
        reset();
    }
});

test("an empty password field keeps the stored one, an explicit null removes it", () => {
    updateSettings({ AUTH_PASSWORD: "first" });
    const stored = settings.AUTH_PASSWORD;
    assert.equal(verifyPassword("first", stored), true);

    // What the settings page sends for a field nobody typed into
    updateSettings({ AUTH_PASSWORD: "" });
    assert.equal(settings.AUTH_PASSWORD, stored);

    updateSettings({ AUTH_PASSWORD: null });
    assert.equal(settings.AUTH_PASSWORD, null);
});

test("a session is signed, expires, and dies with the password it was signed under", () => {
    settings.AUTH_PASSWORD = hashPassword("secret");
    try {
        const cookie = signSession(Date.now() + 60000);
        assert.equal(verifySession(cookie), true);

        // Expiry is inside the signed value, so it cannot be moved
        assert.equal(verifySession(signSession(Date.now() - 1)), false);
        assert.equal(verifySession(`${Date.now() + 60000}.deadbeef`), false);
        assert.equal(verifySession("nonsense"), false);
        assert.equal(verifySession(undefined), false);

        // The signing key comes from the stored hash, so changing the password
        // invalidates every session that exists.
        settings.AUTH_PASSWORD = hashPassword("another secret");
        assert.equal(verifySession(cookie), false);
    } finally {
        reset();
    }
});

test("one cookie is read out of a header carrying several", () => {
    assert.equal(readCookie("theme=dark; ams_session=abc; other=1", "ams_session"), "abc");
    assert.equal(readCookie("ams_session=abc", "ams_session"), "abc");
    assert.equal(readCookie("theme=dark", "ams_session"), undefined);
    assert.equal(readCookie(undefined, "ams_session"), undefined);
});

test("repeated wrong passwords lock an address out, a right one clears it", () => {
    settings.AUTH_PASSWORD = hashPassword("secret");
    try {
        const now = Date.now();
        for (let attempt = 0; attempt < 5; attempt++) {
            assert.equal(attemptLogin("wrong", "10.0.0.5", now).retryAfter, 0, `attempt ${attempt}`);
        }

        // The sixth is where the wait starts
        const locked = attemptLogin("wrong", "10.0.0.5", now);
        assert.ok(locked.retryAfter > 0);
        // Even the right password has to wait it out, or the lockout would be
        // no obstacle to a list that happens to contain the password.
        assert.equal(attemptLogin("secret", "10.0.0.5", now).ok, false);

        // Another address is unaffected
        assert.equal(attemptLogin("secret", "10.0.0.6", now).ok, true);

        // After the wait, the right password is accepted and clears the record
        const later = now + lockoutRemaining("10.0.0.5", now) + 1;
        assert.equal(attemptLogin("secret", "10.0.0.5", later).ok, true);
        assert.equal(lockoutRemaining("10.0.0.5", later), 0);
    } finally {
        reset();
    }
});

test("without a password the Web UI is open and the API still wants a key", async () => {
    const app = await startTestApp();
    try {
        // The Web UI, which the browser marks as coming from this same page
        assert.equal((await fetch(`${app.url}/api/settings`, { headers: UI_HEADERS })).status, 200);
        // A caller that is not the Web UI and carries no key. This is the rule
        // that changed: it used to be answered.
        const script = await fetch(`${app.url}/api/settings`);
        assert.equal(script.status, 401);
        assert.equal((await script.json()).apiKeyRequired, true);
        // And a browser that was pointed at the URL by hand rather than by the
        // Web UI is that same caller
        assert.equal((await fetch(`${app.url}/api/settings`, { headers: { "Sec-Fetch-Site": "none" } })).status, 401);

        const state = await (await fetch(`${app.url}/api/auth/state`)).json();
        assert.deepEqual(state, { required: false, authenticated: true });
    } finally {
        await app.close();
    }
});

test("with a password set, the API answers 401 until the login succeeds", async () => {
    const app = await startTestApp();
    settings.AUTH_PASSWORD = hashPassword("secret");
    try {
        const refused = await fetch(`${app.url}/api/settings`);
        assert.equal(refused.status, 401);
        assert.equal((await refused.json()).authRequired, true);

        const wrong = await fetch(`${app.url}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "not it" }),
        });
        assert.equal(wrong.status, 401);

        const ok = await fetch(`${app.url}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "secret" }),
        });
        assert.equal(ok.status, 200);

        const cookie = ok.headers.getSetCookie().join("; ");
        assert.match(cookie, /ams_session=/);
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /SameSite=Lax/i);

        const allowed = await fetch(`${app.url}/api/settings`, { headers: { Cookie: cookie } });
        assert.equal(allowed.status, 200);

        // And the session ends when the browser is told to drop it
        const out = await fetch(`${app.url}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } });
        assert.match(out.headers.getSetCookie().join("; "), /ams_session=;/);
    } finally {
        reset();
        await app.close();
    }
});

test("setting a password hands the caller a session instead of locking them out", async () => {
    const app = await startTestApp();
    try {
        const view = await (await fetch(`${app.url}/api/settings`, { headers: UI_HEADERS })).json();
        const saved = await fetch(`${app.url}/api/settings`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...UI_HEADERS },
            body: JSON.stringify({ revision: view.revision, values: { AUTH_PASSWORD: "a good long password" } }),
        });
        assert.equal(saved.status, 200);

        // Every session that existed is void, because the signing key comes
        // from the hash. The one handed back here is signed with the new one.
        const cookie = saved.headers.getSetCookie().join("; ");
        assert.match(cookie, /ams_session=/);
        assert.equal((await fetch(`${app.url}/api/settings`, { headers: UI_HEADERS })).status, 401);
        assert.equal((await fetch(`${app.url}/api/settings`, { headers: { Cookie: cookie, ...UI_HEADERS } })).status, 200);
    } finally {
        reset();
        await app.close();
    }
});

test("the login endpoint itself stays reachable while everything else is not", async () => {
    const app = await startTestApp();
    settings.AUTH_PASSWORD = hashPassword("secret");
    try {
        const state = await fetch(`${app.url}/api/auth/state`);
        assert.equal(state.status, 200);
        assert.deepEqual(await state.json(), { required: true, authenticated: false });
    } finally {
        reset();
        await app.close();
    }
});
