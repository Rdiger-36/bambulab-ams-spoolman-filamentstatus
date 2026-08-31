import { promises as fsp } from "fs";
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

/** Appends content to a log file through that file's write queue. */
function enqueueAppend(filePath, content) {
    return enqueueTask(filePath, () => fsp.appendFile(filePath, content));
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

/**
 * Trims a log file to its last lines when it has grown past a limit.
 *
 * The server log used to be truncated on every start, which was the only thing
 * keeping it small. Since it is appended to now, so that a restart does not
 * take the lines with it, this is what keeps it from growing forever.
 *
 * @param {string} filePath - the log file
 * @param {number} [maxBytes] - size above which the file is trimmed
 * @param {number} [keepLines] - how many lines to keep when trimming
 */
export async function trimLogFile(filePath, maxBytes = 1024 * 1024, keepLines = 2000) {
    try {
        const stat = await fsp.stat(filePath);
        if (stat.size <= maxBytes) return;

        const lines = await tailFileLines(filePath, keepLines);
        await fsp.writeFile(filePath, lines.join("\n") + "\n");
    } catch (err) {
        // A missing file is the normal first run case, everything else is not
        // worth taking the start down for.
        if (err.code !== "ENOENT") {
            originalConsoleError(`[ERROR] Could not trim ${filePath}: ${err.message}`);
        }
    }
}
