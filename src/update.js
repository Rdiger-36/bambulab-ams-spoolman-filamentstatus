import got from "got";

import { serverLogFilePath, version } from "./config.js";

/**
 * Update check against the GitHub releases of this project.
 *
 * Nothing is downloaded or installed, and nothing about the installation is
 * sent: it is one unauthenticated GET of the latest release, and the answer is
 * a version string. The result is cached, because the settings page asks on
 * every load and the rate limit for an unauthenticated caller is not generous.
 */

const RELEASE_URL = "https://api.github.com/repos/Rdiger-36/bambulab-ams-spoolman-filamentstatus/releases/latest";
const CACHE_MS = 6 * 60 * 60 * 1000;

let cached = null;

/**
 * Compares two versions, prereleases included.
 *
 * `1.3.0-dev.2` is older than `1.3.0`, which is what makes the check useful on
 * the dev images: they should be told when the release they lead up to is out.
 *
 * @param {string} a - a version, with or without a leading "v"
 * @param {string} b - the version to compare it against
 * @returns {number} negative when a is older, 0 when equal, positive when newer
 */
export function compareVersions(a, b) {
    const parse = value => {
        const [core, pre = ""] = String(value ?? "").trim().replace(/^v/i, "").split("-");
        return {
            numbers: core.split(".").map(part => parseInt(part, 10) || 0),
            pre: pre ? pre.split(".") : [],
        };
    };

    const left = parse(a);
    const right = parse(b);

    for (let i = 0; i < Math.max(left.numbers.length, right.numbers.length); i++) {
        const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
        if (diff !== 0) return diff;
    }

    // A version without a prerelease suffix is the finished one and wins
    if (!left.pre.length && right.pre.length) return 1;
    if (left.pre.length && !right.pre.length) return -1;

    for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
        const l = left.pre[i];
        const r = right.pre[i];
        if (l === r) continue;
        if (l === undefined) return -1;
        if (r === undefined) return 1;

        const numeric = /^\d+$/.test(l) && /^\d+$/.test(r);
        if (numeric) return Number(l) - Number(r);
        return l < r ? -1 : 1;
    }

    return 0;
}

/**
 * Asks GitHub for the latest release.
 *
 * A failure is a result, not an error: no internet is the normal state of a
 * printer network that is deliberately kept offline, and the page says "could
 * not check" rather than showing a broken card.
 *
 * @param {object} [options]
 * @param {boolean} [options.force] - ignore the cache
 * @returns {Promise<{current: string, latest: string|null, updateAvailable: boolean, url: string|null, checked: string, error: string|null}>}
 */
export async function checkForUpdate({ force = false } = {}) {
    if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.result;

    let result = {
        current: version,
        latest: null,
        updateAvailable: false,
        // True on a dev or release candidate image, whose version is newer than
        // anything released. "Up to date" would be misleading there.
        ahead: false,
        url: null,
        checked: new Date().toISOString(),
        error: null,
    };

    try {
        const response = await got(RELEASE_URL, {
            headers: {
                accept: "application/vnd.github+json",
                // GitHub refuses a request without one
                "user-agent": `ams-spoolman-manager/${version}`,
            },
            timeout: { request: 8000 },
            retry: { limit: 0 },
        }).json();

        const latest = String(response?.tag_name ?? "").replace(/^v/i, "");
        if (latest) {
            const diff = compareVersions(latest, version);
            result.latest = latest;
            result.updateAvailable = diff > 0;
            result.ahead = diff < 0;
            result.url = response?.html_url ?? null;
        } else {
            result.error = "The latest release carries no version tag";
        }
    } catch (err) {
        result.error = err?.message || "The release could not be read";
        console.error("Server", serverLogFilePath, `[Update] Check failed: ${result.error}`);
    }

    cached = { at: Date.now(), result };
    return result;
}

/** Drops the cached answer. Exists for the tests. */
export function resetUpdateCache() {
    cached = null;
}
