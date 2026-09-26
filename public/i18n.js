/**
 * The Web UI in more than one language.
 *
 * Every visible string of the Web UI is looked up by a key, `t("menu.settings")`,
 * in the table of the language the viewer reads. English is the fallback for a
 * key another language does not have yet, so a half translated table shows
 * English where it is missing rather than the key.
 *
 * A language is one file under `public/i18n/`, which registers its table with
 * `I18N.register("de", "Deutsch", { ... })`, and one script tag for it on every
 * page. Nothing else has to change for another language: the switch in the menu
 * bar lists whatever registered.
 *
 * A classic script on purpose. `menu.js`, `export.js`, `logs.js` and `login.js`
 * are classic scripts and read it off the global scope, the modules do the same
 * through `window.I18N`, and the tables have to be in place before any of them
 * runs, which a plain script tag in the head guarantees without a build step.
 * It touches nothing but `globalThis` at load time, so the tests import it as it
 * is.
 *
 * What stays English is decided elsewhere and not here: log lines, every value
 * the API hands out, and the API page. This only translates what a page shows.
 */
(function (global) {
    const FALLBACK = "en";
    const STORAGE_KEY = "language";

    /** The tables by language code, and the name each language gives itself. */
    const tables = {};
    const names = {};

    // Worked out on first use rather than at load time, because the tables
    // register after this file has run.
    let current = null;

    /**
     * Adds a language, or more keys to one already registered.
     *
     * @param {string} code - the language code, "de"
     * @param {string} name - the language's name in itself, "Deutsch"
     * @param {object} table - key to text, or to `{ one, other }` for a plural
     */
    function register(code, name, table) {
        tables[code] = Object.assign(tables[code] || {}, table);
        names[code] = name;
    }

    /** The choice this browser stored, or null. Storage may be blocked. */
    function storedChoice() {
        try {
            return global.localStorage?.getItem(STORAGE_KEY) ?? null;
        } catch {
            return null;
        }
    }

    /**
     * The language to show: the one picked in the menu bar, else the first of
     * the browser's languages there is a table for, else English.
     */
    function detect() {
        const stored = storedChoice();
        if (stored && tables[stored]) return stored;
        const wanted = global.navigator?.languages ?? [global.navigator?.language].filter(Boolean);
        for (const tag of wanted) {
            const code = String(tag).toLowerCase().split("-")[0];
            if (tables[code]) return code;
        }
        return FALLBACK;
    }

    /** The code of the language the page is shown in. */
    function language() {
        if (!current || !tables[current]) current = detect();
        return current;
    }

    /**
     * The text for a key, with `{name}` placeholders filled in from `params`.
     *
     * A plural is an object of `Intl.PluralRules` categories and is picked by
     * `params.count`. A placeholder without a value is left as it is, so a
     * missing parameter shows up on the page instead of vanishing.
     *
     * The result is plain text. A caller putting it into `innerHTML` escapes the
     * values it passes in, as it would without a translation.
     *
     * @param {string} key - the key, "print.stage.heating"
     * @param {object} [params] - the values for the placeholders
     * @returns {string}
     */
    function t(key, params = {}) {
        const lang = language();
        let text = tables[lang]?.[key] ?? tables[FALLBACK]?.[key];
        if (text == null) return key;
        if (typeof text === "object") {
            const category = new Intl.PluralRules(lang).select(Number(params.count ?? 0));
            text = text[category] ?? text.other;
        }
        return String(text).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    /**
     * Stores the choice and shows the page again in it. A reload rather than a
     * re-render, because most of what a page shows was built by its own script
     * from data it fetched, and every page already knows how to build itself.
     *
     * @param {string} code - a registered language code
     */
    function setLanguage(code) {
        if (!tables[code]) return;
        try {
            global.localStorage?.setItem(STORAGE_KEY, code);
        } catch {
            // Storage blocked: the choice lasts for this page only
        }
        current = code;
        global.location?.reload();
    }

    /**
     * Translates the static markup under `root`: `data-i18n` sets the text,
     * `data-i18n-title`, `data-i18n-placeholder` and `data-i18n-aria-label` the
     * attributes of those names. Also tells the browser which language the page
     * is in, which is what screen readers and hyphenation go by.
     *
     * @param {ParentNode} [root]
     */
    function apply(root = global.document) {
        if (!root) return;
        for (const element of root.querySelectorAll("[data-i18n]")) {
            element.textContent = t(element.dataset.i18n);
        }
        for (const attribute of ["title", "placeholder", "aria-label"]) {
            for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
                element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
            }
        }
        if (global.document?.documentElement) global.document.documentElement.lang = language();
    }

    /**
     * Whether a key has a text in the shown language or in English. For text
     * that arrives from the server in English and is only translated where a
     * table knows it, such as the labels of the settings schema.
     */
    function has(key) {
        return tables[language()]?.[key] != null || tables[FALLBACK]?.[key] != null;
    }

    /** Every registered language as `[code, name]`, for the switch. */
    function languages() {
        return Object.entries(names);
    }

    /** The table of a language, for the tests. */
    function table(code) {
        return tables[code] || {};
    }

    global.I18N = { register, t, has, language, languages, setLanguage, apply, table, FALLBACK };
    // `t` on its own as well, because the classic scripts share one global
    // scope and a `const { t }` in each of them would be declared twice.
    global.t = t;

    if (global.document) {
        global.document.addEventListener("DOMContentLoaded", () => apply());
    }
})(globalThis);
