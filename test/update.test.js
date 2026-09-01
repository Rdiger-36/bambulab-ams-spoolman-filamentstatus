import test from "node:test";
import assert from "node:assert/strict";

import { compareVersions } from "../src/update.js";

// Only the comparison is tested. The check itself is one GET against GitHub and
// would make the suite depend on the network and on a rate limit.

test("a higher number wins", () => {
    assert.ok(compareVersions("1.4.0", "1.3.9") > 0);
    assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
    assert.equal(compareVersions("1.3.0", "1.3.0"), 0);
});

test("a release is newer than the prerelease that led up to it", () => {
    // The case the dev images live in: 1.3.0 has to be offered to 1.3.0-dev.2
    assert.ok(compareVersions("1.3.0", "1.3.0-dev.2") > 0);
    assert.ok(compareVersions("1.3.0-dev.2", "1.3.0") < 0);
});

test("prerelease numbers are compared as numbers, not as text", () => {
    assert.ok(compareVersions("1.3.0-dev.10", "1.3.0-dev.2") > 0);
});

test("a leading v is ignored", () => {
    assert.equal(compareVersions("v1.3.0", "1.3.0"), 0);
});

test("a missing part counts as zero", () => {
    assert.equal(compareVersions("1.3", "1.3.0"), 0);
    assert.ok(compareVersions("1.3.1", "1.3") > 0);
});
