import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";

let dir, readJsonFile, writeJsonFile;

before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-jsonfile-"));
    process.env.DATA_DIR = path.join(dir, "printers");
    process.env.LOG_DIR = path.join(dir, "logs");
    fs.ensureDirSync(process.env.LOG_DIR);
    ({ readJsonFile, writeJsonFile } = await import("../src/jsonfile.js"));
});

after(() => { fs.removeSync(dir); });

test("a file is written through a temporary name and read back, and a missing one reads as null", () => {
    const file = path.join(dir, "printers", "nested", "thing.json");
    assert.equal(readJsonFile(file), null);
    assert.equal(writeJsonFile(file, { a: 1, list: [1, 2] }), true);
    assert.deepEqual(readJsonFile(file), { a: 1, list: [1, 2] });
    assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test("a broken file reads as null rather than throwing", () => {
    const file = path.join(dir, "printers", "broken.json");
    fs.outputFileSync(file, "{not json");
    assert.equal(readJsonFile(file, "broken.json"), null);
});

test("a write that fails is reported, or thrown when the caller asks for it", () => {
    // A directory where the file should be makes the rename fail
    const file = path.join(dir, "printers", "isdir.json");
    fs.ensureDirSync(file);
    assert.equal(writeJsonFile(file, { a: 1 }), false);
    assert.throws(() => writeJsonFile(file, { a: 1 }, { throwOnError: true }));
    assert.equal(fs.existsSync(`${file}.tmp`), false);
});
