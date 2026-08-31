// Test fixture standing in for starting.js: reports that it is up, then ends
// with the code the test asked for. EXIT_AFTER_MS keeps it alive long enough
// for the signal test to reach it.
const code = Number(process.env.EXIT_CODE ?? 0);
const delay = Number(process.env.EXIT_AFTER_MS ?? 0);

process.stdout.write(`[fixture] up, supervised=${process.env.SUPERVISED ?? "no"}\n`);

process.on("SIGTERM", () => {
    process.stdout.write("[fixture] SIGTERM\n");
    process.exit(0);
});

if (delay > 0) setTimeout(() => process.exit(code), delay);
else process.exit(code);
