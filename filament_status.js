import mqtt from "async-mqtt";
import got from "got";
import { config } from "dotenv";

// Load environment variables from .env
config();

const PRINTER_ID = process.env.PRINTER_ID;
const PRINTER_CODE = process.env.PRINTER_CODE;
const PRINTER_IP = process.env.PRINTER_IP;
const SPOOLMAN_IP = process.env.SPOOLMAN_IP;
const SPOOLMAN_PORT = process.env.SPOOLMAN_PORT;
const UPDATE_INTERVAL = process.env.UPDATE_INTERVAL 
  ? Math.max(parseInt(process.env.UPDATE_INTERVAL, 10), 1000) 
  : 120000;

const lastUpdateTimes = {};
const notFoundSpools = {}; // Track unresolved spools with timestamps

async function num2letter(num) {
  return String.fromCharCode("A".charCodeAt(0) + Number(num));
}

async function main() {
  try {
    const client = await mqtt.connectAsync(`tls://bblp:${PRINTER_CODE}@${PRINTER_IP}:8883`, {
      rejectUnauthorized: false,
    });

    console.log("MQTT client connected");

    await client.subscribe(`device/${PRINTER_ID}/report`);
    console.log(`Subscribed to device/${PRINTER_ID}/report`);

    client.on("message", async (topic, message) => {
      try {
        const data = JSON.parse(message);

        if (data?.print?.ams?.ams) {
          const response = await got(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/spool`);
          const spools = JSON.parse(response.body);

          for (const ams of data.print.ams.ams) {
            let amsHeaderPrinted = false;

            for (const slot of ams.tray) {
              if (slot.remain < 0) continue;

              let found = false;
              const currentTime = Date.now();

              for (const spool of spools) {
                if (spool.extra?.tag && JSON.parse(spool.extra.tag) === slot.tray_uuid) {
                  found = true;

                  if (
                    lastUpdateTimes[spool.id] &&
                    currentTime - lastUpdateTimes[spool.id] < UPDATE_INTERVAL
                  ) break;

                  if (!amsHeaderPrinted) {
                    console.log(`AMS [${await num2letter(ams.id)}] (hum: ${ams.humidity}, temp: ${ams.temp}ºC)`);
                    amsHeaderPrinted = true;
                  }

                  console.log(
                    `    - [${await num2letter(ams.id)}${slot.id}] ${slot.tray_sub_brands} ${slot.tray_color} (${slot.remain}%) [[ ${slot.tray_uuid} ]]`
                  );

                  await got.patch(`http://${SPOOLMAN_IP}:${SPOOLMAN_PORT}/api/v1/spool/${spool.id}`, {
                    json: { remaining_weight: (slot.remain / 100) * slot.tray_weight },
                  });

                  console.log(`      - Updated spool ${spool.id}`);
                  lastUpdateTimes[spool.id] = currentTime;

                  // Remove from "Not Found" list if it was there
                  if (notFoundSpools[slot.tray_uuid]) delete notFoundSpools[slot.tray_uuid];
                  break;
                }
              }

              if (!found) {
                const previousLogTime = notFoundSpools[slot.tray_uuid] || 0;

                if (currentTime - previousLogTime >= UPDATE_INTERVAL) {
                  if (!amsHeaderPrinted) {
                    console.log(`AMS [${await num2letter(ams.id)}] (hum: ${ams.humidity}, temp: ${ams.temp}ºC)`);
                    amsHeaderPrinted = true;
                  }

                  console.log(
                    `    - [${await num2letter(ams.id)}${slot.id}] ${slot.tray_sub_brands} ${slot.tray_color} (${slot.remain}%) [[ ${slot.tray_uuid} ]]`
                  );
                  console.log("      - Not found. Update spool tag!");

                  // Update the last log time for this "Not Found" spool
                  notFoundSpools[slot.tray_uuid] = currentTime;
                }
              }
            }
          }
        }
      } catch (e) {
        console.error(`Error in message handler: ${e}`);
      }
    });

    console.log("Waiting for MQTT messages...");
  } catch (e) {
    console.error(`Error in main: ${e}`);
  }
}

main();