import * as ftp from "basic-ftp";

/**
 * Lists the files a printer keeps on its storage, over FTPS, and exits.
 *
 * The sliced file of a print is fetched from the printer by name, and where
 * the printer keeps it differs between models and between the ways a print
 * reaches the printer: `/cache/<job>.gcode.3mf` from the slicer over the LAN,
 * `/cache/<job>.3mf` through the cloud, the root on older firmware. A printer
 * that keeps it somewhere else again is invisible in the log, which only says
 * which paths were tried. This prints what is really there, two levels deep,
 * so a report can name the path.
 *
 * `ipcam` and `timelapse` are skipped: hundreds of recordings, none of them a
 * sliced file. `curl` is no substitute on a Mac, its LibreSSL build returns an
 * empty listing from a Bambu printer.
 *
 * Usage: node scripts/list-files.js <ip> <code>
 *
 * This runs outside the service, so the plain console is correct here. It
 * deliberately imports nothing from src/, because src/gcode.js pulls in the
 * logger and its console override.
 */

const [,, ip, code] = process.argv;

if (!ip || !code) {
    console.error("Usage: node scripts/list-files.js <ip> <code>");
    process.exit(1);
}

const SKIPPED = new Set(["ipcam", "timelapse"]);
const MAX_DEPTH = 2;

const client = new ftp.Client(20000);

/**
 * Prints one directory and descends into its subdirectories.
 *
 * @param {string} dir - absolute path on the printer
 * @param {number} depth - 0 for the root
 */
async function walk(dir, depth) {
    const entries = await client.list(dir);
    for (const entry of entries) {
        const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
        const kind = entry.isDirectory ? "d" : "-";
        console.log(`${kind} ${String(entry.size).padStart(10)}  ${entry.rawModifiedAt.padEnd(12)}  ${path}`);
        if (entry.isDirectory && depth < MAX_DEPTH && !SKIPPED.has(entry.name)) {
            await walk(path, depth + 1);
        }
    }
}

try {
    await client.access({
        host: ip,
        port: 990,
        user: "bblp",
        password: code,
        secure: "implicit",
        secureOptions: { rejectUnauthorized: false },
    });
    console.error(`Files on ${ip}, two levels deep, without ipcam and timelapse:`);
    await walk("/", 0);
} catch (error) {
    console.error(`Could not list ${ip}: ${error.message}`);
    process.exitCode = 2;
} finally {
    client.close();
}
