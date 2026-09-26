import test from "node:test";
import assert from "node:assert/strict";

import { resolveRemotePaths, sliceFetchRetryDue, SLICE_FETCH_RETRY_MS, SLICE_FETCH_ATTEMPTS, pickSlicedFileByTime, SLICED_FILE_TIME_WINDOW_MS } from "../src/gcode.js";
import { sliceFetchFailure, localFileName } from "../src/mqtt.js";

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

test("a file the printer named itself is looked for first, in both places", () => {
    // A P2S printing A1mini.gcode.3mf off its USB stick, started on its screen:
    // the job was named after the model's title and the file after the project
    assert.deepEqual(resolveRemotePaths("Perfectly clean bed for perfect prints!", "/data/Metadata/plate_1.gcode", "A1mini.gcode.3mf"), [
        "/cache/A1mini.gcode.3mf",
        "/A1mini.gcode.3mf",
        "/cache/Perfectly clean bed for perfect prints!.gcode.3mf",
        "/cache/Perfectly clean bed for perfect prints!.3mf",
        "/Perfectly clean bed for perfect prints!.gcode.3mf",
        "/Perfectly clean bed for perfect prints!.3mf",
    ]);
    // The same name from both sources is one candidate
    assert.deepEqual(resolveRemotePaths("Würfel", "Würfel.3mf", "Würfel.3mf").slice(0, 3),
        ["/cache/Würfel.3mf", "/Würfel.3mf", "/cache/Würfel.gcode.3mf"]);
    // Only a 3MF counts as a name
    assert.deepEqual(resolveRemotePaths("Würfel", null, "plate_1.gcode"), resolveRemotePaths("Würfel"));
});

test("the file name comes off a file:// url only", () => {
    assert.equal(localFileName("file:///userdata/model/history/A1mini.gcode.3mf"), "A1mini.gcode.3mf");
    assert.equal(localFileName("file:///userdata/model/history/W%C3%BCrfel%20%2B%20W%C3%BCrfel.gcode.3mf"), "Würfel + Würfel.gcode.3mf");
    assert.equal(localFileName("https://or-cloud-upload-prod.s3-accelerate.amazonaws.com/users/1/models/x.3mf?X-Amz-Signature=y"), null);
    assert.equal(localFileName("ftp://192.168.1.96/cache/Würfel.gcode.3mf"), null);
    assert.equal(localFileName("file:///"), null);
    assert.equal(localFileName(undefined), null);
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
    // The printer's answer per path, so a missing USB stick (550 on everything)
    // and a data connection that never opened are told apart in the ordinary log
    assert.equal(
        sliceFetchFailure({
            jobName: "Würfel",
            tried: ["/cache/Würfel.3mf", "/cache/Würfel.gcode.3mf"],
            reasons: { "/cache/Würfel.3mf": "550 Failed to open file." },
            path: null,
        }),
        "No sliced file on the printer under /cache/Würfel.3mf (550 Failed to open file.), /cache/Würfel.gcode.3mf",
    );
});

test("a fetch that found nothing is tried again, a few times, after a wait", () => {
    const at = 1_000_000;
    // A P2S recovering from an extruder error on 2026-09-23: the login timed
    // out, and the only fetch of the print was gone
    const timedOut = { jobName: "A1mini", attempt: 1, tried: [], error: "Timeout (control socket)", path: null, at };
    assert.equal(sliceFetchRetryDue(timedOut, at + 1000), false);
    assert.equal(sliceFetchRetryDue(timedOut, at + SLICE_FETCH_RETRY_MS), true);

    // A file not there yet is the same case from the other side
    const notFound = { jobName: "A1mini", attempt: 1, tried: ["/cache/A1mini.gcode.3mf"], path: null, at };
    assert.equal(sliceFetchRetryDue(notFound, at + SLICE_FETCH_RETRY_MS + 1), true);

    // The last attempt is the last one
    assert.equal(sliceFetchRetryDue({ ...notFound, attempt: SLICE_FETCH_ATTEMPTS }, at + 10 * SLICE_FETCH_RETRY_MS), false);
    assert.equal(sliceFetchRetryDue({ ...notFound, attempt: SLICE_FETCH_ATTEMPTS - 1 }, at + SLICE_FETCH_RETRY_MS), true);

    // A file that was found and carried no slice info will not change
    assert.equal(sliceFetchRetryDue({ ...notFound, path: "/cache/A1mini.gcode.3mf", sliceInfo: false }, at + 10 * SLICE_FETCH_RETRY_MS), false);
    // A record without an attempt count is the first attempt
    assert.equal(sliceFetchRetryDue({ jobName: "x", tried: [], path: null, at }, at + SLICE_FETCH_RETRY_MS), true);
    assert.equal(sliceFetchRetryDue(null, at), false);
});

test("a file whose name is unknown is taken by the time it was written", () => {
    // The X2D of issue #179 on 2026-09-26: the job was named after the print
    // profile, the file on the USB stick after the project, written at the start
    const startedAt = Date.parse("2026-09-26T13:44:17Z");
    const cartPicker = { path: "/CartPicker.gcode.3mf", modifiedAt: Date.parse("2026-09-26T13:44:05Z") };
    const yesterday = { path: "/cache/Benchy.gcode.3mf", modifiedAt: Date.parse("2026-09-25T18:02:00Z") };
    assert.deepEqual(pickSlicedFileByTime([yesterday, cartPicker], startedAt), cartPicker);

    // The one closest to the start, not the newest: a file sent after the
    // start belongs to the next print
    const next = { path: "/Next.gcode.3mf", modifiedAt: startedAt + 5 * 60 * 1000 };
    assert.deepEqual(pickSlicedFileByTime([next, cartPicker], startedAt), cartPicker);

    // Nothing near the start is nothing, rather than the least wrong file
    assert.equal(pickSlicedFileByTime([yesterday], startedAt), null);
    assert.equal(pickSlicedFileByTime([{ path: "/x.3mf", modifiedAt: startedAt - SLICED_FILE_TIME_WINDOW_MS - 1 }], startedAt), null);
    assert.equal(pickSlicedFileByTime([{ path: "/x.3mf", modifiedAt: NaN }], startedAt), null);
    assert.equal(pickSlicedFileByTime([cartPicker], null), null);
    assert.equal(pickSlicedFileByTime([], startedAt), null);
});

test("the log says when the listing found nothing either", () => {
    assert.equal(
        sliceFetchFailure({ jobName: "Würfel", tried: ["/cache/Würfel.3mf"], path: null, listed: 2 }),
        "No sliced file on the printer under /cache/Würfel.3mf, and none of the 2 3MF files on the printer was written when the print started",
    );
});
