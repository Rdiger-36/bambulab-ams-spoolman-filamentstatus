/**
 * Masking for everything that leaves the installation.
 *
 * Logs and configuration end up attached to bug reports, and both carry enough
 * to describe somebody's home network: the address of every printer and of
 * Spoolman, the serial numbers, and in `printers.json` the access codes. The
 * anonymised download replaces all of it before the file is handed out, so a
 * user does not have to choose between helping with a report and publishing
 * their network.
 *
 * What is deliberately *not* masked: printer names, because they are chosen by
 * the user and are what makes a log readable, and the RFID tag ids of the
 * spools, which identify a piece of filament rather than a person. A user who
 * considers their printer name identifying should pick the full export and
 * redact it themselves.
 *
 * Every function here is pure, which is what lets the tests pin the exact shape
 * of the output rather than just its absence.
 */

/** Replaces an access code entirely, per the rule that none of it is useful. */
export const MASKED_CODE = "XXX";

const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
// Bambu serial numbers are 15 upper case alphanumerics with at least one digit.
// This is the fallback that catches the serial of a printer which was removed
// from the list but is still in an older log file; a configured printer is
// masked from the known list before this ever runs.
//
// It used to require a leading zero, which is what the P1S examples in the
// README look like. A real P2S reports 22E8BJ581201877, so that pattern missed
// every P2S. The tray_uuid of a spool is 32 characters and has no word boundary
// inside it, so this cannot bite a piece of it out.
const BAMBU_SERIAL = /\b(?=[0-9A-Z]{15}\b)[0-9A-Z]*\d[0-9A-Z]*\b/g;

