import { PORT } from "./config.js";
import { printerFileExistedAtStart } from "./printers.js";
import { getAcknowledgedNotices, markNoticePending, settingsFileExistedAtStart } from "./settings.js";

/**
 * The one time notice for an installation updated from 1.2.x.
 *
 * 1.3.0 changes three things an existing installation can trip over: the AMS
 * slots are numbered from 1, the API answers only the Web UI and a caller with
 * an API key, and a name the service is reached under has to be allowed. None
 * of them is visible on the dashboard, and the changelog is not what most
 * people read after pulling a new image, so the dashboard says it once.
 *
 * A 1.2.x installation is recognised by its files rather than by a version
 * number, because nothing records which version ran before: 1.2.x kept the
 * printer list in a hand-written printers.json and never wrote settings.json,
 * a fresh 1.3.0 install has neither file, and an installation that has run
 * 1.3.0 before has settings.json. The check is made once, when this process
 * starts, and the notice is marked pending in memory right away, so the first
 * write of settings.json carries the mark and a save on the settings page
 * before the dashboard was ever opened does not make the notice disappear.
 *
 * This module must not import logger.js, for the reason settings.js gives.
 */

/** Identifies the notice in `settings.json`, so a dismissal survives a restart. */
export const UPGRADE_NOTICE = "upgrade-1.3.0";

/** Where the update page of the documentation lives. */
const UPGRADE_DOCS_URL = "https://github.com/Rdiger-36/bambulab-ams-spoolman-filamentstatus/blob/main/docs/updating.md";

/**
 * Whether this process started on the files of a 1.2.x installation.
 *
 * @returns {boolean}
 */
function startedOnOlderInstallation() {
    return printerFileExistedAtStart() && !settingsFileExistedAtStart();
}

// Marked at import, before any route can write settings.json. Routes import
// this module, so it always runs before the first save.
if (startedOnOlderInstallation()) {
    markNoticePending(UPGRADE_NOTICE);
}

/**
 * Describes the state of the upgrade notice.
 *
 * `active` is true from the start that found the 1.2.x files until the notice
 * is dismissed, across restarts. An installation that never had those files
 * never sees it.
 *
 * @returns {{active: boolean, acknowledged: boolean, docs: string}}
 */
export function upgradeNotice() {
    const stored = getAcknowledgedNotices()[UPGRADE_NOTICE];

    return {
        active: stored === false,
        acknowledged: stored === true,
        docs: UPGRADE_DOCS_URL,
    };
}

/**
 * The startup lines for `docker logs`, empty unless the notice is active.
 *
 * Returned rather than logged so the caller decides where they go, which is
 * also what makes them testable without capturing the console. Printed on
 * every start until the notice is dismissed, because the one installation that
 * cannot dismiss it, reached under a name that is not allowed yet, only has
 * the log.
 *
 * @param {object} [notice] - the result of `upgradeNotice()`
 * @returns {string[]} one line per message
 */
export function upgradeLogLines(notice = upgradeNotice()) {
    if (!notice.active) return [];

    return [
        "[Update] This installation was set up with version 1.2.x. Four things changed in 1.3.0 that may need you:",
        "[Update] AMS slots are numbered from 1 now, A1 to A4. A script or a home automation reading slot labels from the API sees the new labels.",
        "[Update] The API answers only the Web UI and a caller with an API key. A script or an integration that called it without one needs a key, created under \"Network access\" on the settings page.",
        `[Update] Reaching the service under a domain name or through a reverse proxy needs that name under \"Allowed host names\" in the same card, or in ALLOWED_HOSTS. An IP address, localhost and a .local name work as before: http://<host>:${PORT}/settings.html`,
        `[Update] Consumption is tracked from the sliced file of a print now, not from the RFID remain percentage; LEGACY_MODE=true keeps the old behaviour. Everything else: ${notice.docs}`,
    ];
}
