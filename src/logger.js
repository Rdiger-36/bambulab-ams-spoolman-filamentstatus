import { promises as fsp } from "fs";
import path from "path";
import { serverLogFilePath } from "./config.js";
import { settings } from "./settings.js";
import { formatDateLog } from "./utils.js";

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

// --- Ordered file write queue (prevents concurrent write races) ---
const __logQueues = new Map();

/**
 * Runs a task after every task already queued for the same file has finished.
 *
 * All log writes for one file go through here, which is what keeps concurrent
 * appends and the read-modify-write in updateLastMatchingLine from interleaving.
 * A failing task never breaks the chain: the queue swallows the rejection and
 * carries on.
 *
 * @param {string} filePath - the log file the task operates on
 * @param {() => Promise<void>} taskFn - the work to run
 * @returns {Promise<void>} resolves when this task has run
 */
function enqueueTask(filePath, taskFn) {
    const prev = __logQueues.get(filePath) || Promise.resolve();
    const next = prev
        .catch(() => {})
        .then(() => taskFn());
    __logQueues.set(filePath, next);
    return next.catch(err => {
        try { originalConsoleLog(`[ERROR] Log task failed: ${err.message}`); } catch {}
    });
}

// Bytes appended per file since the last size check. Stat'ing on every line
// would mean a syscall per log message, so the size is only looked at once
// enough has been written for it to matter.
const __bytesSinceCheck = new Map();
const SIZE_CHECK_INTERVAL_BYTES = 64 * 1024;

/** Appends content to a log file through that file's write queue. */
function enqueueAppend(filePath, content) {
    return enqueueTask(filePath, async () => {
        await fsp.appendFile(filePath, content);

        const pending = (__bytesSinceCheck.get(filePath) || 0) + Buffer.byteLength(content);
        if (pending < SIZE_CHECK_INTERVAL_BYTES) {
            __bytesSinceCheck.set(filePath, pending);
            return;
        }

        __bytesSinceCheck.set(filePath, 0);
        // Already inside the queue, so this must not queue itself again
        await rotateNow(filePath, maxLogBytes(), keepFor(filePath));
    });
}

/**
 * Collapses a repeated message into the last line instead of appending it again.
 *
 * The read has to happen inside the queue: it used to run outside, so the file
 * was snapshotted before the write was scheduled and every line appended in
 * between was overwritten by that stale snapshot. With a collapsing message
 * firing every few seconds that silently ate most of the log.
 *
 * @param {string} logFilePath - the log file to rewrite
 * @param {string} messagePrefix - the prefix that marks a line as collapsible
 * @param {string} newLogMessage - the line replacing the last matching one
 */
function updateLastMatchingLine(logFilePath, messagePrefix, newLogMessage) {
    return enqueueTask(logFilePath, async () => {
        let data;
        try {
            data = await fsp.readFile(logFilePath, "utf8");
        } catch (err) {
            // No file yet is normal on the very first message
            if (err.code !== "ENOENT") {
                originalConsoleLog(`[ERROR] Failed to read log file: ${err.message}`);
                return;
            }
            data = "";
        }

        const lines = data.split("\n");
        if (lines.length && lines[lines.length - 1] === "") lines.pop();

        const lastLine = lines[lines.length - 1] || "";

        if (lastLine.includes(messagePrefix)) {
            lines[lines.length - 1] = newLogMessage.trimEnd();
        } else {
            lines.push(newLogMessage.trimEnd());
        }

        await fsp.writeFile(logFilePath, lines.join("\n") + "\n");
    });
}

const COLLAPSING_PREFIXES = [
    "No new AMS Data or changes in Spoolman found.",
    "MQTT not running for Printer",
    "Setting up MQTT connection for Printer",
    "MQTT client connected for Printer",
    "Waiting for MQTT messages for Printer",
    "Timeout",
    "Reconnecting",
    "Monitoring for following Printer stopped:",
];

/**
 * Joins console arguments into one string, JSON encoding anything that is not
 * already a string and falling back to String() for values JSON cannot handle,
 * such as a circular object.
 */