/** True for a string that is an IPv4 address and nothing else. */
function isIpv4(value) {
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * Masks the last octet of an IPv4 address, or the tail of an IPv6 one.
 *
 * The network part is kept on purpose: "192.168.1.XXX" still says the printer
 * and Spoolman are on the same subnet, which is half of the connection problems
 * people report, while the host itself is gone.
 *
 * @param {string} value - the address
 * @returns {string} the masked address, or the input when it is not one
 */
export function maskIp(value) {
    const address = String(value ?? "");

    if (isIpv4(address)) return address.replace(/\.\d{1,3}$/, ".XXX");

    if (address.includes(":") && /^[0-9a-fA-F:]+$/.test(address)) {
        const groups = address.split(":");
        return groups.map((group, index) => (index < 2 || group === "" ? group : "XXXX")).join(":");
    }

    return address;
}

/**
 * Keeps the first five characters of a serial number and replaces the rest.
 *
 * Five is enough to tell the printer model and the batch apart, which is what a
 * report is usually about, and short enough not to identify the device.
 *
 * @param {string} value - the serial number
 * @returns {string} the masked serial, the same length as the input
 */
export function maskSerial(value) {
    const serial = String(value ?? "");
    if (serial.length <= 5) return serial;
    return serial.slice(0, 5) + "X".repeat(serial.length - 5);
}

/**
 * Masks a host name or address.
 *
 * An address loses its last octet. A name keeps only its last label, so
 * `spoolman.example.net` becomes `XXX.XXX.net`: the shape survives, the domain
 * does not. A single label, `localhost` or a container name, is not identifying
 * and is kept.
 *
 * @param {string} value - host name or address
 * @returns {string} the masked host
 */
export function maskHost(value) {
    const host = String(value ?? "").trim();
    if (!host) return host;
    if (isIpv4(host) || (host.includes(":") && /^[0-9a-fA-F:]+$/.test(host))) return maskIp(host);

    const labels = host.split(".");
    if (labels.length < 2) return host;

    return labels.map((label, index) => (index === labels.length - 1 ? label : "XXX")).join(".");
}

/**
 * Masks the host of a URL and keeps everything that makes it debuggable: the
 * scheme, the port and the path, because a wrong port or a forgotten subfolder
 * is exactly the kind of thing a report is about.
 *
 * @param {string} value - the URL
 * @returns {string} the URL with a masked host
 */
export function maskUrl(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return raw;

    let url;
    try {
        url = new URL(raw);
    } catch {
        // Not a URL, so there is nothing to keep the shape of
        return maskHost(raw);
    }

    // Rebuilt rather than serialised through URL, whose hostname setter lower
    // cases what it is given and would turn the mask back into "xxx". Building
    // it by hand also drops any user and password in the URL, which is the right
    // thing to do in an export.
    const masked = maskHost(url.hostname);
    const host = masked.includes(":") ? `[${masked}]` : masked;
    const port = url.port ? `:${url.port}` : "";
    const path = url.pathname === "/" && !raw.replace(/^\w+:\/\/[^/]*/, "") ? "" : url.pathname;

    return `${url.protocol}//${host}${port}${path}${url.search}`;
}

/**
 * Shortens a file system path to its last two segments.
 *
 * A container path is `/app/printers` and says nothing, but the same service run
 * from a checkout carries the home directory and with it the user's name. Only
 * the tail is ever interesting in a report.
 *
 * @param {string} value - the path
 * @returns {string} the shortened path
 */
export function maskPath(value) {
    const parts = String(value ?? "").split("/").filter(Boolean);
    if (parts.length <= 2) return value;
    return `.../${parts.slice(-2).join("/")}`;
}

/** Escapes a string for use inside a regular expression. */
function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces access codes wherever they appear in a text.
 *
 * Split out of `maskText` because it runs on the *full* export as well: the
 * service never writes an access code to a log on purpose, but "on purpose" is
 * not a guarantee worth exporting, and a code is the one value that is never
 * useful in a bug report.
 *
 * @param {string} text - the text
 * @param {string[]} codes - the access codes to remove
 * @returns {string} the text without them
 */
export function maskCodes(text, codes = []) {
    let out = String(text ?? "");

    // Longest first, so a code that contains another one cannot leave a tail
    for (const code of [...codes].filter(Boolean).sort((a, b) => b.length - a.length)) {
        out = out.replaceAll(code, MASKED_CODE);
    }

    return out;
}

/**
 * Masks a block of text, typically a log file.
 *
 * The known values are replaced first and the generic patterns after them, so
 * an access code that happens to look like something else is still gone. The
 * generic passes are what covers a printer that has since been removed from the
 * list, whose address and serial are still in the older log files.
 *
 * @param {string} text - the text to mask
 * @param {object} [known]
 * @param {string[]} [known.codes] - access codes, replaced wherever they appear
 * @param {string[]} [known.serials] - serial numbers
 * @param {string[]} [known.hosts] - host names that no generic pattern catches
 * @returns {string} the masked text
 */
export function maskText(text, known = {}) {
    let out = String(text ?? "");

    // Serials before codes, and not the other way round: an eight character
    // access code can appear inside a fifteen character serial number, and
    // replacing it first would cut the serial into pieces that the serial pass
    // no longer recognises. Masking the serial first removes that overlap.
    for (const serial of [...(known.serials ?? [])].filter(Boolean)) {
        out = out.replaceAll(serial, maskSerial(serial));
    }
    out = out.replace(BAMBU_SERIAL, match => maskSerial(match));

    out = maskCodes(out, known.codes ?? []);

    // Only names here; addresses are handled by the generic pass below
    for (const host of [...(known.hosts ?? [])].filter(Boolean).sort((a, b) => b.length - a.length)) {
        if (isIpv4(host)) continue;
        out = out.replace(new RegExp(escapeRegExp(host), "g"), maskHost(host));
    }

    out = out.replace(IPV4, (match, a, b, c) => `${a}.${b}.${c}.XXX`);

    return out;
}

/**
 * The printer list as it is handed out in an export.
 *
 * The access code is replaced in both variants. It is the one value that is
 * never useful in a bug report and always harmful in one, so the full export
 * does not carry it either; "full" refers to the addresses and serials.
 *
 * @param {object[]} entries - printer entries
 * @param {boolean} anonymize - whether to mask addresses and serials as well
 * @returns {object[]} the entries for the export
 */
export function exportPrinters(entries, anonymize) {
    return entries.map(entry => ({
        id: anonymize ? maskSerial(entry.id) : entry.id,
        ip: anonymize ? maskIp(entry.ip) : entry.ip,
        name: entry.name,
        code: MASKED_CODE,
    }));
}

/**
 * The settings as they are handed out in an export.
 *
 * Only the four fields that carry an address are touched; every other setting
 * is a number or a flag and says nothing about the installation.
 *
 * @param {object} values - the settings values
 * @param {boolean} anonymize - whether to mask the addresses
 * @returns {object} the values for the export
 */
export function exportSettings(values, anonymize) {
    if (!anonymize) return { ...values };

    const out = { ...values };
    for (const key of ["SPOOLMAN_ENDPOINT", "SPOOLMAN_FQDN"]) {
        if (out[key]) out[key] = maskUrl(out[key]);
    }
    if (out.SPOOLMAN_IP) out.SPOOLMAN_IP = maskHost(out.SPOOLMAN_IP);

    return out;
}
