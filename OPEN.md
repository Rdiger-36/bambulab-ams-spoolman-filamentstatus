# Open work

Working notes for the G-code tracking rebuild, kept in the repo so the next
session starts where the last one stopped. Not user documentation: the
user-facing summary lives in the CHANGELOG and in the description of
[PR #79](https://github.com/Rdiger-36/bambulab-ams-spoolman-filamentstatus/pull/79).

Everything below is either a task nobody has done yet or a decision worth not
rediscovering. Anything finished comes out of this file.

## Verify against hardware

None of this was exercised on a real printer during the rebuild. It works in
theory or in tests. Ordered by how likely a user is to hit it.

- [ ] **Merge path.** `findMergeableSpool()` in `src/ams.js` was never triggered
  in any test run, and has no unit test either. It matters for anyone who
  already keeps untagged spools in Spoolman and then inserts a matching Bambu
  spool. Reproducing it needs a Spoolman spool with an empty `extra.tag` whose
  material and colour match a loaded spool, at a remaining weight within 15 % of
  what the AMS reports.
- [ ] **Legacy mode.** `LEGACY_MODE=true` now skips the print handler entirely.
  Verified by reading the code, not by running it. A test run should show
  `Updated Spool-ID N => ...` lines and no `[Print]` lines at all.
- [ ] **Partial booking.** `calcPartialConsumption()` is unit tested against real
  slice files, but the live path from a cancelled print has only ever run once,
  in June, booking 0.08 g. A real abort halfway through a multi colour print
  would confirm the layer proportions end to end.
- [ ] **Third party spools reporting a per-filament `tray_info_idx`.** The
  payload from issue #47 (`P478b216`, all zero `tray_uuid`, empty
  `tray_sub_brands`) is classified correctly as `Loaded (3rd party)`, checked by
  running the JSON from the issue through `processData()`. Nobody has run the
  full assign and book flow on such a printer. Feedback was requested from
  @tecbeat and @buzzkc.
- [ ] **AMS Lite and multi printer setups.** Everything was tested on a single
  P2S with two AMS units. The AMS Lite was never in scope for G-code tracking;
  the README only documents its legacy mode limitation.
- [ ] **Reconnect behaviour after the move to `mqtt` v5.** Connect, subscribe
  and message handling were verified against a local TLS broker (see below), but
  the reconnect path was not: `monitorPrinters()` retrying a printer that drops
  and comes back has only been reasoned about. Pulling the network on a real
  printer mid session settles it.

## Verified in a container

Recorded so the next session does not redo it. On 2026-08-31 the image was
built and run on an Apple Silicon host against a fake Spoolman and a local
mosquitto with a self signed certificate, standing in for the printer:

- The FTPS download path works on basic-ftp 6.2.1: implicit TLS against a
  self signed certificate, `downloadTo` on the `/cache/<job>.gcode.3mf`
  candidate, extraction of `Metadata/slice_info.config` and parsing, and a
  missing file falling through both candidate paths to null. Only the hardcoded
  port 990 was not exercised, because binding it needs root.
- The reworked G-code table renders correctly at 1280 px and at 375 px, with
  no horizontal overflow and the mobile card labels intact. Rendering it also
  surfaced a pre-existing defect, now fixed: a 3rd party spool showed
  `NaNg / 0g` in the weight column.
- The image runs Node 22.23.2, with `mqtt` 5.15.2, `got` 16.0.0 and
  `adm-zip` 0.6.0 installed and no `async-mqtt`.
- Startup completes: Spoolman health, vendor and extra field checks all pass
  over `got` 16, and the Web UI and API answer on port 4000.
- `mqtt` v5 connects over TLS and subscribes, logging `MQTT client connected`.
- A published AMS report is processed end to end. A tagged Bambu slot is
  classified as `Loaded (Bambu Lab)` and logged as
  `[A0] PLA Basic 000000FF (63%)`, while an empty slot with `state` 0 stays
  `Empty`, and `/api/spools/<id>` reflects both.

