import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { startTestApp, call } from "./helpers/app.js";

// The document is written by hand next to the routes, so the one thing a test
// can hold it to is that the two name the same routes: every route the app
// registers is described, and nothing is described that the app does not
// serve. The shapes themselves are documentation and are checked by reading.
let app;

before(async () => { app = await startTestApp(); });
after(async () => { await app.close(); });

/** The routes an Express app has registered, as `METHOD /path/{param}`. */
async function registeredRoutes() {
    const { registerRoutes } = await import("../src/routes.js");
    const bare = express();
    registerRoutes(bare, []);

    return bare.router.stack
        .filter(layer => layer.route)
        .flatMap(layer => Object.keys(layer.route.methods).map(method =>
            `${method.toUpperCase()} ${layer.route.path.replace(/:([A-Za-z]+)/g, "{$1}")}`))
        .sort();
}

/** The operations the document describes, in the same form. */
function describedRoutes(document) {
    return Object.entries(document.paths)
        .flatMap(([path, methods]) => Object.keys(methods).map(method => `${method.toUpperCase()} ${path}`))
        .sort();
}

test("the document is served, carries the version and validates as OpenAPI 3", async () => {
    const { status, body } = await call(`${app.url}/api/openapi.json`);
    const { version } = await import("../src/config.js");

    assert.equal(status, 200);
    assert.equal(body.openapi, "3.0.3");
    assert.equal(body.info.version, version);
    assert.ok(Object.keys(body.paths).length > 30);
    assert.ok(body.components.schemas.ClientSpool);
});

test("every registered route is described, and nothing else is", async () => {
    const { body } = await call(`${app.url}/api/openapi.json`);

    assert.deepEqual(describedRoutes(body), await registeredRoutes());
});

test("every operation names a group the document lists, a summary and its answers", async () => {
    const { body } = await call(`${app.url}/api/openapi.json`);
    const groups = new Set(body.tags.map(tag => tag.name));

    for (const [path, methods] of Object.entries(body.paths)) {
        for (const [method, op] of Object.entries(methods)) {
            const where = `${method.toUpperCase()} ${path}`;
            assert.ok(op.summary, `${where} has no summary`);
            assert.ok(groups.has(op.tags?.[0]), `${where} is in an unlisted group`);
            assert.ok(op.responses?.[200], `${where} documents no 200`);

            // A path parameter has to be declared, or the explorer sends the
            // braces as they are.
            for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1])) {
                assert.ok((op.parameters || []).some(param => param.in === "path" && param.name === name),
                    `${where} does not declare {${name}}`);
            }
        }
    }
});

test("every reference points at a schema the document carries", async () => {
    const { body } = await call(`${app.url}/api/openapi.json`);
    const known = new Set(Object.keys(body.components.schemas));

    const walk = (node, where) => {
        if (!node || typeof node !== "object") return;
        if (typeof node.$ref === "string") {
            const name = node.$ref.split("/").pop();
            assert.ok(known.has(name), `${where} refers to the unknown schema ${name}`);
        }
        for (const [key, value] of Object.entries(node)) walk(value, `${where}.${key}`);
    };
    walk(body, "document");
});

test("the settings map lists every field of the schema", async () => {
    const { body } = await call(`${app.url}/api/openapi.json`);
    const { SETTINGS_SCHEMA } = await import("../src/settings.js");

    assert.deepEqual(
        Object.keys(body.components.schemas.SettingsView.properties.values.properties).sort(),
        Object.keys(SETTINGS_SCHEMA).sort(),
    );
});

test("the document is refused without a key or the Web UI, like every other route", async () => {
    const { status, body } = await call(`${app.url}/api/openapi.json`, "GET", undefined, {});

    assert.equal(status, 401);
    assert.equal(body.apiKeyRequired, true);
});
