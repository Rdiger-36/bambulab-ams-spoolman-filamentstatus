import { promises as fsp } from "fs";
import { DEBUG, serverLogFilePath } from "./config.js";
import { formatDateLog } from "./utils.js";

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

// --- Ordered file write queue (prevents concurrent write races) ---
const __logQueues = new Map();

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

function enqueueAppend(filePath, content) {
    return enqueueTask(filePath, () => fsp.appendFile(filePath, content));
}

// Collapses a repeated message into the last line instead of appending it again.
//
// The read has to happen inside the queue: it used to run outside, so the file
// was snapshotted before the write was scheduled and every line appended in
// between was overwritten by that stale snapshot. With a collapsing message
// firing every few seconds that silently ate most of the log.
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

function safeStringify(args) {
    return args.map(a => {
        if (typeof a === "string") return a;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(" ");
}

// Override console.log — signature: (device, logFilePath, ...args)
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

// Override console.error — signature: (device, logFilePath, ...args)
console.error = (device, logFilePath, ...args) => {
    const errorMessage = `[ERROR] ${formatDateLog(new Date())} - ${device} - ${safeStringify(args)}`;
    originalConsoleError(errorMessage);

    const path = logFilePath || serverLogFilePath;
    enqueueAppend(path, errorMessage + "\n");
};

// Override console.debug — signature: (device, logFilePath, ...args)
console.debug = (device, logFilePath, ...args) => {
    if (DEBUG === "true") {
        const debugMessage = `[DEBUG] ${formatDateLog(new Date())} - ${device} - ${safeStringify(args)}`;
        originalConsoleLog(debugMessage);

        const path = logFilePath || serverLogFilePath;
        enqueueAppend(path, debugMessage + "\n");
    }
};

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
