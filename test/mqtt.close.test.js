import test from "node:test";
import assert from "node:assert/strict";

import { closeMqtt } from "../src/mqtt.js";

// closeMqtt marks the close as deliberate. The "close" handler reads that flag
// and says what actually happened instead of announcing a retry by the monitor
// loop, which is wrong whenever a reconnect has already been started or the
// process is shutting down.

test("a deliberate close records why, and drops the client", () => {
    let ended = null;
    const printer = {
        mqttClient: { end: force => { ended = force; } },
        mqttRunning: true,
    };

    closeMqtt(printer, "reconnecting on request", true);

    assert.equal(printer.closingReason, "reconnecting on request");
    assert.equal(printer.mqttClient, null);
    assert.equal(printer.mqttRunning, false);
    assert.equal(ended, true);
});

test("a close without a client still records the reason", () => {
    // The monitor loop can find a printer whose connection already went away
    const printer = { mqttClient: null, mqttRunning: false };

    closeMqtt(printer, "the service is restarting");

    assert.equal(printer.closingReason, "the service is restarting");
});

test("the client is ended gracefully unless force is asked for", () => {
    let ended = "untouched";
    const printer = { mqttClient: { end: force => { ended = force; } } };

    closeMqtt(printer, "monitoring was switched off");

    assert.equal(ended, false);
});
