import crypto from "crypto";
import fs from "fs-extra";
import path from "path";

import { apiKeysPath, serverLogFilePath } from "./config.js";

/**
 * API keys for callers that are not a browser.
 *
 * The Web UI password in `auth.js` is the right answer for a person in front of
 * a browser and the wrong one for Home Assistant, Node-RED or a shell script:
 * those cannot log in, and a password typed into an automation is a password
 * stored in clear text somewhere else. A key is what they can carry, and unlike
 * the password it can be revoked on its own without signing anybody out.
 *
 * A key is a full session. It reads and it writes, exactly what a browser
 * session may do, because every split of that would have to be maintained per
 * route and no installation of this size has two kinds of caller to separate.
 *
 * Shape of `printers/apikeys.json`, a list so the order it is shown in is the
 * order it was written in:
 *
 *   [ { id, name, hash, createdAt, lastUsedAt } ]
 *
 * The key itself is never in it. What is stored is a SHA-256 of the key, so a
 * copy of the file is not a set of working keys, and a lost key means a new one
 * rather than a lookup.
 */

/** Marks a key of this service, in a log line or a pasted config. */
const PREFIX = "ams_";

/** Bytes of randomness behind one key. */
const KEY_BYTES = 32;

/** Longest name a key may carry, so the list stays readable. */
const MAX_NAME_LENGTH = 64;

/**
 * How long a recorded "last used" may lag behind reality.
 *
 * Every accepted request would otherwise rewrite the file, and a home
 * automation polling this service does that a few times a minute forever. The
 * field says which key is still in use and which one can be revoked; it is not
 * an access log, so a minute of lag costs nothing.
 */
const LAST_USED_RESOLUTION = 60 * 1000;

let keys = null;

/**
 * Reads the file once, treating a missing or unreadable one as empty.
 *
 * An unreadable file is not fatal on purpose. Refusing to start over it would
 * take the Web UI down as well, and the Web UI is where the user would fix it.
 *
 * @returns {object[]} the stored entries
 */
function load() {
    if (keys) return keys;

    try {
        const parsed = JSON.parse(fs.readFileSync(apiKeysPath, "utf-8"));
        keys = Array.isArray(parsed) ? parsed.filter(entry => entry && typeof entry.hash === "string") : [];
    } catch (err) {
        if (err.code !== "ENOENT") {
            console.error("Server", serverLogFilePath, `[API keys] Could not read apikeys.json, starting with none: ${err.message}`);
        }
        keys = [];
    }

    return keys;
}

/** Writes the file atomically, so a crash mid write cannot truncate it. */
function persist() {
    const tmp = `${apiKeysPath}.tmp`;
    fs.ensureDirSync(path.dirname(apiKeysPath));
    fs.writeFileSync(tmp, JSON.stringify(load(), null, 4));
    fs.renameSync(tmp, apiKeysPath);
}

/**
 * Hashes a key for storage and comparison.
 *
 * SHA-256 rather than the scrypt of `passwords.js`, and that difference is
 * deliberate. scrypt is slow on purpose, which is what makes a guessable
 * password expensive to work through; a key is 32 random bytes, which no word
 * list reaches, so there is nothing to slow down. What there is instead is a
 * hash computed on every single request that carries a key, and a memory hard
 * function in that path would turn a polling home automation into a load
 * problem.
 *
 * @param {string} plain - the key as the caller sends it
 * @returns {string} `sha256$<hex>`
 */
export function hashApiKey(plain) {
    return `sha256$${crypto.createHash("sha256").update(String(plain)).digest("hex")}`;
}

/**
 * A new key, shown to the user once and then only ever held as a hash.
 *
 * base64url so it survives being pasted into a header, a YAML file and a shell
 * command without quoting.
 *
 * @returns {string} the key in clear text
 */
export function generateApiKey() {
    return `${PREFIX}${crypto.randomBytes(KEY_BYTES).toString("base64url")}`;
}

/**
 * The keys as a client may see them: everything except the hash.
 *
 * @returns {object[]} id, name, createdAt and lastUsedAt per key
 */
export function listApiKeys() {
    return load().map(({ id, name, createdAt, lastUsedAt }) => ({
        id,
        name,
        createdAt,
        lastUsedAt: lastUsedAt ?? null,
    }));
}

/** Whether at least one key exists, for the facts the Service card shows. */
export function apiKeyCount() {
    return load().length;
}

