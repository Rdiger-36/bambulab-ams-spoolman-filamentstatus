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


- [x] **Booking a print as it actually finishes.** Done on 2026-09-01 against
  the P2S, seven cancelled prints against a throwaway Spoolman. `useSpoolWeight()`
  reached it six times and the partial maths was exact: at layer 3 of a
  sequential print, 8.13 g scaled over the first object's 85 layers gave the
  0.38 g that was booked. A finished print, as opposed to a cancelled one, has
  still not been observed, and neither has a booking onto the external spool
  holder, which needs a run past layer 170.
- [ ] **A print running from remapped slots, after the matching moved.** The
  decision which sliced filament comes out of which slot is one function now,
  `matchConsumption()` in `src/ams.js`, shared by the booking and by
  `/api/print`. What it does to a print the printer remapped is covered by tests
  alone: the slot the printer named is off limits to every other filament, where
  the booking could still reach it through the colour stage. It needs a print
  started with a different spool selected than the one that was sliced, and a
  look at whether the amount lands once, on the slot that was consumed. The
  match itself has run against the printer, see below.
- [ ] **An AMS HT.** Nobody involved has one, so where its slots sit in Bambu
  Studio's filament list is unknown and `orderedAmsSlots()` leaves them out. It
  only matters for a printer that does not report `print.mapping`, which answers
  the same question. A single sliced file from a printer with one settles it:
  compare `filament_colour` in `Metadata/project_settings.config` against the
  slots the printer reports, position for position, the way the external holder
  was settled.
- [ ] **AMS Lite.** Everything was tested on a P2S with two AMS units. The AMS
  Lite was never in scope for G-code tracking; the README only documents its
  legacy mode limitation.
- [ ] **A second printer.** Multiple AMS units on one printer work (A0 to A3 and
  B0 to B3 were addressed correctly). Two printers at once was never run.
- [ ] **The update check with a newer release.** Only the prerelease path was
  observed, where the running version is ahead of the latest release. The
  "version X is available" path has never been rendered against a real answer.

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

On 2026-09-01 the anonymised diagnostics bundle was pulled from the same
instance, with `DEBUG=true` and the printer connected. The serial, the address,
the access code and the Spoolman host name were all gone, in the log text, in
`printers.json`, in the keys of `mappings.json` and in the log file name. The
printer name, the spool names and the `tray_uuid` values were kept, which is
what the design says they should be.

Reconnect and the global monitoring pause were exercised against the same live
connection. The reconnect tears the session down and is back within a second.
Pausing disconnects immediately, and a second pause reports that it changed
nothing rather than claiming success.

That run also surfaced the cooldown defect described below and the misleading
close line, both since fixed and re-checked against the same printer: reconnect,
pause and resume in sequence now bring the connection back within a second, and
the log says "Connection closed, reconnecting on request" and "Connection
closed, monitoring was switched off" instead of announcing a retry by the
monitor loop.

It also found a real defect, now fixed: the fallback pattern for a serial that
is no longer in the printer list required a leading zero, matching the P1S
examples in the README. A P2S reports `22E8BJ581201877`, so every P2S serial
slipped through it. Only the known list was covering them.

Two observations that correct what is written below:

- **`state` 27 exists** and is not in the list of values recorded so far.
- **`state` 11 is not proof of a read Bambu tag.** A chipless spool with an all
  zero `tray_uuid` reported 11 as well, so the value says the slot is loaded,
  not that it was identified.

On 2026-09-01 the shared consumption match was run against the same P2S, with
the mock Spoolman, so nothing was written anywhere. `/api/print?job=<name>`
pulled one of the printer's own sliced files over FTPS, five filaments across
two AMS units, and the match placed them on the nine slots the printer reported
at that moment:

- The black PLA Basic went to A3, not to A0 where the slicer's list order
  estimated it and a pink spool actually sits. That is the confirmation doing
  its work: the estimate was rejected and the filament identity found the slot.
- The ABS and the PETG HF went to their own slots by identity, and the white
  PLA to the matte white slot by material and colour, its profile being a
  different one.
- The fifth filament, a grey nobody has loaded, was placed on nothing and is
  what the dashboard lists as required but not loaded.
- No slot was claimed twice.

Still unobserved on hardware: a booking on a terminal state through the new
path, and a print the printer remapped.

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

The version deliberately stays on a `-dev` prerelease for now, currently
`1.3.0-dev.3`.

- [ ] Set the version to `1.3.0` in **both** `package.json` and `src/config.js`.
  The publish workflow compares the tag against `package.json` and aborts on a
  mismatch, so a bump in only one of them fails the build.

