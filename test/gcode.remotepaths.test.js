import test from "node:test";
import assert from "node:assert/strict";

import { resolveRemotePaths, sliceFetchRetryDue, SLICE_FETCH_RETRY_MS, SLICE_FETCH_ATTEMPTS, slicedFileCandidates, SLICED_FILE_TIME_WINDOW_MS, reportedPlate, parseModelTitles, parsePlateIndices, judgeSlicedFile, settleSlicedFile, readSlicedFileFacts, parseModelIds } from "../src/gcode.js";
import { sliceFetchFailure, localFileName, printIdentity } from "../src/mqtt.js";

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

test("the time only picks the candidates, closest to the start first", () => {
    // The X2D of issue #179 on 2026-09-26: the job was named after the print
    // profile, the file on the USB stick after the project, written at the start
    const startedAt = Date.parse("2026-09-26T13:44:17Z");
    const cartPicker = { path: "/CartPicker.gcode.3mf", modifiedAt: Date.parse("2026-09-26T13:44:05Z") };
    const yesterday = { path: "/cache/Benchy.gcode.3mf", modifiedAt: Date.parse("2026-09-25T18:02:00Z") };
    // Closest rather than newest: a file sent after the start belongs to the next print
    const next = { path: "/Next.gcode.3mf", modifiedAt: startedAt + 5 * 60 * 1000 };
    assert.deepEqual(slicedFileCandidates([yesterday, next, cartPicker], startedAt), [cartPicker, next]);

    assert.deepEqual(slicedFileCandidates([yesterday], startedAt), []);
    assert.deepEqual(slicedFileCandidates([{ path: "/x.3mf", modifiedAt: startedAt - SLICED_FILE_TIME_WINDOW_MS - 1 }], startedAt), []);
    assert.deepEqual(slicedFileCandidates([{ path: "/x.3mf", modifiedAt: NaN }], startedAt), []);
    assert.deepEqual(slicedFileCandidates([cartPicker], null), []);
});

test("the plate comes off gcode_file", () => {
    assert.equal(reportedPlate("/data/Metadata/plate_1.gcode"), 1);
    assert.equal(reportedPlate("Metadata/plate_12.gcode"), 12);
    assert.equal(reportedPlate("Würfel.gcode.3mf"), null);
    assert.equal(reportedPlate(undefined), null);
});

test("a file names itself through MakerWorld's titles", () => {
    // Heads of 3D/3dmodel.model as Bambu Studio 2.8 writes them, read off the P2S stick
    const clippy = `<model>
 <metadata name="Designer">iLab 3D</metadata>
 <metadata name="ProfileTitle">0.2mm layer - 10 clips</metadata>
 <metadata name="Title">CLIPPY - Filament clip</metadata>
 <resources>`;
    assert.deepEqual(parseModelTitles(clippy), ["0.2mm layer - 10 clips", "CLIPPY - Filament clip"]);
    // A project of one's own leaves both empty
    assert.deepEqual(parseModelTitles(`<metadata name="ProfileTitle"></metadata>\n <metadata name="Title"></metadata>`), []);
    assert.deepEqual(parseModelTitles(`<metadata name="Title">Tom &amp; Jerry &quot;v2&quot;</metadata>`), ['Tom & Jerry "v2"']);

    assert.deepEqual(parsePlateIndices(`<config>\n  <plate>\n    <metadata key="index" value="1"/>\n  </plate>\n  <plate>\n    <metadata key="index" value="3"/>`), [1, 3]);
});

test("the content of a candidate proves it, rules it out or leaves it open", () => {
    const x2d = { jobName: "0.2mm layer, 3 walls, 15% infill", plate: 1, layers: 15 };
    const makerWorld = { titles: ["0.2mm layer, 3 walls, 15% infill", "CartPicker"], plates: [1], layers: 15 };

    assert.equal(judgeSlicedFile(makerWorld, x2d).verdict, "confirmed");
    // The exclusions come first, a matching title does not outweigh them
    assert.equal(judgeSlicedFile({ ...makerWorld, plates: [2] }, x2d).verdict, "rejected");
    assert.equal(judgeSlicedFile({ ...makerWorld, layers: 16 }, x2d).verdict, "rejected");
    // A title that is not the job name rules the file out
    assert.equal(judgeSlicedFile({ ...makerWorld, titles: ["0.2mm layer - 10 clips"] }, x2d).verdict, "rejected");
    // A project of one's own carries no title and is left open
    assert.equal(judgeSlicedFile({ titles: [], plates: [1], layers: 15 }, x2d).verdict, "possible");
    // What the printer has not reported checks nothing
    assert.equal(judgeSlicedFile({ titles: [], plates: [2], layers: 99 }, { jobName: "x", plate: null, layers: null }).verdict, "possible");
});

