import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { startTestApp } from "./helpers/app.js";

// config.js reads DATA_DIR and LOG_DIR once, when it is first imported, so they
// have to be pointed at a temporary directory before anything under src/ is
// loaded. That is what the dynamic import below is for: a static one would run
// first and the refused requests of this suite would be written into the logs
// of the working copy.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-security-"));
process.env.DATA_DIR = path.join(tempDir, "printers");
process.env.LOG_DIR = path.join(tempDir, "logs");
fs.ensureDirSync(process.env.DATA_DIR);
fs.ensureDirSync(process.env.LOG_DIR);

const { isAllowedHost, isFromOwnUi, isSameOrigin, parseAllowedHosts } = await import("../src/security.js");
const { settings } = await import("../src/settings.js");

test.after(() => fs.removeSync(tempDir));

test("parseAllowedHosts reads a list and drops ports and whitespace", () => {
    assert.deepEqual(parseAllowedHosts("ams.example.com, Spool.Example.COM:4000 "), ["ams.example.com", "spool.example.com"]);
    assert.deepEqual(parseAllowedHosts(""), []);
    assert.deepEqual(parseAllowedHosts(undefined), []);
});

test("a literal address is allowed without configuration", () => {
    for (const host of ["192.168.1.50:4000", "127.0.0.1", "10.0.0.8:4000", "[::1]:4000", "[fe80::1%eth0]:4000"]) {
        assert.equal(isAllowedHost(host, []), true, host);
    }
});

test("localhost and mDNS names are allowed, an ordinary name is not", () => {
    assert.equal(isAllowedHost("localhost:4000", []), true);
    assert.equal(isAllowedHost("ams.localhost", []), true);
    assert.equal(isAllowedHost("homeassistant.local:8123", []), true);
    assert.equal(isAllowedHost("ams.example.com", []), false);
    assert.equal(isAllowedHost("ams.example.com", ["ams.example.com"]), true);
});

test("a name that only looks like an address is still a name", () => {
    // The rebinding attack needs a DNS lookup, and these have one.
    assert.equal(isAllowedHost("999.1.1.1", []), false);
    assert.equal(isAllowedHost("256.1.1.1", []), false);
    assert.equal(isAllowedHost("192.168.1.50.evil.com", []), false);
});

test("a missing host is refused", () => {
    assert.equal(isAllowedHost(undefined, []), false);
    assert.equal(isAllowedHost("", ["ams.example.com"]), false);
});

test("an origin has to name the same host, and no origin is not a browser", () => {
    assert.equal(isSameOrigin(undefined, "192.168.1.50:4000"), true);
    assert.equal(isSameOrigin("http://192.168.1.50:4000", "192.168.1.50:4000"), true);
    // Behind a TLS terminating proxy the browser says https and the request
    // arrives as plain HTTP.
    assert.equal(isSameOrigin("https://ams.example.com", "ams.example.com"), true);
    assert.equal(isSameOrigin("http://evil.com", "192.168.1.50:4000"), false);
    assert.equal(isSameOrigin("http://192.168.1.50:4001", "192.168.1.50:4000"), false);
    assert.equal(isSameOrigin("null", "192.168.1.50:4000"), false);
    assert.equal(isSameOrigin("not a url", "192.168.1.50:4000"), false);
    // A reverse proxy that rewrites Host leaves the two disagreeing, so the
    // allow list decides instead.
    assert.equal(isSameOrigin("https://ams.example.com", "localhost:4000", ["ams.example.com"]), true);
    assert.equal(isSameOrigin("https://evil.com", "localhost:4000", ["ams.example.com"]), false);
});

