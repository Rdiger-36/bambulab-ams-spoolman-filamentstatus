import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

// Classic scripts that only touch globalThis, so they load as they are
await import("../public/i18n.js");
const languageFiles = fs.readdirSync(new URL("../public/i18n/", import.meta.url)).filter(name => name.endsWith(".js"));
for (const name of languageFiles) await import(`../public/i18n/${name}`);

const { I18N } = globalThis;

/** The placeholders a text uses, sorted, for comparing two languages. */
function placeholders(text) {
    const all = typeof text === "object" ? Object.values(text).join(" ") : String(text);
    return [...new Set(all.match(/\{\w+\}/g) || [])].sort();
}

test("every language file registers a table", () => {
    const codes = I18N.languages().map(([code]) => code);
    assert.ok(codes.includes("en"));
    assert.equal(codes.length, languageFiles.length);
});

test("every language has every English key, with the same placeholders", () => {
    const english = I18N.table("en");
    for (const [code] of I18N.languages()) {
        if (code === "en") continue;
        const table = I18N.table(code);
        const missing = Object.keys(english).filter(key => !(key in table));
        assert.deepEqual(missing, [], `${code} lacks keys`);
        const extra = Object.keys(table).filter(key => !(key in english));
        assert.deepEqual(extra, [], `${code} has keys English does not`);
        for (const key of Object.keys(english)) {
            assert.deepEqual(placeholders(table[key]), placeholders(english[key]), `${code}: ${key}`);
            assert.equal(typeof table[key], typeof english[key], `${code}: ${key} plural shape`);
        }
    }
});

test("a plural has the forms its language needs", () => {
    for (const [code] of I18N.languages()) {
        const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
        for (const [key, text] of Object.entries(I18N.table(code))) {
            if (typeof text !== "object") continue;
            assert.ok("other" in text, `${code}: ${key} needs other`);
            for (const category of Object.keys(text)) assert.ok(categories.includes(category), `${code}: ${key} has ${category}`);
        }
    }
});

test("a text fills its placeholders, falls back to English and then to the key", () => {
    I18N.register("en", "English", { "test.hello": "Hello {name}", "test.items": { one: "{count} item", other: "{count} items" }, "test.only": "Only English" });
    I18N.register("xx", "Test", { "test.hello": "Hallo {name}" });
    // Node has no browser languages and no storage, so it is English here
    assert.equal(I18N.language(), "en");
    assert.equal(I18N.t("test.hello", { name: "Niklas" }), "Hello Niklas");
    assert.equal(I18N.t("test.hello"), "Hello {name}");
    assert.equal(I18N.t("test.items", { count: 1 }), "1 item");
    assert.equal(I18N.t("test.items", { count: 3 }), "3 items");
    assert.equal(I18N.t("test.missing"), "test.missing");
    assert.equal(globalThis.t, I18N.t);
    // The switch names each language in the shown one, with its code, and a
    // language no table names yet under the name it registered itself with
    assert.equal(I18N.languageLabel("de"), "German (DE)");
    assert.equal(I18N.languageLabel("xx"), "Test (XX)");
});