function safeStringify(args) {
    return args.map(a => {
        if (typeof a === "string") return a;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(" ");
}

/**
 * Writes a log line to stdout and to the given file.
 *
 * Overrides the global console.log with a different signature, so every call
 * site in this project must pass the device name and the target log file first.
 * Messages starting with one of COLLAPSING_PREFIXES replace the previous such
 * line rather than piling up, which keeps a reconnect loop from filling the file.
 *
 * @param {string} device - printer name, or "Server"
 * @param {string|null} logFilePath - target file, defaults to the server log
 * @param {...any} args - message parts, objects are JSON encoded
 */
console.log = (device, logFilePath, ...args) => {
    const logMessage = `[LOG] ${formatDateLog(new Date())} - ${device} - ${safeStringify(args)}`;
    originalConsoleLog(logMessage);

    const path = logFilePath || serverLogFilePath;
    const messageText = args.map(a => String(a)).join(" ");
    const collapsePrefix = COLLAPSING_PREFIXES.find(p => messageText.startsWith(p));
    if (collapsePrefix) {
        updateLastMatchingLine(path, collapsePrefix, logMessage);
    } else {
        enqueueAppend(path, logMessage + "\n");
    }
};

/**
 * Writes an error line to stderr and to the given file. Same signature as the
 * console.log override; errors are never collapsed.
 */
console.error = (device, logFilePath, ...args) => {
    const errorMessage = `[ERROR] ${formatDateLog(new Date())} - ${device} - ${safeStringify(args)}`;
    originalConsoleError(errorMessage);

    const path = logFilePath || serverLogFilePath;
    enqueueAppend(path, errorMessage + "\n");
};

/**
 * Writes a debug line, but only while debug logging is enabled in the settings.
 * Same signature as the console.log override.
 */
console.debug = (device, logFilePath, ...args) => {
    if (settings.DEBUG) {
        const debugMessage = `[DEBUG] ${formatDateLog(new Date())} - ${device} - ${safeStringify(args)}`;
        originalConsoleLog(debugMessage);

        const path = logFilePath || serverLogFilePath;
        enqueueAppend(path, debugMessage + "\n");
    }
};

/**
 * Reads the last lines of a log file without loading the whole file.
 *
 * Log files grow without bound, so the file is read backwards in chunks and
 * stops as soon as enough lines are collected. Blank lines are skipped and the
 * result is returned in normal top to bottom order.
 *
 * @param {string} filePath - the log file to read
 * @param {number} [maxLines=250] - how many lines to return at most
 * @param {number} [chunkSize=65536] - read size per backwards step, in bytes
 * @returns {Promise<string[]>} the last lines, oldest first
 */
export async function tailFileLines(filePath, maxLines = 250, chunkSize = 64 * 1024) {
    const fh = await fsp.open(filePath, "r");
    try {
        const stat = await fh.stat();
        let pos = stat.size;
        let leftover = "";
        const lines = [];

        while (pos > 0 && lines.length < maxLines) {
            const readSize = Math.min(chunkSize, pos);
            pos -= readSize;

            const buf = Buffer.alloc(readSize);
            await fh.read(buf, 0, readSize, pos);

            let chunk = buf.toString("utf8") + leftover;
            const parts = chunk.split("\n");
            leftover = parts.shift();

            for (let i = parts.length - 1; i >= 0 && lines.length < maxLines; i--) {
                const line = parts[i].trimEnd();
                if (line) lines.push(line);
            }
        }

        if (lines.length < maxLines && leftover) {
            const line = leftover.trimEnd();
            if (line) lines.push(line);
        }

        return lines.reverse();
    } finally {
        await fh.close();
    }
}

/**
 * Resolves once every write queued for a file has been flushed. Log writes are
 * fire-and-forget everywhere else; this exists so tests can assert on the file
 * without sleeping and guessing.
 */
export function flushLogs(filePath) {
    return (__logQueues.get(filePath) || Promise.resolve()).catch(() => {});
}

export { originalConsoleLog, originalConsoleError };

/** The size a log file may reach before it is rotated. */
function maxLogBytes() {
    return settings.LOG_MAX_SIZE_MB * 1024 * 1024;
}

/** How many old files are kept next to this one. */
function keepFor(filePath) {
    return filePath === serverLogFilePath ? settings.LOG_KEEP_SERVER : settings.LOG_KEEP_PRINTER;
}

/**
 * Rotates a log file when it has grown past the configured size.
 *
 * `server.log` becomes `server.log.1`, the previous `.1` becomes `.2` and so on
 * until the configured number is reached; the oldest one is deleted. Keeping
 * zero files starts the current one over instead, which is the same thing
 * without the history.
 *
 * Goes through the write queue of that file, because a rename between two
 * queued appends would send the lines in between to the rotated file, or to a
 * file nobody reads any more.
 *
 * @param {string} filePath - the log file
 * @param {object} [options] - overrides for the test
 * @returns {Promise<boolean>} whether it was rotated
 */
export function rotateLogFile(filePath, { maxBytes, keep } = {}) {
    return enqueueTask(filePath, () => rotateNow(
        filePath,
        maxBytes ?? maxLogBytes(),
        keep ?? keepFor(filePath),
    ));
}

/** The rotation itself. Only ever called from inside a file's write queue. */
async function rotateNow(filePath, maxBytes, keep) {
    try {
        const stat = await fsp.stat(filePath);
        if (stat.size <= maxBytes) return false;
    } catch (err) {
        // A missing file is the normal first run case
        if (err.code === "ENOENT") return false;
        originalConsoleError(`[ERROR] Could not check the size of ${filePath}: ${err.message}`);
        return false;
    }

    try {
        if (keep <= 0) {
            await fsp.writeFile(filePath, "");
            return true;
        }

        await fsp.rm(`${filePath}.${keep}`, { force: true });
        for (let i = keep - 1; i >= 1; i--) {
            // Most of these do not exist yet while the history is filling up
            await fsp.rename(`${filePath}.${i}`, `${filePath}.${i + 1}`).catch(() => {});
        }

        await fsp.rename(filePath, `${filePath}.1`);
        await fsp.writeFile(filePath, "");
        return true;
    } catch (err) {
        originalConsoleError(`[ERROR] Could not rotate ${filePath}: ${err.message}`);
        return false;
    }
}

/**
 * The files a log consists of, newest first: the current one, then the rotated
 * `<name>.log.1`, `.2` and so on.
 *
 * The directory is listed rather than counting up from `.1`, so a history left
 * behind by a since lowered keep count is still found instead of stopping at
 * the first gap. Files that do not exist are left out, so the result is empty
 * before anything has been logged.
 *
 * @param {string} filePath - the current log file
 * @returns {Promise<string[]>} existing paths, newest first
 */
export async function logFileSet(filePath) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);

    let entries;
    try {
        entries = await fsp.readdir(dir);
    } catch (err) {
        if (err.code !== "ENOENT") {
            originalConsoleError(`[ERROR] Could not list ${dir}: ${err.message}`);
        }
        return [];
    }

    const rotated = entries
        .map(name => {
            const match = name.startsWith(`${base}.`) && /^\d+$/.test(name.slice(base.length + 1))
                ? Number(name.slice(base.length + 1))
                : null;
            return match === null ? null : { index: match, path: path.join(dir, name) };
        })
        .filter(Boolean)
        .sort((a, b) => a.index - b.index)
        .map(entry => entry.path);

    return entries.includes(base) ? [filePath, ...rotated] : rotated;
}

/**
 * Reads the last lines of a log, continuing into the rotated files when the
 * current one does not hold enough of them.
 *
 * Without this the viewer goes blank right after a rotation, because everything
 * written before it sits in `<name>.log.1`.
 *
 * @param {string} filePath - the current log file
 * @param {number} [maxLines=250] - how many lines to return at most
 * @returns {Promise<string[]>} the last lines across the files, oldest first
 */
export async function tailLogLines(filePath, maxLines = 250) {
    const files = await logFileSet(filePath);
    const lines = [];

    for (const file of files) {
        if (lines.length >= maxLines) break;
        try {
            const older = await tailFileLines(file, maxLines - lines.length);
            lines.unshift(...older);
        } catch (err) {
            // A file rotated away between the listing and the read is normal
            if (err.code !== "ENOENT") throw err;
        }
    }

    return lines;
}