test("a guess between two files books nothing", () => {
    const confirmed = { path: "/a.3mf", verdict: "confirmed" };
    const possible = { path: "/b.3mf", verdict: "possible" };
    const other = { path: "/c.3mf", verdict: "possible" };
    const rejected = { path: "/d.3mf", verdict: "rejected" };

    assert.equal(settleSlicedFile([possible, confirmed]).file, confirmed);
    assert.equal(settleSlicedFile([rejected, possible]).file, possible);
    assert.equal(settleSlicedFile([possible, other]).file, null);
    assert.match(settleSlicedFile([possible, other]).reason, /2 files/);
    assert.equal(settleSlicedFile([rejected]).file, null);
    assert.equal(settleSlicedFile([]).file, null);
});

test("the log says when the listing found nothing either", () => {
    assert.equal(
        sliceFetchFailure({ jobName: "Würfel", tried: ["/cache/Würfel.3mf"], path: null, listed: 2, settled: "2 files written at the start could be it, so none is taken" }),
        "No sliced file on the printer under /cache/Würfel.3mf. Listed 2 3MF files on the printer: 2 files written at the start could be it, so none is taken",
    );
});

test("Bambu Studio's command and the file carry md5 and MakerWorld ids", () => {
    // The X2D's project_file echo of 2026-09-22, md5 anonymised
    assert.deepEqual(printIdentity({
        command: "project_file", md5: "774F0000000000000000000000000000", model_id: "USac90b077599b7c",
        profile_id: "1017501024", plate_idx: "1", design_id: "3071033",
    }), { md5: "774F0000000000000000000000000000", modelId: "USac90b077599b7c", profileId: "1017501024", plate: 1 });
    // A print without a cloud project sends zeros and empty strings
    assert.equal(printIdentity({ model_id: "", profile_id: "0", project_id: "0" }), null);

    assert.deepEqual(parseModelIds(`<metadata name="DesignModelId">USc2c7ad817530fc</metadata>
 <metadata name="DesignProfileId">167787430</metadata>`), { modelId: "USc2c7ad817530fc", profileId: "167787430" });
    assert.deepEqual(parseModelIds(`<metadata name="Title"></metadata>`), { modelId: null, profileId: null });
});

test("a matching md5 or id proves a file, a differing one decides nothing yet", () => {
    const file = { titles: [], plates: [1], layers: 15, md5: { 1: "E01DB1EC85533608D4554E3A4890B19C" }, modelId: "US59c38024b82730", profileId: "885007612" };
    const base = { jobName: "0.2mm layer, 3 walls, 15% infill", plate: 1, layers: 15 };

    assert.equal(judgeSlicedFile(file, { ...base, md5: "e01db1ec85533608d4554e3a4890b19c" }).verdict, "confirmed");
    assert.equal(judgeSlicedFile(file, { ...base, profileId: "885007612" }).verdict, "confirmed");
    assert.equal(judgeSlicedFile(file, { ...base, modelId: "US59c38024b82730" }).verdict, "confirmed");

    // Not proven which field equals which, so a mismatch hands on to the title
    const differs = { ...base, md5: "774F0000000000000000000000000000", modelId: "USac90b077599b7c", profileId: "1017501024" };
    assert.equal(judgeSlicedFile(file, differs).verdict, "possible");
    assert.match(judgeSlicedFile(file, differs).reason, /md5 differs/);
    assert.equal(judgeSlicedFile({ ...file, titles: ["0.2mm layer, 3 walls, 15% infill", "CartPicker"] }, differs).verdict, "confirmed");
    // The exclusions still come first
    assert.equal(judgeSlicedFile({ ...file, layers: 16 }, { ...base, md5: "E01DB1EC85533608D4554E3A4890B19C" }).verdict, "rejected");
});