test("a request is taken for the Web UI only when the browser says so", () => {
    // What a page of this service produces
    assert.equal(isFromOwnUi({ "sec-fetch-site": "same-origin", host: "192.168.1.50:4000" }), true);
    // A typed URL, a bookmark, a link from somewhere else
    assert.equal(isFromOwnUi({ "sec-fetch-site": "none", host: "192.168.1.50:4000" }), false);
    assert.equal(isFromOwnUi({ "sec-fetch-site": "cross-site", host: "192.168.1.50:4000" }), false);
    // curl, a home automation, anything that is not a browser
    assert.equal(isFromOwnUi({ host: "192.168.1.50:4000" }), false);
    assert.equal(isFromOwnUi({}), false);

    // A browser too old for Sec-Fetch-Site still sends a referer on a same
    // origin fetch, and behind a rewriting proxy the allow list decides
    assert.equal(isFromOwnUi({ referer: "http://192.168.1.50:4000/settings.html", host: "192.168.1.50:4000" }), true);
    assert.equal(isFromOwnUi({ referer: "http://evil.example.com/", host: "192.168.1.50:4000" }), false);
    assert.equal(isFromOwnUi({ referer: "https://ams.example.com/index.html", host: "localhost:4000" }, ["ams.example.com"]), true);
    // The header wins over the referer when it is there, so a stale referer
    // cannot talk a modern browser's cross site request into passing
    assert.equal(isFromOwnUi({ "sec-fetch-site": "cross-site", referer: "http://192.168.1.50:4000/", host: "192.168.1.50:4000" }), false);
});

/**
 * Sends a request with headers `fetch()` refuses to set.
 *
 * Host and Origin are forbidden header names in undici, which silently drops
 * them, and they are exactly what this guard reads. The raw client is the only
 * way to send what a browser or an attacker really sends.
 *
 * @param {string} url - Address of the test app.
 * @param {object} [options] - `method`, `headers` and a JSON `body`.
 * @returns {Promise<{status: number, body: string}>}
 */
function request(url, { method = "GET", headers = {}, body } = {}) {
    const target = new URL(url);
    // What a browser puts on a request its own page made. Without it the API
    // asks for a key before the guard under test is ever reached; see
    // isFromOwnUi() and requireAuth(). A test that wants the other side of that
    // rule passes its own Sec-Fetch-Site.
    headers = { "Sec-Fetch-Site": "same-origin", ...headers };
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: target.hostname,
            port: target.port,
            path: target.pathname,
            method,
            headers,
            // Otherwise Node writes the address it dialled into the Host header
            // and the one the test wants to send is overwritten.
            setHost: !headers.Host,
        }, res => {
            let data = "";
            res.on("data", chunk => { data += chunk; });
            res.on("end", () => resolve({ status: res.statusCode, body: data }));
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

test("the guard refuses an unknown host and a cross site write over HTTP", async () => {
    const app = await startTestApp();
    try {
        const refusedHost = await request(`${app.url}/api/settings`, { headers: { Host: "evil.example.com" } });
        assert.equal(refusedHost.status, 403);
        assert.equal(JSON.parse(refusedHost.body).ok, false);

        const allowedRead = await request(`${app.url}/api/settings`);
        assert.equal(allowedRead.status, 200);

        const write = JSON.stringify({ MODE: "automatic" });
        const crossSiteWrite = await request(`${app.url}/api/settings`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", "Content-Length": write.length, Origin: "http://evil.example.com" },
            body: write,
        });
        assert.equal(crossSiteWrite.status, 403);

        // Same origin, so the identical write goes through.
        const sameSiteWrite = await request(`${app.url}/api/settings`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", "Content-Length": write.length, Origin: app.url },
            body: write,
        });
        assert.equal(sameSiteWrite.status, 200);
    } finally {
        await app.close();
    }
});

test("a host named in the setting passes, and the guard reads it per request", async () => {
    const app = await startTestApp();
    try {
        const before = await request(`${app.url}/api/settings`, { headers: { Host: "ams.example.com" } });
        assert.equal(before.status, 403);

        // Written the way the settings page writes it, into the object the
        // guard reads at the point of use. A captured allow list would keep
        // refusing the name until the next start.
        settings.ALLOWED_HOSTS = "ams.example.com";
        const after = await request(`${app.url}/api/settings`, { headers: { Host: "ams.example.com" } });
        assert.equal(after.status, 200);
    } finally {
        settings.ALLOWED_HOSTS = null;
        await app.close();
    }
});
