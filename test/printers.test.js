import test from "node:test";
import assert from "node:assert/strict";

import { validatePrinterEntry, normalizePrinterEntry, normalizeLogDetail, traceEnabled } from "../src/printers.js";
import { settings } from "../src/settings.js";

const valid = { id: "01p00a000000000", code: "12345678", ip: "192.168.1.50", name: "P1S" };

test("validatePrinterEntry accepts a complete entry", () => {
    assert.equal(validatePrinterEntry(valid), null);
});

test("validatePrinterEntry names the missing field", () => {
    for (const field of ["id", "code", "ip", "name"]) {
        const entry = { ...valid, [field]: "  " };
        assert.match(validatePrinterEntry(entry), new RegExp(field));
    }
});

test("validatePrinterEntry rejects a serial number that is already in use", () => {
    const existing = [{ id: "01P00A000000000" }];
    assert.match(validatePrinterEntry(valid, existing), /already exists/);
});

test("validatePrinterEntry allows a printer to keep its own serial number while being edited", () => {
    const existing = [{ id: "01P00A000000000" }];
    assert.equal(validatePrinterEntry(valid, existing, "01P00A000000000"), null);
});

test("normalizePrinterEntry trims and upper cases the serial number", () => {
    const normalized = normalizePrinterEntry({ id: " 01p00a000000000 ", code: " 12345678 ", ip: " 192.168.1.50 ", name: " P1S " });

    assert.deepEqual(normalized, { id: "01P00A000000000", code: "12345678", ip: "192.168.1.50", name: "P1S" });
});

test("normalizePrinterEntry leaves a printer without an override unchanged on disk", () => {
    // A printer that follows the global log settings keeps printers.json exactly
    // as short as it was before the override existed
    assert.equal("logDetail" in normalizePrinterEntry(valid), false);
    assert.equal("logDetail" in normalizePrinterEntry({ ...valid, logDetail: {} }), false);
});

test("normalizeLogDetail keeps only what the schema knows", () => {
    const detail = normalizeLogDetail({
        level: "trace",
        categories: ["MQTT", "telepathy", "mqtt"],
        mqttTrace: true,
        somethingElse: 1,
    });

    assert.deepEqual(detail, { level: "trace", categories: ["mqtt"], mqttTrace: true });
});

test("normalizeLogDetail drops an unusable level instead of refusing the printer", () => {
    // An entry written by a newer version, or edited by hand, must never be able
    // to stop a printer from loading. A dropped field inherits the global value.
    assert.deepEqual(normalizeLogDetail({ level: "loud" }), {});
    assert.deepEqual(normalizeLogDetail({ categories: "mqtt" }), {});
    assert.deepEqual(normalizeLogDetail(null), {});
    assert.deepEqual(normalizeLogDetail(["trace"]), {});
});

test("normalizeLogDetail keeps an empty category list", () => {
    // Which is how "no debug output from this printer at all" is stored, and is
    // a different thing from having no override
    assert.deepEqual(normalizeLogDetail({ categories: [] }), { categories: [] });
});

test("traceEnabled falls back to the global switch only when the printer has no opinion", () => {
    const before = settings.MQTT_TRACE;
    try {
        settings.MQTT_TRACE = true;
        assert.equal(traceEnabled({ logDetail: {} }), true);
        assert.equal(traceEnabled({ logDetail: { mqttTrace: false } }), false);

        settings.MQTT_TRACE = false;
        assert.equal(traceEnabled({ logDetail: {} }), false);
        assert.equal(traceEnabled({ logDetail: { mqttTrace: true } }), true);
    } finally {
        settings.MQTT_TRACE = before;
    }
});