Tag behaviour, after the hardening in `c053561`:

| Tag | Images | `:latest` | GitHub release |
|---|---|---|---|
| `v1.3.0` | `:1.3.0` and `:latest` | moved | release, marked Latest |
| `v1.3.0-dev`, `v1.3.0-dev.2`, `v1.3.0-dev.3` | `:<version>` and `:dev` | untouched | pre-release |
| `v1.3.0-rc1` and other suffixes | `:<version>` only | untouched | pre-release |

One `case` decides all four columns, so the image tags and the release cannot
disagree: whatever does not move `:latest` is a pre-release.

The release is written after the image push, not before, because a release
pointing at an image that never built sends people to a pull that fails. Its
body is the section of `CHANGELOG.md` for exactly that version, so a release
without a changelog entry says so instead of inventing notes. A re-run for a
tag that already has a release edits it rather than failing.

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

## Settings GUI and printer management

Everything below landed on `feat/settings-ui-and-printer-management` up to
2026-08-31. The branch is not pushed and has no pull request. Written down here
because it is large enough that the next session should not have to read the
diff to know what is in it.

### What the branch contains

- **A settings page** at `public/settings.html`, rendered from what
  `/api/settings` describes, so a new field only has to be added to
  `SETTINGS_SCHEMA` in `src/settings.js`. Cards: Spoolman connection, Tracking,
  Synchronisation, Printer connection, Logging, plus Printers and Service.
- **Configuration lives in `printers/settings.json`** and is applied to the
  running service. Environment variables only seed a setting that has never been
  saved. The file carries a schema version, a migration hook and a write counter;
  a save against a state somebody else replaced is answered with a 409.
- **Printer management** in the Web UI: add, edit and remove, with the list in
  `printers/printers.json` written by the service (atomically) rather than by
  hand. A new printer connects right away, a removed one is disconnected and its
  assignments are dropped. The serial number is immutable and the access code is
  never sent to a client.
- **Connection tests** for Spoolman and for a printer, MQTT and FTPS in
  parallel, using the values in the form rather than the stored ones. The MQTT
  test waits for a report on the topic of the serial number, because the printer
  accepts a subscription to any topic.
- **The tracking mode is frozen at startup** and read through `legacyMode()`.
  Saving it changes what is stored, only a restart changes what runs.
- **A supervisor**: `entrypoint.js` runs the service (`starting.js`) as a child
  process and starts it again on the restart exit code, so the restart button
  works without a container restart policy. `SUPERVISOR=false` gives the single
  process back, which is worth the memory of one more Node process, measured at
  47 MB on macOS and around 30 MB on Alpine.
- **Log rotation** with the size and the number of kept files configurable, for
  the server log and per printer. The log page reads backwards across the
  rotated files, and the download hands out the whole history as one zip as
  soon as there is more than the current file.
- **One menu bar** across all pages, `public/menu.js`, keyboard operable, and a
  shared visual language: `.data-table`, the button classes and the form fields
  are the same everywhere.
- **Tests**: 105, including an HTTP harness (`test/helpers/app.js`) that registers
  the routes on a bare Express app and points `DATA_DIR` and `LOG_DIR` at a
  temporary directory.

### Still to verify on hardware

The Web UI was exercised against the real P2S only as a connection test and a
container run. Still unverified:

- [ ] **Adding and removing a printer with real hardware**, including what the
  dashboard does while the MQTT connection of a new printer comes up.
- [ ] **A restart through the Web UI during a running print.** The guard asks
  first and the booking of that job is lost when it is forced, which is what the
  dialog says, but it was never observed on a real print.

### Still open

- [ ] **The Home Assistant add-on repository needs a note.** The add-on passes
  its options as environment variables, and those stop having an effect once a
  user saves on the settings page, because the file owns the values from then
  on. The README of this repository says so; the add-on's does not.
  Since environment configuration is deprecated the add-on also triggers the
  deprecation hint on every start, which will look like a defect to an add-on
  user until its README explains which of the two places owns the values.

### Decisions taken along the way

Not tasks. Recorded so they are not relitigated.

**`settings.json` owns every field after the first save**, not only the ones
that were edited. Chosen so that a value changed in the Web UI is not silently
reverted by a container definition that still passes the old variable. The cost
is that an environment change no longer has an effect, which the README states
and a "default" link per field softens.

