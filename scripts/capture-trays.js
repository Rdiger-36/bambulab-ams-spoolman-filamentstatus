import mqtt from "mqtt";

/**
 * Prints the AMS tray records of a printer once and exits.
 *
 * `scripts/mqtt.js` prints the whole report, which is thousands of characters
 * of print state, temperatures and calibration for every message. This waits
 * for the first report that carries AMS data and prints only the trays, which
 * is what a question about a slot is ever about.
 *
 * Written for reading the fields this service guesses at: `cols` on a multi
 * colour spool, and the `tray_info_idx` and `tray_sub_brands` of a filament
 * nobody here owns.
 *
 * Usage: node scripts/capture-trays.js <ip> <code> <serial>
 *
 * This runs outside the service, so the plain console is correct here.
 */

const [,, ip, code, serial] = process.argv;

if (!ip || !code || !serial) {
    console.error("Usage: node scripts/capture-trays.js <ip> <code> <serial>");
    process.exit(1);
}

console.error(`Connecting to ${ip}:8883 and waiting for a report with AMS data...`);

const client = mqtt.connect(`tls://bblp:${code}@${ip}:8883`, { rejectUnauthorized: false });

// A printer sends many reports without an `ams` block, so give it long enough
// to send one that has it rather than declaring failure on the first message.
const timeout = setTimeout(() => {
    console.error("No AMS data within 60 seconds. Is an AMS attached and is the serial correct?");
    client.end(true);
    process.exit(2);
}, 60000);

client.on("connect", () => {
    client.subscribe(`device/${serial}/report`, error => {
        if (error) {
            console.error("Subscription error:", error.message);
            client.end(true);
            process.exit(1);
        }
    });
});

client.on("message", (_topic, message) => {
    let units;
    try {
        units = JSON.parse(message.toString())?.print?.ams?.ams;
    } catch {
        return;
    }
    if (!Array.isArray(units)) return;

    clearTimeout(timeout);
    // Only the trays, and the unit id they sit in, so the output can be pasted
    // somewhere without carrying the printer's serial number with it.
    console.log(JSON.stringify(units.map(unit => ({ id: unit.id, tray: unit.tray })), null, 4));
    client.end();
    process.exit(0);
});

client.on("error", error => {
    console.error("MQTT error:", error.message);
    client.end(true);
    process.exit(1);
});
