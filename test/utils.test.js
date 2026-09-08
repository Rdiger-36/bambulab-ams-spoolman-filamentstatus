import test from "node:test";
import assert from "node:assert/strict";

import { convertAMSandSlot, EXTERNAL_SLOT, SECOND_EXTERNAL_SLOT, describeConnectionError } from "../src/utils.js";

test("a unit's slots are labelled the way the printer counts them", () => {
    // MQTT counts a unit's slots from 0, the printer's display and Bambu Studio
    // from 1. The label is read next to that hardware, so it says the same.
    assert.deepEqual([0, 1, 2, 3].map(slot => convertAMSandSlot(0, slot)), ["A1", "A2", "A3", "A4"]);
    assert.equal(convertAMSandSlot(3, 3), "D4");
    // The ids arrive as strings in some reports and as numbers in others
    assert.equal(convertAMSandSlot("1", "0"), "B1");
});

test("a unit without a slot is the unit's own label", () => {
    // What the AMS environment readings are keyed by: the unit, not a slot in it
    assert.equal(convertAMSandSlot(0, null), "A");
    assert.equal(convertAMSandSlot(1, null), "B");
});

test("the single slot units carry no slot number", () => {
    assert.equal(convertAMSandSlot(128, 0), "HT-A");
    assert.equal(convertAMSandSlot(135, 0), "HT-H");
    assert.equal(convertAMSandSlot(255, 0), EXTERNAL_SLOT);
    // The second holder of a dual nozzle printer, unit 254 in its report
    assert.equal(convertAMSandSlot(254, 0), SECOND_EXTERNAL_SLOT);
    assert.equal(convertAMSandSlot("254", "254"), SECOND_EXTERNAL_SLOT);
});

test("a unit outside the known ranges is marked as unaddressable", () => {
    assert.equal(convertAMSandSlot(4, 0), "Z");
    assert.equal(convertAMSandSlot(127, 0), "Z");
});

/* ---- describeConnectionError ---- */

test("the four connection failures read the same wherever a socket is opened", () => {
    assert.equal(describeConnectionError(new Error("connect ECONNREFUSED 192.168.1.250:8883"), { port: 8883 }), "Port 8883 refused the connection");
    assert.equal(describeConnectionError(new Error("connect ECONNREFUSED"), { port: 990, refusedHint: "Is FTP access enabled on the printer?" }), "Port 990 refused the connection. Is FTP access enabled on the printer?");
    assert.equal(describeConnectionError(new Error("Timeout awaiting 'request' for 5000ms")), "No answer within the timeout");
    assert.equal(describeConnectionError(new Error("connect ETIMEDOUT"), { port: 8883, timeoutHint: "Is LAN mode enabled?" }), "No answer on port 8883 within the timeout. Is LAN mode enabled?");
    assert.equal(describeConnectionError(new Error("connect EHOSTUNREACH 10.0.0.9")), "The address cannot be reached");
    assert.equal(describeConnectionError(new Error("getaddrinfo ENOTFOUND spoolman")), "The host name cannot be resolved");
    // Anything else is the caller's to describe
    assert.equal(describeConnectionError(new Error("Not authorized")), null);
    assert.equal(describeConnectionError("Response code 404 (Not Found)"), null);
});
