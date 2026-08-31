import fs from "fs-extra";
import path from "path";
import { settingsPath, envSeed, supervised } from "./config.js";

/**
 * Runtime configuration, persisted to `printers/settings.json`.
 *
 * Values resolve in three layers: the schema default, then the matching
 * environment variable when one is set, then the stored file. The file wins,
 * so a value changed in the Web UI survives a restart even when the container
 * still passes the old environment variable. An environment variable therefore
 * only seeds a setting that has never been written, which also keeps a setting
 * added in a later version honouring its variable on an existing install.
 *
 * This module must not import logger.js. logger.js reads DEBUG from here, and
 * an import cycle between the two would run this file before the console
 * overrides exist. Problems found while loading are collected in
 * `settingsLoadIssues` and logged by backend.js once logging is up.
 */

/**
 * Field definitions.
 *
 * `restartRequired` marks a setting the running process cannot adopt safely;
 * the UI shows it and the value is stored but only takes effect on the next
 * start. `advanced` moves a field into the collapsed part of its group, for
 * everything an ordinary install never touches.
 */
export const SETTINGS_SCHEMA = {
    SPOOLMAN_ENDPOINT: {
        type: "string",
        default: null,
        group: "spoolman",
        label: "Spoolman endpoint",
        description: "Full base URL of the Spoolman instance, for example http://192.168.1.9:7912. Takes precedence over host and port.",
    },
    SPOOLMAN_IP: {
        type: "string",
        default: null,
        group: "spoolman",
        advanced: true,
        label: "Spoolman host",
        description: "Host name or IP of the Spoolman instance. Only used when no endpoint is set.",
    },
    SPOOLMAN_PORT: {
        type: "string",
        default: null,
        group: "spoolman",
        advanced: true,
        label: "Spoolman port",
        description: "Port of the Spoolman instance. Only used when no endpoint is set.",
    },
    SPOOLMAN_SUBFOLDER: {
        type: "string",
        default: null,
        group: "spoolman",
        advanced: true,
        label: "Spoolman subfolder",
        description: "Path prefix when Spoolman runs behind a reverse proxy, for example /spoolman.",
    },
    SPOOLMAN_FQDN: {
        type: "string",
        default: null,
        group: "spoolman",
        advanced: true,
        label: "Spoolman public URL",
        description: "Address the Web UI links to. Set this when the browser reaches Spoolman under a different name than this service does.",
    },
    MODE: {
        type: "enum",
        options: ["manual", "automatic"],
        default: "manual",
        group: "tracking",
        label: "Operation mode",
        description: "Automatic creates and merges spools in Spoolman without asking. Manual waits for a decision in the Web UI.",
    },
    LEGACY_MODE: {
        type: "boolean",
        default: false,
        restartRequired: true,
        group: "tracking",
        label: "Legacy mode",
        description: "Derives the spool weight from the AMS RFID remain percentage instead of tracking consumption from the sliced G-code. Disables 3rd party spool support and manual assignments.",
    },
    UPDATE_INTERVAL: {
        type: "integer",
        default: 120000,
        min: 5000,
        max: 300000,
        group: "behaviour",
        label: "AMS update interval",
        description: "Milliseconds between two processed AMS reports per printer.",
    },
    SET_LOCATION: {
        type: "boolean",
        default: false,
        group: "behaviour",
        label: "Write AMS slot as location",
        description: "Stores printer name and AMS slot as the location of the spool in Spoolman.",
    },
    NEVER_MERGE_IF_TAG: {
        type: "boolean",
        default: false,
        group: "behaviour",
        label: "Never merge a tagged spool",
        description: "Skips any Spoolman spool that already carries a tag when looking for a merge candidate.",
    },
    OFFLINE_CHECK_INTERVAL: {
        type: "integer",
        default: 20000,
        min: 20000,
        max: 3600000,
        group: "behaviour",
        advanced: true,
        label: "Offline check interval",
        description: "Milliseconds between two reachability checks of a disconnected printer.",
    },
    MAX_RETRIES: {
        type: "integer",
        default: 0,
        min: 0,
        max: 1000,
        group: "behaviour",
        advanced: true,
        label: "Max connection retries",
        description: "Failed connection attempts before monitoring is disabled for a printer. 0 retries forever.",
    },
    DEBUG: {
        type: "boolean",
        default: false,
        group: "behaviour",
        advanced: true,
        label: "Debug logging",
        description: "Writes verbose debug lines into the log files.",
    },
};

