import test from "node:test";
import assert from "node:assert/strict";

import { upgradeLogLines, UPGRADE_NOTICE } from "../src/upgradenotice.js";

// upgradeLogLines is fed a notice rather than reading the files, so these
// cases do not depend on what is in the data directory of the machine running
// them.

test("nothing is logged unless the notice is active", () => {
    assert.deepEqual(upgradeLogLines({ active: false, acknowledged: false, docs: "x" }), []);
    assert.deepEqual(upgradeLogLines({ active: false, acknowledged: true, docs: "x" }), []);
});

test("the log names the four things that can need the user, and where to read on", () => {
    const lines = upgradeLogLines({ active: true, acknowledged: false, docs: "https://example.test/updating" });

    assert.ok(lines.every(line => line.startsWith("[Update]")));
    assert.ok(lines.some(line => line.includes("1.2.x")));
    assert.ok(lines.some(line => line.includes("numbered from 1")));
    assert.ok(lines.some(line => line.includes("API key")));
    assert.ok(lines.some(line => line.includes("Allowed host names")));
    assert.ok(lines.some(line => line.includes("LEGACY_MODE=true")));
    assert.ok(lines.some(line => line.includes("https://example.test/updating")));
});

test("the notice id is the one the Web UI acknowledges", () => {
    assert.equal(UPGRADE_NOTICE, "upgrade-1.3.0");
});
