import test from "node:test";
import assert from "node:assert/strict";

import { deprecationLogLines, ENV_CONFIG_NOTICE } from "../src/deprecation.js";

// deprecationLogLines is fed a notice rather than reading the environment, so
// these cases do not depend on what is set on the machine running them.

test("nothing is logged when no deprecated configuration is in use", () => {
    assert.deepEqual(deprecationLogLines({ active: false, variables: [], printerVariables: [] }), []);
});

test("the log names the variables that are still in charge", () => {
    const lines = deprecationLogLines({
        active: true,
        variables: ["MODE", "UPDATE_INTERVAL"],
        printerVariables: [],
        printerVariablesIgnored: false,
    });

    assert.ok(lines.some(line => line.includes("deprecated since 1.3.0")));
    assert.ok(lines.some(line => line.includes("MODE, UPDATE_INTERVAL")));
    // Deprecated, not removed. The line has to say so, because it is the only
    // thing most users will ever read about this.
    assert.ok(lines.some(line => line.includes("keeps working")));
});

test("a seeding printer list and an ignored one read differently", () => {
    const seeding = deprecationLogLines({
        active: true,
        variables: [],
        printerVariables: ["PRINTER_ID", "PRINTER_CODE", "PRINTER_IP"],
        printerVariablesIgnored: false,
    });
    const ignored = deprecationLogLines({
        active: true,
        variables: [],
        printerVariables: ["PRINTER_ID", "PRINTER_CODE", "PRINTER_IP"],
        printerVariablesIgnored: true,
    });

    assert.ok(seeding.some(line => line.includes("seeded from")));
    assert.ok(ignored.some(line => line.includes("no effect")));
});

test("the notice id is the one the Web UI acknowledges", () => {
    assert.equal(ENV_CONFIG_NOTICE, "env-config");
});