/** Problems seen while loading the settings file, logged by backend.js. */
export const settingsLoadIssues = [];

/**
 * The resolved settings every other module reads.
 *
 * Mutated in place so that importers keep working against the same object.
 * Never reassign this binding.
 */
export const settings = {};

/**
 * Normalises the operation mode.
 *
 * "auto" is accepted as a shorthand for "automatic"; anything unrecognised
 * falls back to manual. `valid` is reported separately so a typo in the
 * environment variable can be warned about instead of silently behaving like
 * manual mode.
 *
 * @param {string|undefined} raw - the raw mode value
 * @returns {{raw: string, mode: "automatic"|"manual", valid: boolean}}
 */
export function resolveMode(raw) {
    const value = (raw || "manual").trim();
    const normalized = value.toLowerCase();
    return {
        raw: value,
        mode: normalized === "automatic" || normalized === "auto" ? "automatic" : "manual",
        valid: ["automatic", "auto", "manual"].includes(normalized),
    };
}

/**
 * Turns one raw value into the type the field expects.
 *
 * Accepts what both sources can deliver: a string from an environment variable
 * or an HTML form, and a real boolean or number from the settings file or a
 * JSON request body. An out of range number is clamped rather than rejected,
 * which is what the environment variables did before.
 *
 * @param {string} key - field name
 * @param {*} raw - the value to coerce
 * @returns {{value: *}|{error: string}} the coerced value, or a message
 */
export function coerceSetting(key, raw) {
    const field = SETTINGS_SCHEMA[key];
    if (!field) return { error: `Unknown setting "${key}"` };

    if (raw === null || raw === undefined || raw === "") {
        return { value: field.type === "string" ? null : field.default };
    }

    if (field.type === "string") {
        const value = String(raw).trim();
        return { value: value === "" ? null : value };
    }

    if (field.type === "boolean") {
        if (typeof raw === "boolean") return { value: raw };
        const value = String(raw).trim().toLowerCase();
        if (["true", "1", "yes", "on"].includes(value)) return { value: true };
        if (["false", "0", "no", "off"].includes(value)) return { value: false };
        return { error: `${key} must be true or false` };
    }

    if (field.type === "integer") {
        const parsed = typeof raw === "number" ? Math.trunc(raw) : parseInt(String(raw).trim(), 10);
        if (!Number.isFinite(parsed)) return { error: `${key} must be a whole number` };
        let value = parsed;
        if (field.min !== undefined) value = Math.max(value, field.min);
        if (field.max !== undefined) value = Math.min(value, field.max);
        return { value };
    }

    if (field.type === "enum") {
        if (key === "MODE") {
            const resolved = resolveMode(String(raw));
            if (!resolved.valid) return { error: `MODE "${resolved.raw}" is not valid, use "automatic" or "manual"` };
            return { value: resolved.mode };
        }
        const value = String(raw).trim().toLowerCase();
        if (!field.options.includes(value)) return { error: `${key} must be one of ${field.options.join(", ")}` };
        return { value };
    }

    return { error: `${key} has an unsupported type` };
}

/**
 * Builds the effective value of every field from default, environment seed and
 * stored file, in that order.
 *
 * A value that cannot be coerced does not abort the merge. It is reported and
 * the layer below it is kept, because refusing to start over one bad number in
 * a config file is worse than running with the documented default.
 *
 * @param {object} stored - the parsed settings file
 * @param {object} env - the raw environment values
 * @param {string[]} issues - collects messages about ignored values
 * @returns {object} the effective settings
 */
export function resolveSettings(stored = {}, env = {}, issues = []) {
    const resolved = {};

    for (const [key, field] of Object.entries(SETTINGS_SCHEMA)) {
        resolved[key] = field.default;

        for (const [layer, source] of [["environment", env], ["settings.json", stored]]) {
            if (source == null || !Object.prototype.hasOwnProperty.call(source, key)) continue;
            if (source[key] === undefined) continue;

            const result = coerceSetting(key, source[key]);
            if (result.error) {
                issues.push(`Ignoring ${key} from ${layer}: ${result.error}`);
                continue;
            }
            resolved[key] = result.value;
        }
    }

    return resolved;
}