**The restart is an exit code, not an in place reload.** The values that need a
restart are read at startup, and re-reading them in place is what the frozen
tracking mode exists to prevent. Only the dedicated code restarts; every other
exit is passed on, so a crash stays a crash and the container restart policy
stays in charge of it. Letting both layers restart on a crash would nest two
loops.

**No automatic recovery after an uncaught exception**, for the same reason. The
supervisor could do it, and that is deliberately not built.

**The Web UI still has no access protection**, see the entry under known gaps.

**A shutdown button was considered and rejected.** The supervisor passes every
exit code except the restart one straight through, so a shutdown lands on the
container restart policy: with `unless-stopped` or `always`, the recommended
setting, the container comes straight back and the button visibly does nothing;
with `restart: no` it stays down and takes the Web UI with it, so the only way
back is Docker or the Home Assistant UI. It works exactly in the configuration
where it is hardest to undo. "Reconnect all printers" covers what people
actually reach for the restart button for, and does it without losing the
consumption tracking of a running print.

**Anonymising an export masks the network, not the user's own labels.** Printer
names and spool data are kept: they are what makes a log readable, and a name is
chosen by the user rather than assigned by the network. The RFID tag ids are kept
for the same reason, they identify a piece of filament. If this is revisited,
the right shape is an extra "also replace the printer names" switch, not a
different default.

**The access code is masked in the full export as well.** The service never
writes it to a log on purpose, but "on purpose" is not a guarantee worth handing
out, and the code is the one value that is never useful in a bug report. "Full"
therefore means the addresses, serials and paths, which is what the dialog says.

**Serials are masked before access codes**, in `maskText()`. An eight character
access code can appear inside a fifteen character Bambu serial; masking the code
first cuts the serial into pieces that the serial pass no longer recognises, and
the address in the same line then leaks in a different shape. `test/anonymize.test.js`
holds the ordering.

**Every deliberate disconnect goes through `closeMqtt()`.** The "close" handler
cannot otherwise tell a connection the network dropped from one the service
closed itself, and it announced that the monitor loop would retry within the
offline check interval in both cases. That is wrong whenever a reconnect has
already been started or the process is shutting down, and the line then sat in
the log directly above the successful reconnect. The handler also ignores a close
that arrives after the printer already has a newer client, which a deliberate
reconnect can produce and which would otherwise tear the live connection back
down.

**An explicit reconnect clears the retry cooldown, the monitor loop does not.**
`setupMqtt()` ignores a call within 30 seconds of the last attempt, which is what
stops the monitor loop from hammering a printer that is off. A button the user
pressed is not the monitor loop: resuming monitoring shortly after a reconnect
did nothing at all and the printer only came back on the next monitor pass, up
to half a minute later. The printer edit route already cleared the cooldown for
exactly this reason; the monitoring and reconnect routes now do the same.
`test/diagnostics.test.js` holds it, and both tests fail without the fix.

**The deprecation of environment configuration is state driven, not version
driven.** Nothing records which version an installation came from, and it would
not help: a fresh install set up from an older README needs the same hint as one
upgraded from 1.2.x. `deprecatedConfig()` asks instead which settings still
resolve from the environment right now, so the hint and the log lines stop by
themselves once the values have been saved. Deprecated means deprecated here, not
scheduled for removal, and neither the hint nor the README names a version that
would drop the variables.

**The dismissal of that hint is stored beside the values in `settings.json`**,
under `notices`, not among them. Acknowledging it writes the file on an
installation that has never saved anything, and writing a value there is exactly
what takes ownership away from the environment. Keeping the flag outside `values`
is what lets the file exist with nothing in it, so every variable still seeds its
setting. `test/notices.test.js` holds that guarantee.

**Encrypting the access code at rest was rejected.** Without a key store the key
ships in the same image, so it is obfuscation rather than protection. The README
note that the code sits in plain text in `printers.json` is the honest version.

## Documentation

- [x] The "How does it work" section of the README still describes only the RFID
  based merge and create flows. The newer "Tracking modes" section above it
  explains G-code tracking, but the older section was never rewritten to match.
  Done with the 1.3.0 rewrite: "How it works" now carries G-code tracking as its
  own subsection, and legacy mode has a section of its own pointing at the v1.2.1
  README.

The Home Assistant integration in `ha-bambulab-ams-spoolman-filamentstatus`
needs no change. It only calls `/api/printers`,
`/api/printer/{id}/monitoring/start|stop` and `/api/status/{id}`, none of which
changed, and it sets no environment variables of its own. The add-on wrapper is
a different matter, see the note in the settings section above.

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
