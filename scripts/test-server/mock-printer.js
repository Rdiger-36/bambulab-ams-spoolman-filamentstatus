import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { AMS_UNITS, EXTERNAL_SPOOL } from "./scenario.js";

/**
 * A Bambu Lab printer that only exists in this process.
 *
 * It answers on 8883 over TLS, speaks just enough MQTT 3.1.1 for the service to
 * connect and subscribe, and then publishes the scenario as a `push_status`
 * report on `device/<serial>/report` on a timer.
 *
 * The broker is written out here rather than pulled in as a dependency. Six
 * packet types are all this needs, and `package.json` is what the container
 * installs from, so a broker library would ship in the image for the sake of a
 * script that never runs there.
 *
 * The certificate is self signed and thrown away with the process. That is what
 * a real printer presents too, which is why `setupMqtt()` connects with
 * `rejectUnauthorized: false`.
 */

const CONNECT = 1;
const PUBLISH = 3;
const SUBSCRIBE = 8;
const UNSUBSCRIBE = 10;
const PINGREQ = 12;
const DISCONNECT = 14;

/**
 * A throwaway key and certificate for the TLS listener.
 *
 * openssl is on the PATH on macOS and Linux and is installed in the image, so
 * shelling out avoids a dependency for something no production path uses.
 */
function selfSignedCertificate() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-mock-printer-"));
    const keyPath = path.join(dir, "key.pem");
    const certPath = path.join(dir, "cert.pem");

    execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", certPath,
        "-days", "1", "-subj", "/CN=mock-printer",
    ], { stdio: "ignore" });

    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

/** MQTT encodes a packet length as a base 128 varint of up to four bytes. */
function encodeRemainingLength(length) {
    const bytes = [];
    let value = length;

    do {
        let byte = value % 128;
        value = Math.floor(value / 128);
        if (value > 0) byte |= 128;
        bytes.push(byte);
    } while (value > 0);

    return Buffer.from(bytes);
}

/**
 * Reads the varint back.
 *
 * @returns {{value: number, bytes: number}|null} null while the buffer is still
 *          short of the whole varint
 */
function decodeRemainingLength(buffer, offset) {
    let multiplier = 1;
    let value = 0;
    let index = offset;
    let byte;

    do {
        if (index >= buffer.length) return null;
        if (index - offset === 4) throw new Error("Malformed remaining length");
        byte = buffer[index++];
        value += (byte & 127) * multiplier;
        multiplier *= 128;
    } while ((byte & 128) !== 0);

    return { value, bytes: index - offset };
}

/** A QoS 0 PUBLISH, the only packet the printer side ever sends unprompted. */
function publishPacket(topic, payload) {
    const topicBuffer = Buffer.from(topic, "utf8");
    const topicLength = Buffer.alloc(2);
    topicLength.writeUInt16BE(topicBuffer.length);

    const body = Buffer.concat([topicLength, topicBuffer, Buffer.from(payload, "utf8")]);
    return Buffer.concat([Buffer.from([0x30]), encodeRemainingLength(body.length), body]);
}

/** The topic filters of a SUBSCRIBE, with the packet id in front of them. */
function parseSubscribe(payload) {
    const packetId = payload.readUInt16BE(0);
    const topics = [];
    let offset = 2;

    while (offset + 2 <= payload.length) {
        const length = payload.readUInt16BE(offset);
        offset += 2;
        topics.push(payload.toString("utf8", offset, offset + length));
        // One byte of requested QoS follows every filter.
        offset += length + 1;
    }

    return { packetId, topics };
}

/**
 * Whether a subscription covers a topic. Only the two wildcards MQTT defines,
 * which is more than the service needs but keeps a mistyped filter honest.
 */
function topicMatches(filter, topic) {
    const filterParts = filter.split("/");
    const topicParts = topic.split("/");

    for (let i = 0; i < filterParts.length; i++) {
        if (filterParts[i] === "#") return true;
        if (i >= topicParts.length) return false;
        if (filterParts[i] !== "+" && filterParts[i] !== topicParts[i]) return false;
    }

    return filterParts.length === topicParts.length;
}

/** The report the printer publishes, in the shape `handleMqttMessage()` reads. */
function buildReport(fixture) {
    // A fixture is sent as it was captured, apart from the sequence id, which
    // is the one field a printer never repeats. The point of a fixture is to
    // see what the service makes of a report nobody here can produce, so
    // nothing else is touched.
    if (fixture) {
        return JSON.stringify({ print: { ...fixture, sequence_id: String(Date.now()) } });
    }

    return JSON.stringify({
        print: {
            command: "push_status",
            msg: 0,
            sequence_id: String(Date.now()),
            gcode_state: "IDLE",
            layer_num: 0,
            subtask_name: "",
            // The external spool holder, which the printer reports outside the
            // AMS block. Older firmware called the same thing vt_tray.
            vir_slot: EXTERNAL_SPOOL,
            nozzle_temper: 24.4,
            bed_temper: 23.1,
            ams: {
                ams: AMS_UNITS,
                ams_exist_bits: "f",
                tray_exist_bits: "ffff",
                tray_is_bbl_bits: "ffff",
                tray_now: "0",
                tray_pre: "0",
                tray_read_done_bits: "ffff",
                tray_reading_bits: "0",
                version: 1,
            },
        },
    });
}

