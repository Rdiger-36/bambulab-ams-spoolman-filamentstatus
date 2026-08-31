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


- [ ] **Booking a print as it actually finishes.** Everything up to the booking
  was exercised on the P2S: the slice fetch, the consumption maths and the spool
  matching. What has never run is `handlePrintStateChange()` reaching a terminal
  state on a live job and calling `useSpoolWeight()`. Starting a small print and
  letting it finish, then cancelling one halfway, closes this and the partial
  booking with it.
- [ ] **AMS Lite.** Everything was tested on a P2S with two AMS units. The AMS
  Lite was never in scope for G-code tracking; the README only documents its
  legacy mode limitation.
- [ ] **A second printer.** Multiple AMS units on one printer work (A0 to A3 and
  B0 to B3 were addressed correctly). Two printers at once was never run.

## Verified against the printer

On 2026-08-31 the image was run against the real P2S on the LAN, pointed at a
seeded fake Spoolman so nothing in the real instance was touched. In manual mode
no write reached Spoolman at all, which was checked rather than assumed.

- **The merge path fired for the first time.** With one untagged Spoolman spool
  matching A0 in material, colour and remaining weight, the log showed
  `Found mergeable Spool => Spoolman Spool ID: 42` and the slot offered
  `Merge Spool`.
- **Two 3rd party spools were loaded**, both classified `Loaded (3rd party)`
  and offering `Assign Spool`. Assigning one persisted a mapping with the
  fingerprint `PLA|F98C36`, and the slot flipped to `Unassign Spool` carrying
  the assigned spool's weight.
- **`fetchSliceInfo()` works against the printer**, over FTPS on port 990,
  including a job name with an umlaut. It returned 2 filaments across 169
  layers, with non contiguous filament ids, and `calcPartialConsumption()` at
  layer 0 produced 0.09 g, matching the layer ranges in the file.
- **Legacy mode behaves as intended.** With `LEGACY_MODE=true` there was not a
  single `[Print]` line, and the only write was
  `PATCH /api/v1/spool/<id> {"remaining_weight":270}`, derived from the AMS
  reporting 27 % of a 1 kg spool.
- **Reconnect works.** Cutting the container off the network produced
  `Printer ... is unreachable. Next try in 20 second(s)`, and the monitor loop
  brought the connection back on its own one interval later.

Two observations that correct what is written below:

- **`state` 27 exists** and is not in the list of values recorded so far.
- **`state` 11 is not proof of a read Bambu tag.** A chipless spool with an all
  zero `tray_uuid` reported 11 as well, so the value says the slot is loaded,
  not that it was identified.

Also seen: both 3rd party spools report `tray_info_idx` `GFL99`, the generic
profile, which is exactly the collision described under the automatic creation
gap below. They differ only in colour. And they report `remain` as `-1`, which
`processData()` clamps to 0.

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

## Deadline: armv7 and Node 22

Node 22 entered maintenance on 2025-10-21 and reaches end of life on
**2027-04-30**. It is also the last Node that exists on 32 bit ARM at all, so
those two facts are the same deadline for this project.

Checked on 2026-08-31, against the Node release schedule, the download index,
the Docker library manifests, the unofficial builds index and Alpine's own
package:

| | armv7 |
|---|---|
| Node 22 (EOL 2027-04-30) | yes, official binaries and `node:22-alpine` |
| Node 23 (EOL) | yes, but not an LTS |
| Node 24, 25, 26 | **none**, upstream stopped building armv7l |
| unofficial-builds.nodejs.org | armv6 only for 22, nothing for 24 and later |
| Alpine's own `nodejs` package, armhf | 22.23.2, so no way forward either |

So there is no supported path to Node 24 or later on 32 bit ARM. When Node 22
goes end of life the choice is:

- [ ] Decide before 2027-04-30: drop `linux/arm/v7` from the publish matrix and
  leave 32 bit users on the last image built for them, or keep shipping on an
  end of life Node with no security fixes. There is no third option, so this is
  a decision rather than a task.

A 64 bit OS sidesteps it entirely. A Raspberry Pi 3B and newer are all 64 bit
capable, and `linux/arm64` stays supported.

## Settings GUI, follow up work

The settings page and the printer management landed on
`feat/settings-ui-and-printer-management`. What follows are the gaps that were
knowingly left open, grouped by effort. Effort is implementation plus test, no
review.

### Small, under an hour each

Done on 2026-08-31: the tracking mode is frozen at startup and read through
`legacyMode()`, the restart notice names the actual step and stays on the page
until the service is restarted, both documentation gaps are covered in the
README, the printer dialog was checked at 375 px, and a field whose value
differs from the schema default now carries a "default" link back to it.


### Medium, one to three hours

Done on 2026-08-31: the spool assignment dialog follows the settings form now,
same field labels, inputs, focus colour and section headers, with the picker as
selectable rows. `settings.json` carries a schema version, a migration hook and
a write counter, and a save against a state somebody else replaced is answered
with a 409 instead of overwriting it.

- [ ] **Nothing guards a running print.** Deleting a printer, or changing its
  address or access code, drops the booking of the job in flight without
  warning. Answer 409 unless the request confirms it, and say so in the dialog.
- [ ] **The menu is mouse and touch only.** No `aria-expanded`, no arrow keys,
  no keyboard path into a submenu; the dialogs have neither autofocus nor a
  focus trap.

### Large, half a day and up

- [ ] **No HTTP test harness.** Only pure functions are covered. The settings
  PUT, the printer CRUD and the validation of both connection tests have no
  test. Starting the Express app on port 0 and driving it with the built in
  `fetch` needs no new dependency.
- [ ] **Restarting from the UI** only works when the process may exit and the
  container is restarted for it, which needs `restart: unless-stopped`. Without
  that policy the user is left with a dead service. Prefer naming the restart
  step in the banner instead.

Rejected: encrypting the access code at rest. Without a key store the key ships
in the same image, so it is obfuscation. The documentation note above is the
honest version.

## Code quality

- [ ] **`/api/print` omits `connectedViaMapping`.** Its `loadedSpools`
  projection in `src/routes.js` reports `connectedViaTag` but not the manual
  assignment, so the endpoint cannot answer "will this slot be booked" on its
  own. The frontend is unaffected, because the G-code table reads `/api/spools`
  and only takes `fullConsumption` from here, so this is an inconsistency in a
  diagnostic endpoint rather than a live defect.
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
- [ ] **Tray `state` values are observed, not documented.** 0 empty, and 3, 10,
  11, 20 and 27 all seen while loaded. 11 was once assumed to mean a read Bambu
  tag, but a chipless spool reports it too, so the value only says something is
  in the slot. `slotIsOccupied()` treats anything non zero as occupied, which is
  a heuristic: firmware reporting a transient non zero state on an empty slot
  would show a phantom spool until it settles.

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

**The Web UI has no access protection**, decided on 2026-08-31 after the
settings page landed. It can change the printer list and the Spoolman endpoint,
so the service belongs in a trusted local network and its port must not be
exposed. Both alternatives were weighed and rejected for now: a `CONFIG_UI=false`
switch that hides the page and blocks the mutating routes, and an `ADMIN_TOKEN`
with a login in front of them. The README carries the warning instead.
