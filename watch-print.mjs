// Records only what a print changes, so the file stays readable: state
// transitions, the job name, the layer counter and print.mapping, which may be
// the printer's own answer to which slot each sliced filament came from.
import mqtt from "mqtt";
import fs from "node:fs";

const [,, ip, code, serial, out] = process.argv;
const client = mqtt.connect(`tls://bblp:${code}@${ip}:8883`, { rejectUnauthorized: false });
const log = line => fs.appendFileSync(out, `${new Date().toISOString()} ${line}\n`);

let last = "";
client.on("connect", () => { log("connected"); client.subscribe(`device/${serial}/report`); });
client.on("message", (_t, m) => {
    const p = JSON.parse(m.toString())?.print;
    if (!p) return;
    const now = JSON.stringify({
        state: p.gcode_state, job: p.subtask_name, layer: p.layer_num,
        total: p.total_layer_num, mapping: p.mapping, tray_now: p.ams?.tray_now,
    });
    if (now !== last) { log(now); last = now; }
});
client.on("error", e => log(`error ${e.message}`));
