import { envPrinterSeed, PORT } from "./config.js";
import { printerListSeededFromEnv } from "./printers.js";
import { envSeededKeys, getAcknowledgedNotices } from "./settings.js";

/**
 * The deprecation of environment based configuration.
 *
 * Since 1.3.0 every setting and the printer list live in `printers/settings.json`
 * and `printers/printers.json`, both written by the service and editable in the
 * Web UI. The environment variables still work and are not going away here, but
 * they only seed a value that has never been saved, which makes them a poor
 * place to keep configuration: a change to the container definition silently
 * stops having an effect the moment somebody saves in the browser.
 *
 * This module answers whether a given installation is still relying on them, so
 * the startup log and the Web UI can say so. It is state driven rather than
 * version driven on purpose: the answer is yes for an install upgraded from
 * 1.2.x and equally for a fresh one set up from an older README, and it turns
 * into no by itself as soon as the values have been saved once.
 *
 * This module must not import logger.js, for the reason settings.js gives.
 */

/** Identifies the notice in `settings.json`, so a dismissal survives a restart. */
export const ENV_CONFIG_NOTICE = "env-config";

/** The single printer seed, mapped back to the variable names that carry it. */
const PRINTER_VARIABLES = { id: "PRINTER_ID", code: "PRINTER_CODE", ip: "PRINTER_IP" };

/**
 * Describes how much of this installation is still configured by environment
 * variables.
 *
 * `variables` are the settings whose effective value comes from the environment
 * right now. `printerVariables` are the PRINTER_* variables that are set;
 * `printerVariablesIgnored` says they no longer do anything, because
 * printers.json already owned the printer list when this process started.
 *
 * @returns {{active: boolean, variables: string[], printerVariables: string[], printerVariablesIgnored: boolean, acknowledged: boolean}}
 */
export function deprecatedConfig() {
    const variables = envSeededKeys();
    const printerVariables = Object.entries(PRINTER_VARIABLES)
        .filter(([field]) => {
            const value = envPrinterSeed[field];
            return typeof value === "string" && value.trim() !== "";
        })
        .map(([, name]) => name);

    return {
        active: variables.length > 0 || printerVariables.length > 0,
        variables,
        printerVariables,
        printerVariablesIgnored: printerVariables.length > 0 && !printerListSeededFromEnv(),
        acknowledged: !!getAcknowledgedNotices()[ENV_CONFIG_NOTICE],
    };
}

/**
 * The startup lines for `docker logs`, empty when nothing deprecated is in use.
 *
 * Returned rather than logged so the caller decides where they go, which is
 * also what makes them testable without capturing the console.
 *
 * @param {object} [notice] - the result of `deprecatedConfig()`
 * @returns {string[]} one line per message
 */
export function deprecationLogLines(notice = deprecatedConfig()) {
    if (!notice.active) return [];

    const lines = [
        "[Deprecated] Configuring this service through environment variables is deprecated since 1.3.0.",
        `[Deprecated] It keeps working, but the settings page in the Web UI is the supported way now: http://<host>:${PORT}/settings.html`,
    ];

    if (notice.variables.length) {
        lines.push(`[Deprecated] Still taken from the environment: ${notice.variables.join(", ")}. Saving on the settings page moves them into printers/settings.json, which owns them from then on.`);
    }

    if (notice.printerVariables.length) {
        lines.push(notice.printerVariablesIgnored
            ? `[Deprecated] ${notice.printerVariables.join(", ")} are set but have no effect: printers.json exists and owns the printer list. Add, edit and remove printers in the Web UI.`
            : `[Deprecated] The printer list is seeded from ${notice.printerVariables.join(", ")} and written to printers.json on this start. Edit it in the Web UI from now on, not in the container definition.`);
    }

    return lines;
}