/**
 * Reports where each field's effective value came from, so the Web UI can tell
 * the user that a value was seeded by an environment variable and is now owned
 * by the settings file.
 *
 * @param {object} stored - the parsed settings file
 * @param {object} env - the raw environment values
 * @returns {Object<string, "file"|"environment"|"default">}
 */
export function describeSources(stored = {}, env = {}) {
    const sources = {};
    for (const key of Object.keys(SETTINGS_SCHEMA)) {
        if (stored && stored[key] !== undefined) sources[key] = "file";
        else if (env && env[key] !== undefined && env[key] !== "") sources[key] = "environment";
        else sources[key] = "default";
    }
    return sources;
}

/**
 * The shape version of `settings.json`. Bump it when a stored key is renamed or
 * its meaning changes, and handle the old value in `migrateStored()`.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

let storedSettings = {};
// Counts writes. The settings page sends back the revision it read, so a save
// against a state somebody else has already replaced is refused rather than
// silently overwriting it.
let storedRevision = 0;

/**
 * Reads the two shapes the file can have.
 *
 * The first version stored the values flat at the top level. Everything since
 * wraps them, so the file can carry its schema version and the write counter.
 * Existing installs have the flat file on disk and there is no migration step,
 * so the read side stays tolerant of it.
 *
 * @param {object} parsed - the parsed file contents
 * @returns {{values: object, revision: number, schemaVersion: number}}
 */
export function parseStoredFile(parsed) {
    if (parsed && typeof parsed.values === "object" && parsed.values !== null && !Array.isArray(parsed.values)) {
        return {
            values: parsed.values,
            revision: Number.isInteger(parsed.revision) ? parsed.revision : 0,
            schemaVersion: Number.isInteger(parsed.schemaVersion) ? parsed.schemaVersion : SETTINGS_SCHEMA_VERSION,
        };
    }

    return { values: parsed ?? {}, revision: 0, schemaVersion: 0 };
}

/**
 * Brings a stored set of values up to the current schema version.
 *
 * Nothing to do yet: version 0 is the flat file, whose keys are the same. This
 * is the place for a rename, so that an old file does not lose the value
 * silently.
 *
 * @param {object} values - the stored values
 * @param {number} schemaVersion - the version they were written with
 * @returns {object} the values in the current shape
 */
export function migrateStored(values, schemaVersion) {
    if (schemaVersion >= SETTINGS_SCHEMA_VERSION) return values;
    return values;
}

/** Reads the settings file, treating a missing or unreadable file as empty. */
function readStoredSettings() {
    try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("settings.json must contain an object");
        }

        const file = parseStoredFile(parsed);
        storedRevision = file.revision;
        return migrateStored(file.values, file.schemaVersion);
    } catch (err) {
        if (err.code !== "ENOENT") {
            settingsLoadIssues.push(`Could not read settings.json, falling back to environment and defaults: ${err.message}`);
        }
        return {};
    }
}

/** Writes the settings file atomically, so a crash mid write cannot truncate it. */
function persist() {
    const tmp = `${settingsPath}.tmp`;
    const payload = {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        revision: storedRevision,
        values: storedSettings,
    };

    fs.ensureDirSync(path.dirname(settingsPath));
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 4));
    fs.renameSync(tmp, settingsPath);
}

/**
 * Loads the settings once at process start.
 *
 * Nothing is written here. The file appears on the first save from the Web UI,
 * so an installation that never opens the settings page keeps behaving exactly
 * like before, driven by its environment variables alone.
 */
function loadSettings() {
    storedSettings = readStoredSettings();
    Object.assign(settings, resolveSettings(storedSettings, envSeed, settingsLoadIssues));
}

loadSettings();

/**
 * The tracking mode this process runs in, frozen at startup.
 *
 * The two tracking modes are mutually exclusive and book consumption
 * differently, so switching while a print is in flight would book it twice or
 * not at all. `settings.LEGACY_MODE` therefore only holds what is stored and
 * what the settings page shows; everything that decides how a report is
 * processed reads this instead, and the stored value takes effect on the next
 * start. That is what the schema means by `restartRequired`.
 */
const bootLegacyMode = settings.LEGACY_MODE;

/** Whether this process is tracking through the AMS RFID remain percentage. */
export function legacyMode() {
    return bootLegacyMode;
}