/**
 * Creates a key under a name and persists it.
 *
 * The name has to be unique. Two keys called "Home Assistant" are a list nobody
 * can revoke the right half of, and the name is the only thing about a key that
 * is ever shown again.
 *
 * @param {string} name - what the key is for
 * @returns {{ok: true, key: string, entry: object}|{ok: false, error: string}}
 *   `key` is the clear text, and this is the only time it exists
 */
export function createApiKey(name) {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) return { ok: false, error: "The key needs a name" };
    if (trimmed.length > MAX_NAME_LENGTH) return { ok: false, error: `The name may be at most ${MAX_NAME_LENGTH} characters long` };
    if (load().some(entry => entry.name.toLowerCase() === trimmed.toLowerCase())) {
        return { ok: false, error: `There is already a key called "${trimmed}"` };
    }

    const key = generateApiKey();
    const entry = {
        id: crypto.randomUUID(),
        name: trimmed,
        hash: hashApiKey(key),
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
    };

    keys.push(entry);
    persist();
    console.log("Server", serverLogFilePath, `[API keys] Created "${entry.name}"`);

    const { hash, ...rest } = entry;
    return { ok: true, key, entry: rest };
}

/**
 * Removes one key. The others keep working, which is the point of naming them.
 *
 * @param {string} id - the key id
 * @returns {object|null} the removed entry without its hash, null when there
 *   was no key under that id
 */
export function removeApiKey(id) {
    const list = load();
    const index = list.findIndex(entry => entry.id === id);
    if (index === -1) return null;

    const [{ hash, ...removed }] = list.splice(index, 1);
    persist();
    console.log("Server", serverLogFilePath, `[API keys] Revoked "${removed.name}"`);
    return removed;
}

/**
 * Checks a presented key and, when it fits, notes that it was used.
 *
 * The comparison is time constant and runs over every entry rather than
 * stopping at the first match, so the answer says nothing about how many keys
 * exist or how far into the list one sits.
 *
 * @param {string|undefined} plain - what the caller sent
 * @param {number} [now] - epoch milliseconds, injectable for the tests
 * @returns {object|null} the entry without its hash, null when nothing matches
 */
export function verifyApiKey(plain, now = Date.now()) {
    if (typeof plain !== "string" || !plain) return null;

    const presented = Buffer.from(hashApiKey(plain));
    let match = null;

    for (const entry of load()) {
        const stored = Buffer.from(String(entry.hash));
        if (stored.length !== presented.length) continue;
        if (crypto.timingSafeEqual(stored, presented)) match = entry;
    }

    if (!match) return null;

    touch(match, now);
    const { hash, ...rest } = match;
    return rest;
}

/**
 * Records that a key was used, at most once per resolution step.
 *
 * @param {object} entry - the stored entry
 * @param {number} now - epoch milliseconds
 */
function touch(entry, now) {
    const previous = entry.lastUsedAt ? Date.parse(entry.lastUsedAt) : 0;
    if (Number.isFinite(previous) && now - previous < LAST_USED_RESOLUTION) return;

    entry.lastUsedAt = new Date(now).toISOString();
    try {
        persist();
    } catch (err) {
        // A read only data directory must not turn every authenticated request
        // into a 500. The key is valid either way; only the note is lost.
        console.error("Server", serverLogFilePath, `[API keys] Could not record the last use: ${err.message}`);
    }
}

/**
 * The key a request carries, if it carries one.
 *
 * Two headers, because both are in the wild: `Authorization: Bearer` is what
 * an HTTP client offers a field for, and `X-API-Key` is what the integration
 * pages of most home automations ask for by name. A query parameter is
 * deliberately not read: it would end up in the log of every proxy in front of
 * this service, and a value a browser can put in a URL is one a page on another
 * site could put there too.
 *
 * @param {object} req - Express request
 * @returns {string|undefined} the key, undefined when there is none
 */
export function apiKeyFromRequest(req) {
    const header = req?.headers?.authorization;
    if (typeof header === "string") {
        const match = /^Bearer\s+(.+)$/i.exec(header.trim());
        if (match) return match[1].trim();
    }

    const direct = req?.headers?.["x-api-key"];
    return typeof direct === "string" && direct.trim() ? direct.trim() : undefined;
}

/** Drops the cached list, so the next read comes off disk. For the tests. */
export function resetApiKeyCache() {
    keys = null;
}
