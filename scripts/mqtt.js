import mqtt from "mqtt";

const [,, ip, code, serial] = process.argv;

if (!ip || !code || !serial) {
  console.error("Usage: node mqttClient.js <ip> <code> <serial>");
  process.exit(1);
}

console.log(`Connecting to printer ${serial} at ${ip}:8883 ...`);

const client = mqtt.connect(`tls://bblp:${code}@${ip}:8883`, {
  rejectUnauthorized: false
});

client.on("connect", () => {
  console.log(`Connected to ${ip}:8883`);
  const topic = `device/${serial}/report`;
  client.subscribe(topic, (err) => {
    if (err) {
      console.error("Subscription error:", err.message);
    } else {
      console.log(`Subscribed to topic: ${topic}`);
    }
  });
});

client.on("message", (topic, message) => {
  const text = message.toString();
  try {
    const obj = JSON.parse(text);
    console.log(`[${topic}] ${JSON.stringify(obj)}`);
  } catch {
    // raw data if not json
    console.log(`[${topic}] ${text}`);
  }
});

client.on("error", (err) => {
  console.error("MQTT Error:", err.message);
});

client.on("close", () => {
  console.log("Connection closed.");
});
