import fs from "node:fs";
import path from "node:path";

/**
 * Every language table of the Web UI as one script, served as `i18n/all.js`.
 *
 * A language is one file under `public/i18n/` that calls `I18N.register()`.
 * The pages load this one address instead of one script tag per language, so
 * dropping a new file into the folder is all it takes for every page and the
 * switch in the menu bar to offer it. Read on every request rather than once,
 * so a file added to a running container shows up on the next page load.
 *
 * English comes first, because it is the fallback every other table leans on,
 * and the rest follow by file name so the order is the same on every load. The
 * tables are trusted files of this installation and go out as they are.
 *
 * @param {string} dir - the folder holding the tables
 * @returns {string} the tables, one after another
 */
export function readLanguageBundle(dir) {
    const files = fs.readdirSync(dir)
        .filter(name => /^[a-z]{2,3}(-[a-z0-9]+)?\.js$/i.test(name))
        .sort((a, b) => (a === "en.js" ? -1 : b === "en.js" ? 1 : a.localeCompare(b)));
    return files
        .map(name => `// ${name}\n${fs.readFileSync(path.join(dir, name), "utf8")}`)
        .join("\n");
}