/** Whether the stored tracking mode differs from the one this process started with. */
export function legacyModeNeedsRestart() {
    return settings.LEGACY_MODE !== bootLegacyMode;
}

/**
 * Builds the Spoolman base URL from a set of values.
 *
 * Takes the values explicitly so the settings page can test an endpoint before
 * it is saved. The endpoint wins over host and port; a subfolder is appended to
 * whichever of the two produced the base.
 *
 * @param {object} values - SPOOLMAN_ENDPOINT, SPOOLMAN_IP, SPOOLMAN_PORT and
 *   SPOOLMAN_SUBFOLDER, in the shape the schema defines
 * @returns {string} the base URL, or an empty string when nothing is configured
 */
export function buildSpoolmanUrl(values = {}) {
    let base = "";
    if (values.SPOOLMAN_ENDPOINT) {
        base = values.SPOOLMAN_ENDPOINT;
    } else if (values.SPOOLMAN_IP) {
        base = values.SPOOLMAN_PORT
            ? `http://${values.SPOOLMAN_IP}:${values.SPOOLMAN_PORT}`
            : `http://${values.SPOOLMAN_IP}`;
    }

    base = String(base).trim().replace(/\/+$/, "");
    if (!base) return "";

    return values.SPOOLMAN_SUBFOLDER ? `${base}${values.SPOOLMAN_SUBFOLDER}` : base;
}

/**
 * The Spoolman base URL the HTTP client talks to.
 *
 * Read through this function rather than a constant, because the endpoint can
 * change at runtime through the settings API.
 *
 * @returns {string} the base URL, or an empty string when nothing is configured
 */
export function spoolmanUrl() {
    return buildSpoolmanUrl(settings);
}

/** The current settings plus the metadata the Web UI needs to render them. */
export function getSettingsView() {
    return {
        values: { ...settings },
        sources: describeSources(storedSettings, envSeed),
        fields: Object.entries(SETTINGS_SCHEMA).map(([key, field]) => ({
            key,
            type: field.type,
            group: field.group,
            label: field.label,
            description: field.description,
            options: field.options ?? null,
            // Lets the page offer a way back to the documented value
            default: field.default ?? null,
            min: field.min ?? null,
            max: field.max ?? null,
            restartRequired: !!field.restartRequired,
            // Rendered inside the collapsed part of its group
            advanced: !!field.advanced,
        })),
        spoolmanUrl: spoolmanUrl(),
        // Set while a stored value waits for the next start, so the page can
        // keep saying so instead of showing it once after the save.
        restartPending: legacyModeNeedsRestart(),
        // Sent back with the next save, so a state somebody else has already
        // replaced is not overwritten silently.
        revision: storedRevision,
        // Whether a restart brings the service back on its own
        supervised,
    };
}

/**
 * Validates and applies a partial settings update, then persists it.
 *
 * All fields are validated before anything is written, so a rejected request
 * leaves the running configuration untouched instead of applying half of it.
 *
 * @param {object} patch - the fields to change
 * @param {number} [expectedRevision] - the revision the caller last read. When
 *   it no longer matches, the update is refused rather than overwriting what
 *   somebody else saved in the meantime. Omit it to skip the check.
 * @returns {{ok: true, changed: string[], restartRequired: string[]}|{ok: false, errors: string[], conflict?: boolean}}
 */
export function updateSettings(patch, expectedRevision) {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        return { ok: false, errors: ["Request body must be an object"] };
    }

    if (Number.isInteger(expectedRevision) && expectedRevision !== storedRevision) {
        return {
            ok: false,
            conflict: true,
            errors: ["The settings were changed somewhere else in the meantime"],
        };
    }

    const errors = [];
    const accepted = {};

    for (const [key, raw] of Object.entries(patch)) {
        const result = coerceSetting(key, raw);
        if (result.error) {
            errors.push(result.error);
            continue;
        }
        accepted[key] = result.value;
    }

    if (errors.length) return { ok: false, errors };

    const changed = Object.keys(accepted).filter(key => settings[key] !== accepted[key]);

    Object.assign(settings, accepted);
    storedSettings = { ...settings };
    storedRevision += 1;
    persist();

    return {
        ok: true,
        changed,
        restartRequired: changed.filter(key => SETTINGS_SCHEMA[key].restartRequired),
    };
}
