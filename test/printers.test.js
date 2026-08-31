import test from "node:test";
import assert from "node:assert/strict";

import { validatePrinterEntry, normalizePrinterEntry } from "../src/printers.js";

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
