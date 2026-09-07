import test from "node:test";
import assert from "node:assert/strict";

import { resolveRemotePaths } from "../src/gcode.js";
import { sliceFetchFailure } from "../src/mqtt.js";

// Where the sliced file sits depends on how the job reached the printer, and
// the printer says which in gcode_file. Every name below is one a real printer
// reported in September 2026 through issue #146.

test("a cloud print is looked for under the name the printer reports, .3mf first", () => {
    // Schnuecks's P1S, seven cloud prints, every one of them gcode_file "<job>.3mf"
    // and never found under the .gcode.3mf spelling
    assert.deepEqual(resolveRemotePaths("Würfel", "Würfel.3mf"), [
        "/cache/Würfel.3mf",
        "/cache/Würfel.gcode.3mf",
        "/Würfel.gcode.3mf",
        "/Würfel.3mf",
    ]);

    const long = "Resqme Sunvisor Mount - 0.2mm layer, 2 walls, 15% infill";
    assert.equal(resolveRemotePaths(long, `${long}.3mf`)[0], `/cache/${long}.3mf`);
});

test("a LAN print is looked for under .gcode.3mf first, as before", () => {
    // beegee-tokyo's P1S, sent from OrcaSlicer over the LAN
    assert.deepEqual(resolveRemotePaths("BambuLab-AMS-Spoolman-Testprint_v2", "BambuLab-AMS-Spoolman-Testprint_v2.gcode.3mf"), [
        "/cache/BambuLab-AMS-Spoolman-Testprint_v2.gcode.3mf",
        "/cache/BambuLab-AMS-Spoolman-Testprint_v2.3mf",
        "/BambuLab-AMS-Spoolman-Testprint_v2.gcode.3mf",
        "/BambuLab-AMS-Spoolman-Testprint_v2.3mf",
    ]);
});

test("the printer's internal gcode path names no file and is ignored", () => {
    // The X1E reports /data/Metadata/plate_1.gcode for the whole print
    assert.deepEqual(resolveRemotePaths("Würfel", "/data/Metadata/plate_1.gcode"), [
        "/cache/Würfel.gcode.3mf",
        "/cache/Würfel.3mf",
        "/Würfel.gcode.3mf",
        "/Würfel.3mf",
    ]);
    assert.deepEqual(resolveRemotePaths("Würfel"), resolveRemotePaths("Würfel", null));
});

test("a job name that already carries an extension is not doubled", () => {
    assert.equal(resolveRemotePaths("My Print.gcode.3mf")[0], "/cache/My Print.gcode.3mf");
    assert.equal(resolveRemotePaths("My Print.3mf")[0], "/cache/My Print.gcode.3mf");
    assert.equal(resolveRemotePaths("/data/My Print.gcode")[0], "/cache/My Print.gcode.3mf");
    assert.deepEqual(resolveRemotePaths(""), []);
    assert.deepEqual(resolveRemotePaths(null, "Würfel.3mf"), ["/cache/Würfel.3mf"]);
});

test("the log names the problem it actually had", () => {
    assert.equal(sliceFetchFailure(null), "No sliced file was fetched");
    assert.equal(
        sliceFetchFailure({ jobName: "Würfel", tried: ["/cache/Würfel.3mf", "/cache/Würfel.gcode.3mf"], path: null }),
        "No sliced file on the printer under /cache/Würfel.3mf, /cache/Würfel.gcode.3mf",
    );
    assert.equal(
        sliceFetchFailure({ jobName: "Würfel", tried: ["/cache/Würfel.3mf"], path: "/cache/Würfel.3mf", sliceInfo: false }),
        "/cache/Würfel.3mf carries no Metadata/slice_info.config",
    );
});
