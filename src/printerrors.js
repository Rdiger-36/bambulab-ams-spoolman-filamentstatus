import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bambu Lab's error catalogue, as far as this service carries it.
 *
 * A printer reports what went wrong with a print as a number: `print_error`
 * and `fail_reason` in the MQTT report, 50348044 for a print stopped by hand.
 * The number is a code, eight hex digits, 0300400C for that one, and Bambu
 * Lab serves the sentence behind it from the same lookup Bambu Studio and the
 * Handy app use. `scripts/fetch-print-errors.js` fetches that lookup for every
 * known printer model and writes `data/print-errors.json`, which is read here
 * once at import.
 *
 * The file is shipped rather than fetched at runtime. Nothing in this service
 * talks to Bambu Lab's servers, and a summary that names an error has to name
 * it while the network is down too.
 */

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");

/** The English catalogue as written by the fetch script: `{ version, models, errors }`. */
export const PRINT_ERROR_CATALOGUE = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "print-errors.json"), "utf8"));

/**
 * Every catalogue shipped, by language: English from `print-errors.json`, and
 * one more per `print-errors.<lang>.json` next to it. The log and the API speak
 * English; the others are for the Web UI, which shows a print's error in the
 * viewer's language. Another language is one more file, see the fetch script.
 */
export const PRINT_ERROR_CATALOGUES = { en: PRINT_ERROR_CATALOGUE };
for (const file of fs.readdirSync(DATA_DIR)) {
    const match = /^print-errors\.([a-z]{2})\.json$/.exec(file);
    if (match) PRINT_ERROR_CATALOGUES[match[1]] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
}

/**
 * The code a printer reports, as the eight hex digits the catalogue is keyed
 * by, or null when it is not a code at all.
 *
 * The printer sends the number in decimal, `print_error` as a number and
 * `fail_reason` and `mc_print_error_code` as strings of the same number, so
 * every form is taken. A value that is already hex, which a log or a bug
 * report may carry, is taken as it is.
 *
 * @param {number|string|null|undefined} code - what the printer reported
 * @returns {string|null} the code as eight uppercase hex digits
 */
export function printErrorHex(code) {
    if (code == null) return null;
    const text = String(code).trim();
    if (/^[0-9A-Fa-f]{8}$/.test(text) && !/^\d+$/.test(text)) return text.toUpperCase();
    if (!/^\d+$/.test(text)) return null;
    const number = Number(text);
    if (!Number.isSafeInteger(number) || number <= 0 || number > 0xFFFFFFFF) return null;
    return number.toString(16).toUpperCase().padStart(8, "0");
}

/**
 * The catalogue's sentence for a code, or null when the catalogue has none.
 *
 * @param {number|string|null|undefined} code - what the printer reported
 * @param {string} [lang] - the catalogue's language; a code it lacks is looked up in English
 * @returns {string|null} the sentence
 */
export function describePrintError(code, lang = "en") {
    const hex = printErrorHex(code);
    if (!hex) return null;
    return PRINT_ERROR_CATALOGUES[lang]?.errors[hex] ?? PRINT_ERROR_CATALOGUE.errors[hex] ?? null;
}

/**
 * The catalogue's sentence for a code in every shipped language, for a client
 * that shows it in its own. Null when the catalogue has none at all.
 *
 * @param {number|string|null|undefined} code - what the printer reported
 * @returns {object|null} language code to sentence
 */
export function describePrintErrorInAll(code) {
    if (!describePrintError(code)) return null;
    const texts = {};
    for (const lang of Object.keys(PRINT_ERROR_CATALOGUES)) texts[lang] = describePrintError(code, lang);
    return texts;
}
