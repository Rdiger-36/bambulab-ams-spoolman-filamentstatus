import test from "node:test";
import assert from "node:assert/strict";

import { resolveMode, coerceSetting, resolveSettings, describeSources, settings, legacyMode, legacyModeNeedsRestart } from "../src/settings.js";

test('resolveMode accepts "automatic"', () => {
    assert.deepEqual(resolveMode("automatic"), { raw: "automatic", mode: "automatic", valid: true });
});

test('resolveMode accepts "auto" as a shorthand', () => {
    // Documented as "automatic", but "auto" is the obvious thing to type and
    // used to fall through to manual behaviour without any hint.
    assert.equal(resolveMode("auto").mode, "automatic");
    assert.equal(resolveMode("auto").valid, true);
});

test("resolveMode ignores surrounding whitespace and case", () => {
    assert.equal(resolveMode("  Automatic ").mode, "automatic");
    assert.equal(resolveMode("MANUAL").mode, "manual");
});

test("resolveMode falls back to manual and flags an unrecognised value", () => {
    const r = resolveMode("atomatic");
    assert.equal(r.mode, "manual");
    assert.equal(r.valid, false);
    assert.equal(r.raw, "atomatic");
});

test("resolveMode defaults to manual when unset", () => {
    assert.deepEqual(resolveMode(undefined), { raw: "manual", mode: "manual", valid: true });
    assert.deepEqual(resolveMode(""), { raw: "manual", mode: "manual", valid: true });
});

test("coerceSetting clamps an integer into its documented range", () => {
    assert.equal(coerceSetting("UPDATE_INTERVAL", "1000").value, 5000);
    assert.equal(coerceSetting("UPDATE_INTERVAL", 999999).value, 300000);
    assert.equal(coerceSetting("UPDATE_INTERVAL", "30000").value, 30000);
});

test("coerceSetting rejects a number that is not one", () => {
    assert.ok(coerceSetting("MAX_RETRIES", "soon").error);
});

test("coerceSetting reads a boolean from both a string and a real boolean", () => {
    assert.equal(coerceSetting("DEBUG", "true").value, true);
    assert.equal(coerceSetting("DEBUG", false).value, false);
    assert.ok(coerceSetting("DEBUG", "maybe").error);
});

test("coerceSetting turns an empty string into null for a text field", () => {
    assert.equal(coerceSetting("SPOOLMAN_SUBFOLDER", "  ").value, null);
});

test("coerceSetting rejects an unknown field", () => {
    assert.ok(coerceSetting("SPOOLMAN_PASSWORD", "x").error);
});

test("resolveSettings layers default, environment and file in that order", () => {
    const resolved = resolveSettings(
        { MAX_RETRIES: 5 },
        { MAX_RETRIES: "9", SET_LOCATION: "true" },
    );

    // The file wins over the environment variable that seeded it.
    assert.equal(resolved.MAX_RETRIES, 5);
    // A field the file does not mention still honours its environment variable.
    assert.equal(resolved.SET_LOCATION, true);
    // Everything else falls back to the documented default.
    assert.equal(resolved.UPDATE_INTERVAL, 120000);
    assert.equal(resolved.MODE, "manual");
});

test("resolveSettings keeps the layer below an unusable value and reports it", () => {
    const issues = [];
    const resolved = resolveSettings({ MAX_RETRIES: "later" }, { MAX_RETRIES: "3" }, issues);

    assert.equal(resolved.MAX_RETRIES, 3);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /MAX_RETRIES/);
});

test("describeSources names where each value came from", () => {
    const sources = describeSources({ MODE: "automatic" }, { DEBUG: "true" });

    assert.equal(sources.MODE, "file");
    assert.equal(sources.DEBUG, "environment");
    assert.equal(sources.SET_LOCATION, "default");
});

test("the tracking mode is frozen at startup", () => {
    // The two tracking modes book consumption differently, so switching one
    // into a running process would book a print in flight twice or not at all.
    // Saving changes what is stored; only a restart changes what is running.
    const running = legacyMode();
    const stored = settings.LEGACY_MODE;

    try {
        settings.LEGACY_MODE = !stored;

        assert.equal(legacyMode(), running);
        assert.equal(legacyModeNeedsRestart(), true);

        settings.LEGACY_MODE = running;
        assert.equal(legacyModeNeedsRestart(), false);
    } finally {
        settings.LEGACY_MODE = stored;
    }
});