/**
 * The `print` block of a captured report under test/fixtures/reports.
 *
 * Those files are what real printers sent, most of them printers nobody here
 * owns, so publishing one is the only way to see the dashboard draw an AMS
 * Lite, an AMS HT or a second external holder. The README in that directory
 * says what each one holds.
 *
 * @param {string} name - file name without the extension, for example "x1c-multi-ams"
 * @returns {object} the report's `print` block
 */
export function loadReport(name) {
    const file = path.join(REPORTS_DIR, `${name}.json`);
    if (!fs.existsSync(file)) {
        const available = fs.readdirSync(REPORTS_DIR)
            .filter(entry => entry.endsWith(".json"))
            .map(entry => entry.replace(/\.json$/, ""))
            .sort();
        throw new Error(`no report fixture "${name}", available: ${available.join(", ")}`);
    }
    return JSON.parse(fs.readFileSync(file, "utf8")).pushall.print;
}

const REPORTS_DIR = path.join(
    path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
    "test", "fixtures", "reports",
);

/**
 * Starts the mock printer.
 *
 * @param {object} options
 * @param {string} options.serial - serial number, which is part of the topic
 * @param {number} options.port - TLS port, 8883 on a real printer
 * @param {number} options.interval - milliseconds between two reports
 * @param {(line: string) => void} options.log - where connection lines go
 * @param {object} [options.report] - a captured `print` block from `loadReport()`, published instead of the scenario
 * @returns {Promise<{close: () => Promise<void>, reports: () => number}>}
 */
export function startMockPrinter({ serial, port, interval, log, report = null }) {
    const topic = `device/${serial}/report`;
    const clients = new Set();
    let reports = 0;

    const server = tls.createServer({ ...selfSignedCertificate() }, socket => {
        const client = { socket, subscriptions: [] };
        clients.add(client);
        log(`client connected from ${socket.remoteAddress}`);

        let buffer = Buffer.alloc(0);

        socket.on("data", chunk => {
            buffer = Buffer.concat([buffer, chunk]);

            for (;;) {
                if (buffer.length < 2) return;

                let header;
                try {
                    header = decodeRemainingLength(buffer, 1);
                } catch (error) {
                    log(`dropping a client: ${error.message}`);
                    socket.destroy();
                    return;
                }
                if (!header) return;

                const total = 1 + header.bytes + header.value;
                if (buffer.length < total) return;

                const type = buffer[0] >> 4;
                const payload = buffer.subarray(1 + header.bytes, total);
                buffer = buffer.subarray(total);

                handlePacket(client, type, payload, log);
            }
        });

        socket.on("error", () => { /* a client going away is not an event here */ });
        socket.on("close", () => {
            clients.delete(client);
            log("client disconnected");
        });
    });

    // The service checks whether the printer answers on the port at all before
    // it connects, with a bare TCP socket that never completes a handshake.
    server.on("tlsClientError", () => {});

    const timer = setInterval(() => {
        const payload = buildReport(report);
        let sent = 0;

        for (const client of clients) {
            if (!client.subscriptions.some(filter => topicMatches(filter, topic))) continue;
            client.socket.write(publishPacket(topic, payload));
            sent++;
        }

        if (sent) reports++;
    }, interval);

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
            log(`listening on ${port}, publishing ${topic} every ${interval} ms`);
            resolve({
                reports: () => reports,
                close: () => new Promise(done => {
                    clearInterval(timer);
                    for (const client of clients) client.socket.destroy();
                    server.close(() => done());
                }),
            });
        });
    });
}

/** Answers the packets a subscribing client sends, and ignores the rest. */
function handlePacket(client, type, payload, log) {
    switch (type) {
        case CONNECT:
            // Accepted unconditionally: the access code a real printer checks is
            // not what this is here to exercise.
            client.socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
            break;

        case SUBSCRIBE: {
            const { packetId, topics } = parseSubscribe(payload);
            client.subscriptions.push(...topics);
            log(`subscribed to ${topics.join(", ")}`);

            const granted = Buffer.alloc(2 + topics.length);
            granted.writeUInt16BE(packetId, 0);
            client.socket.write(Buffer.concat([
                Buffer.from([0x90]),
                encodeRemainingLength(granted.length),
                granted,
            ]));
            break;
        }

        case UNSUBSCRIBE: {
            const packetId = payload.readUInt16BE(0);
            client.subscriptions = [];
            const acknowledgement = Buffer.alloc(2);
            acknowledgement.writeUInt16BE(packetId, 0);
            client.socket.write(Buffer.concat([Buffer.from([0xB0, 0x02]), acknowledgement]));
            break;
        }

        case PINGREQ:
            client.socket.write(Buffer.from([0xD0, 0x00]));
            break;

        case DISCONNECT:
            client.socket.end();
            break;

        case PUBLISH:
            // The service only ever subscribes, so anything arriving here is a
            // command a real printer would act on and this one has no state for.
            break;

        default:
            log(`ignoring packet type ${type}`);
    }
}