None of this involved real hardware, so it says nothing about the items above.

## Before the next official release

The version deliberately stays at `1.3.0-dev` for now.

- [ ] Set the version to `1.3.0` in **both** `package.json` and `src/config.js`.
  The publish workflow compares the tag against `package.json` and aborts on a
  mismatch, so a bump in only one of them fails the build.

Tag behaviour, after the hardening in `c053561`:

| Tag | Images | `:latest` |
|---|---|---|
| `v1.3.0` | `:1.3.0` and `:latest` | moved |
| `v1.3.0-dev`, `v1.3.0-dev.2` | `:<version>` and `:dev` | untouched |
| `v1.3.0-rc1` and other suffixes | `:<version>` only | untouched |

Publishing from a branch is rejected outright, so the "Run workflow" button can
no longer overwrite `:latest` with whatever is on `main`.

## Code quality

- [ ] **`slotFingerprint()`** in `src/mappings.js` keys on `tray_type|colour`.
  Where the printer reports a per-filament `tray_info_idx` (the issue #47 case)
  that would be the sharper key and would notice a spool swap between two same
  material, same colour spools. Such a swap currently goes undetected and the old
  assignment survives.
- [ ] **Two logger tests do not catch what they describe.**
  `test/logger.test.js` has four tests; with the read moved back outside the
  write queue only two of them fail. The other two pass once the queue is given
  time to drain, so they document the intent rather than guarding the defect.
- [ ] **Spool payload construction is duplicated** between `createSpool()` and
  `createFilamentAndSpool()` in `src/spoolman.js`. Only the filament payload was
  extracted, into `buildFilamentPayload()`.
- [ ] **Tray `state` values are observed, not documented.** 0 empty, 11 a read
  Bambu tag, and 3, 10 and 20 all seen for loaded but unidentified.
  `slotIsOccupied()` treats anything non zero as occupied, which is a heuristic:
  firmware reporting a transient non zero state on an empty slot would show a
  phantom spool until it settles.

## Documentation

- [ ] The "How does it work" section of the README still describes only the RFID
  based merge and create flows. The newer "Tracking modes" section above it
  explains G-code tracking, but the older section was never rewritten to match.

The Home Assistant integration in `ha-bambulab-ams-spoolman-filamentstatus`
needs no change. It only calls `/api/printers`,
`/api/printer/{id}/monitoring/start|stop` and `/api/status/{id}`, none of which
changed, and it sets no environment variables of its own.

## Known gaps, by design

Not tasks. Decisions and limits worth not relitigating.

**Two spools identical in material and colour** cannot be told apart. The
booking goes to the first match and logs a warning; assigning them manually is
the workaround. This is the one case the slot mapping below would solve.

**Slot mapping from `plate_*.json`** is deliberately unused. The AMS slot is
derivable: the position of a filament in the project list equals the Nth loaded
slot, empty slots skipped. Confirmed across three prints (`[0,1,2,3]` to A0-A3,
`[0,5]` to A0 and B3, `[2,3]` to A2 and A3). It is not used because the project
list is a snapshot from slice time while the loaded slots are live: pulling a
spool after slicing, or remapping in the print dialog, would shift every position
and book onto the wrong spool silently. If revisited, only as a guarded
tiebreaker that requires the filament count to match the loaded slot count and
material plus colour to agree at that position, falling back to the current match
otherwise.

**No automatic creation for third party spools**, which is what issue #47
actually asks for. Keying on `tray_info_idx` plus colour is unsafe in general: a
P2S reports the generic `GFL99` for every third party spool, so two different
spools would merge into one. A safe version would be opt-in and would skip the
generic Bambu profiles. It needs more real payloads from other printers before
that line can be drawn.

**Third party spools report no weight**, so full and remaining weight are typed
in once per spool. Nothing to be done about it, but it surprises people.
