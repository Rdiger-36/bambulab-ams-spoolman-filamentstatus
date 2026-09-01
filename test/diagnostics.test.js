import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";

import { startTestApp, call } from "./helpers/app.js";

// Its own app so the bundle is built against a data directory this file owns.
let app;

const printer = { id: "01p00a000000042", code: "87654321", ip: "192.168.178.55", name: "Test printer" };

before(async () => {
    app = await startTestApp();
    await call(`${app.url}/api/printers`, "POST", printer);

    // A log line carrying everything the masking is supposed to remove
    fs.writeFileSync(
        path.join(process.env.LOG_DIR, "01P00A000000042.log"),
        "Printer 01P00A000000042 with IP 192.168.178.55 and code 87654321 is unreachable\n",
    );
});

after(async () => { await app.close(); });

/** Downloads a bundle and returns its entries as a name to text map. */
async function bundle(query = "") {
    const response = await fetch(`${app.url}/api/diagnostics/download${query}`);
    assert.equal(response.status, 200);

    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    return Object.fromEntries(zip.getEntries().map(entry => [entry.entryName, entry.getData().toString("utf-8")]));
}

test("the system info answers what a bug report asks first", async () => {
    const { status, body } = await call(`${app.url}/api/system`);

    assert.equal(status, 200);
    assert.equal(typeof body.version, "string");
    assert.equal(body.node, process.version);
    assert.equal(typeof body.uptime, "number");
    assert.equal(body.printers, 1);
});

test("the anonymised bundle carries the logs and the configuration", async () => {
    const files = await bundle();

    assert.ok(files["info.json"]);
    assert.ok(files["settings.json"]);
    assert.ok(files["printers.json"]);
    assert.ok(Object.keys(files).some(name => name.startsWith("logs/server.")));
    assert.equal(JSON.parse(files["info.json"]).anonymized, true);
});

test("nothing identifying survives the anonymised bundle", async () => {
    const files = await bundle();
    const everything = Object.values(files).join("\n");

    assert.doesNotMatch(everything, /01P00A000000042/);
    assert.doesNotMatch(everything, /192\.168\.178\.55/);
    assert.doesNotMatch(everything, /87654321/);

    // And what is left is still readable
    assert.match(everything, /01P00XXXXXXXXXX/);
    assert.match(everything, /192\.168\.178\.XXX/);
});

test("the serial is masked in the log file names as well", async () => {
    const files = await bundle();

    assert.ok(Object.keys(files).some(name => name.startsWith("logs/01P00XXXXXXXXXX.")));
    assert.ok(!Object.keys(files).some(name => name.includes("01P00A000000042")));
});

test("the full bundle keeps the addresses but never the access code", async () => {
    const files = await bundle("?anonymize=false");
    const everything = Object.values(files).join("\n");

    assert.match(everything, /01P00A000000042/);
    assert.match(everything, /192\.168\.178\.55/);
    // The one value that is never useful in a report and always harmful in one.
    // The log fixture contains it, so this covers the log text as well as
    // printers.json, which is the whole point of masking it in both variants.
    assert.doesNotMatch(everything, /87654321/);
    assert.equal(JSON.parse(files["info.json"]).anonymized, false);
});

test("the log download is anonymised unless it is asked not to be", async () => {
    const anonymized = await fetch(`${app.url}/api/logs/01P00A000000042/download`);
    const text = await anonymized.text();
    assert.match(text, /01P00XXXXXXXXXX/);
    assert.doesNotMatch(text, /192\.168\.178\.55/);
    assert.match(anonymized.headers.get("content-disposition"), /01P00XXXXXXXXXX/);

    const full = await fetch(`${app.url}/api/logs/01P00A000000042/download?anonymize=false`);
    assert.match(await full.text(), /192\.168\.178\.55/);
    assert.match(full.headers.get("content-disposition"), /_full/);
});

test("monitoring is switched for every printer at once", async () => {
    const stopped = await call(`${app.url}/api/monitoring/stop`, "POST", {});
    assert.equal(stopped.status, 200);
    assert.deepEqual(stopped.body.changed, ["01P00A000000042"]);

    const list = await call(`${app.url}/api/printers/config`);
    assert.equal(list.body[0].monitoringEnabled, false);

    // A second call changes nothing and says so rather than reporting success
    const again = await call(`${app.url}/api/monitoring/stop`, "POST", {});
    assert.deepEqual(again.body.changed, []);
    assert.equal(again.body.total, 1);
});

test("an unknown monitoring action is refused", async () => {
    const { status } = await call(`${app.url}/api/monitoring/pause`, "POST", {});
    assert.equal(status, 404);
});

test("a reconnect skips the printers whose monitoring is off", async () => {
    // Left disabled by the test above, so nothing should be reconnected
    const { status, body } = await call(`${app.url}/api/printers/reconnect`, "POST", {});

    assert.equal(status, 200);
    assert.deepEqual(body.reconnected, []);
    assert.equal(body.skipped, 1);
});
