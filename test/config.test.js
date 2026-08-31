import test from "node:test";
import assert from "node:assert/strict";

import { resolveMode } from "../src/config.js";

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
