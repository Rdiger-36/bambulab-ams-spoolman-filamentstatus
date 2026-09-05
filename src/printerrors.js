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

const CATALOGUE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "print-errors.json");

/** The catalogue as written by the fetch script: `{ version, models, errors }`. */
export const PRINT_ERROR_CATALOGUE = JSON.parse(fs.readFileSync(CATALOGUE_PATH, "utf8"));

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
 * @returns {string|null} the sentence
 */
export function describePrintError(code) {
    const hex = printErrorHex(code);
    if (!hex) return null;
    return PRINT_ERROR_CATALOGUE.errors[hex] ?? null;
}
