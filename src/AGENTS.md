# Backend modules

## Purpose

Owns everything between the printer's MQTT stream and Spoolman: reading AMS
slot data, deciding what each slot means, creating/merging/updating spools in
Spoolman, booking filament consumption per print, and exposing the HTTP + SSE
API the frontend consumes.

Does **not** own rendering (`../public/`), process lifecycle (`../entrypoint.js`
and `../starting.js`) or the Express app wiring itself (`../backend.js`).

## Entry points

| File | Owns |
|---|---|
| `config.js` | The on-disk paths (overridable with `DATA_DIR` and `LOG_DIR`), the port, the version, and the raw environment values that seed the two config files. The only module allowed to read `process.env`. |
| `settings.js` | The runtime configuration: schema, coercion, the resolved `settings` object, `spoolmanUrl()`, the frozen `legacyMode()` and the persistence of `printers/settings.json`, including its schema version and write counter. Must not import `logger.js`, which reads DEBUG from here. |
| `service.js` | The startup sequence, the Spoolman reconnect that the settings API triggers when the endpoint changes, and `restartService()`, which ends the process with the restart exit code. |
| `supervisor.js` | The decision `entrypoint.js` makes when the service ends, and the exit code it looks for. Deliberately free of imports so it can be tested without spawning a process. |
| `logger.js` | The `console.*` overrides, the serialised per-file write queue, `tailLogLines()` for the log viewer, which reads across the rotated files, and the size based rotation itself. |
| `printers.js` | Loads and writes `printers/printers.json` (or seeds it from the `PRINTER_*` env vars), seeds the mutable per-printer runtime object, and owns add, update and remove. |
| `mqtt.js` | The engine. Connection lifecycle, message handling, slot processing, print-state tracking, consumption booking, SSE broadcast, monitor loops. |
| `ams.js` | Pure functions over AMS payloads: normalisation, change detection, spool matching. No I/O. |
| `gcode.js` | FTPS fetch of the sliced 3MF, `slice_info.config` parsing, consumption maths. |
| `spoolman.js` | Every Spoolman HTTP call. No other module talks to Spoolman directly. |
| `mappings.js` | Manual AMS-slot → Spoolman-spool assignments, persisted to `printers/mappings.json`. |
| `routes.js` | All Express handlers, registered by `registerRoutes(app, printers)`. |
| `uispool.js` | `toClientSpool()`, the one projection from a runtime UI spool to what a client sees. Used by `/api/spools`, `/api/print`, the SSE slot update and `hasSpoolUiChanged()`. |
| `state.js` | Shared mutable process state (Spoolman status, vendor id, SSE clients, last spool snapshot). |
| `utils.js` | Date/interval formatting, `sleep`, AMS id to slot label (`A0`, `HT-A`), and `slotColors()`, the colour set of a slot. It lives here because both `ams.js` and `uispool.js` need it and `ams.js` already imports `uispool.js`. |

## The two tracking modes

This is the single most important distinction in the codebase.

**G-code tracking (default, `legacyMode() === false`)**: on `gcode_state` reaching
`RUNNING`, `fetchSliceInfo()` pulls `Metadata/slice_info.config` out of the
sliced `.gcode.3mf` over FTPS. On a terminal state the consumed grams are
computed (`calcFullConsumption` for `FINISH`, `calcPartialConsumption` for
`FAILED`/`CANCEL`) and booked via Spoolman's `/use` endpoint. Works for spools
without an RFID chip.

**Legacy tracking (`legacyMode() === true`)**: the AMS `remain` percentage is
converted to a weight and PATCHed onto the spool. The print handler is skipped
entirely (`mqtt.js`, in `handleMqttMessage`). The AMS Lite reports only 0 % or
100 %, so it is unusable here.

Legacy mode also has no 3rd party support and no manual assignment. Both exist
only to serve the G-code booking, which does not run here, so a chipless slot is
read-only and the mapping endpoints answer 409.

Consequence: in G-code mode the `remain` value is deliberately dropped before
change detection (`hasTrayDataChanged()`), so a drifting RFID percentage does
not trigger endless reprocessing. Whether there is a reading at all is kept:
the transition from "not reported" to a real percentage has to refresh
`printer.spoolData`, because that is the snapshot the create and merge actions
build their Spoolman payload from.

## Contracts & invariants

- **`console.log/error/debug` take `(device, logFilePath, ...args)`.** Set up in
  `logger.js`; see the root AGENTS.md. Use `originalConsoleLog` to bypass.
- **Settings are read at the point of use.** `settings.MODE`, never
  `const { MODE } = settings`. The object is mutated in place by the settings
  API, so a destructured copy silently keeps the startup value.
- **The tracking mode is the exception: read it through `legacyMode()`**, which
  returns the value frozen at startup. `settings.LEGACY_MODE` is only what is
  stored and what the settings page shows. Reading the live value would switch
  the mode under a print in flight, and the two modes book differently, so it
  would book twice or not at all.
- **The Spoolman base URL comes from `spoolmanUrl()`**, not from a constant. It
  changes at runtime.
- **A settings write bumps a revision.** The settings page sends back the
  revision it read and a mismatch is answered with 409, so two open tabs cannot
  overwrite each other silently. `PUT /api/settings` accepts the bare field map
  too, which skips the check.
- **`printers` is mutated in place.** `monitorPrinters()` iterates the same
  array forever, which is what makes a printer added in the Web UI get picked
  up. Never reassign the exported binding.
- **All Spoolman HTTP goes through `spoolman.js`.** Do not `got()` a Spoolman URL
  from anywhere else.
- **Every FTPS connection gets its own `secureOptions` object**, built by
  `bambuTlsOptions()`. basic-ftp writes the host into the object it is handed,
  and for implicit TLS that stored host wins over the one passed to `access()`,
  so a shared constant sends every later connection to the printer that used it
  first.
- **A connection test never disturbs the live connection.** `testMqttConnection`
  opens its own client and force closes it; it must not touch
  `printer.mqttClient`.
- **`slot.remain` is never mutated in place.** It is compared raw against the
  next MQTT message in `extractComparableTrayData()`; normalise into a local
  (`correctRemainInt`) instead. Mutating it desyncs change detection forever for
  any spool whose `tray_weight != 1000`.
- **`cols` is the colour set of a slot, `tray_color` only its first colour.**
  A multi colour filament reports every colour it carries in `cols`, and
  Spoolman stores the same thing as `multi_color_hexes` with no `color_hex` at
  all, so anything comparing or drawing a colour has to read the set.
  `slotColors()` in `utils.js` normalises it, dropping the alpha byte the AMS
  appends, and `processData()` guarantees the field exists on every tray, which
  is why `cols` has to be in `EMPTY_TRAY_KEYS`: a field the normalisation adds
  unconditionally makes every empty slot look occupied otherwise. Order is the
  printer's, because it is the order the colours run along the strand; the two
  catalogues do not agree on one, so comparisons sort a copy.
- **A `remain` of `null` means "not reported", never "empty".** The AMS answers
  `-1` between a spool going in and its RFID percentage arriving, measured on
  a P2S at anything from 17 seconds to over a minute, and forever for a
  chipless one. `processData()` turns
  that into `null` and `correctRemainInt()` passes the `null` through, so every
  caller has to decide for itself: create the spool full, skip the legacy PATCH,
  skip the weight test when looking for a mergeable spool, render a dash. A `0`
  is a reading and means the spool really is empty. Collapsing the two created
  new spools at `used_weight = initial_weight`, and in G-code mode nothing
  patches the weight afterwards, so they stayed at 0 g left.
- **`state.lastSpoolData === null` means "not yet seeded".** `[]` is a legitimate
  value (empty Spoolman) and must stay comparable. Never re-seed on empty.
- **An unidentified spool is not an empty slot.** `slotIsOccupied()` is the only
  correct test; a slot with `tray_uuid === "N/A"` is not automatically empty.
  It reads the shape of the tray record, because a loaded slot carries the full
  payload (`tray_info_idx`, `tray_type`, `cols`, `tag_uid`) whether the chip was
  read or not, while an empty one carries `id` and `state` alone. Never go back
  to reading `state`: on a P2S it is 9 or 10 when empty and 11 or 27 when
  loaded, so "non zero means occupied" marks every empty slot as a 3rd party
  spool and freezes change detection for chipless slots. `slotIsBusy()` is the
  one remaining reader of `state`, and it decides a label and nothing else: a
  slot the AMS is moving filament into reports `{ id, state }` and nothing else,
  which is byte for byte an empty slot, so for the roughly 20 seconds until the
  tray record arrives the dashboard would call it empty with the user watching
  the spool sit in it. Its allow list holds the values seen while busy, not the
  ones seen at rest, so an unseen value reads as empty rather than leaving a
  slot claiming to read a spool for good.
- **A spool is not created before the AMS reports how much is left.**
  `usedWeightFromSlot()` turns the percentage into `used_weight`, and without
  one it has to assume brand new, which is wrong for a partly used spool that
  nothing corrects afterwards in G-code mode. `waitedLongEnoughForRemain()`
  holds the create branch back, in both modes: automatic skips the slot for
  this update, manual shows a disabled "Waiting for data" button. It gives up
  after `MAX_REMAIN_WAITS` updates so a chip that never reports still gets its
  spool. Merging is deliberately not held back, it writes only the tag. The
  wait resolves itself because `hasTrayDataChanged()` treats the arrival of the
  first reading as a change.
- **The external spool holder is a slot like any other, in G-code mode only.**
  The printer reports it outside the AMS block as `print.vir_slot`, an array
  whose entry is field for field a chipless AMS tray, so `externalSpoolUnits()`
  hands it to the same pipeline as a unit of id 255 and `processSlot` classifies
  it as the 3rd party spool it is. `convertAMSandSlot()` labels it `External`,
  which is also the key an assignment is stored under, so changing the label
  orphans what is on disk. Legacy mode leaves it out for the reason it leaves
  every chipless spool read-only: it writes the RFID remain percentage and the
  holder has no chip. Older firmware called it `vt_tray` and sent a single
  object; a P2S on 2026 firmware does not send that key at all. Only a holder
  that carries something is emitted, because what an empty one reports has not
  been observed and an entry of empty strings would still reach
  `slotIsOccupied()` carrying its temperature fields.
- **Manual assignment is a G-code mode feature.** `legacyMode()` gates it in
  three places: the 3rd party branch and the Bambu fallback in `processSlot`,
  and `rejectInLegacyMode()` on the mutating routes. A new entry point has to
  gate it too, or a direct API call creates a mapping that silently takes effect
  on the next mode switch.
- **A consumption booking requires a known physical spool**, either
  `connectedViaTag` (Spoolman `extra.tag` == the slot's `tray_uuid`) or
  `connectedViaMapping` (explicit user assignment). Type/colour similarity alone
  never books.
- **The sliced file names the slot, and that beats every colour comparison.**
  The position of a filament in Bambu Studio's list is the AMS slot it was
  sliced for, verified against a real print on a P2S with two AMS units where
  the ids 5, 7 and 8 were B0, B2 and B3. It is the only thing that separates two
  spools identical in profile and colour, so `calcFullConsumption()` keys by
  that position: two filaments never merge, where a colour key added them
  together before anything looked at the AMS and the sum could not be split
  afterwards.
- **A position is resolved against the printer, never computed.**
  `resolveSliceSlots()` takes the slots from `orderedAmsSlots()`, which lists
  every position of every attached four slot unit. Arithmetic on "four per
  unit" is wrong: with two AMS units and a spool on the external holder the
  slicer's list is nine long, and the ninth entry became "C0", a unit that
  printer does not have. The list length says nothing either, it is the
  project's filament count and not the printer's, and the same P2S produced
  files with six, eight and nine entries. All four positions of an attached
  unit are listed whether or not they reported a spool, because the slicer
  lists an empty slot too and counting only the occupied ones shifts everything
  after one. AMS HT is left out: it holds one spool per unit and its place in
  that list is not pinned down by any observed file.
- **The named slot is confirmed before anything is booked on it.** The printer
  can remap slots when a job is sent and slice_info.config is written before
  that, so `slotConfirmsSlice()` requires the slot to really hold that profile
  and those colours, comparing colours as sorted sets because the slicer and the
  RFID chip need not agree on which comes first. Everything unconfirmed, and
  every filament with no position at all, falls through to the stages that
  existed before. A spool on the external holder is one of those: the printer
  reports it as `vt_tray` and this service does not read it, so its grams land
  on whichever AMS slot matches by profile and colour, exactly as they did
  before slots were used at all.
- **`consumptionKey()` carries the colour set, and `slotFingerprint()` too.**
  A gradient spool is not a profile of its own: Bambu Studio slices PLA Basic
  Gradient as `GFA00`, the same as plain PLA Basic, and `tray_color` is only its
  first colour. Arctic Whisper, Solar Breeze and an ordinary white PLA Basic
  were one key and one fingerprint. The set is sorted in both, because the
  sources disagree on order (Studio writes Cotton Candy Cloud as
  `#8EC9E9 #E7C1D5`, SpoolmanDB stores it the other way round) and an unsorted
  comparison matches nothing rather than the wrong thing. A single colour
  produces the string it always did, so nothing on disk needs migrating.
- **A mapping carries a fingerprint** (`tray_type|colour`). When it stops
  matching, the assignment is dropped rather than booked onto the wrong spool.
- **`mappings.json` is written temp-file-then-rename**, so a crash mid-write
  cannot truncate it.
- **Log rotation runs inside the write queue of its file.** A rename between two
  queued appends would send the lines in between to the rotated file, or to one
  nobody reads any more. `rotateLogFile()` queues; the append path calls the
  unqueued `rotateNow()` because it is already inside the queue.
- **Reconnects are driven only by `monitorPrinters()`.** The MQTT `close` and
  `error` handlers must not reschedule themselves. Two independent retry paths
  used to race.
- **`printer.blockMqttUpdates` serialises message handling.** Messages arriving
  during processing are dropped, not queued.

## Patterns

**Adding a setting:** add the field to `SETTINGS_SCHEMA` in `settings.js` with
its type, default and range (clamps live there, not at the use site), read it as
`settings.<KEY>` at the point of use, add the variable to `envSeed` in
`config.js` when it should be seedable, and document it in the README table. The
settings page picks it up on its own; `group` decides which card it lands in,
and the card has to be listed in `GROUPS` in `public/settings.js`. `advanced`
puts a field into that card's collapsed section, `header` puts a switch into the
card header with its description behind an info icon, for a field that belongs
to the whole card rather than to a row of its own. Mark it `restartRequired`
when the running process cannot adopt it, and handle the live application in the
`PUT /api/settings` handler when it needs more than the new value being read.

**Adding an HTTP route:** add it inside `registerRoutes()` in `routes.js`.
Respond `{ ok: false, error }` with a 4xx/5xx for failures; the frontend's
`fetchJson()` expects that shape. Never build a Spoolman payload inline. Add a
function to `spoolman.js`.

**Adding matching logic:** put the decision in `ams.js` as a pure function and
call it from `mqtt.js`. That is what makes it testable: `test/ams.test.js`
covers exactly this seam.

**Testing against a whole system:** `node scripts/test-server/index.js` starts a
mock printer, a mock Spoolman and this service against both, with its state in a
temporary directory. The mocks implement only what `spoolman.js` and `mqtt.js`
actually call. Reach for it when the thing to check is a payload travelling all
the way to the browser, which is the one seam `test/` cannot cover.

**Pushing something to the UI:** `broadcastSlotUpdate()` for a single slot,
`broadcastSSE()` for status/refresh events. A slot goes out through
`toClientSpool()` in `uispool.js`, the one projection from the runtime object to
the client payload, shared with `/api/spools` and `/api/print`. Add a field
there when the UI needs it; anything not listed stays on the server. That
includes the `"N/A"` placeholder `processData()` writes: it is a backend marker
and the projection turns it back into `null`, so a client never renders it. The
broadcast decision is `hasSpoolUiChanged()` alone, which compares that same
projection. Do not add a second condition in front of it; the one that used to
be there held every slot the printer could not identify back, so an emptied slot
never reached the UI.

**Changing slot classification:** `processSlot()` in `mqtt.js` branches, in
order: invalid slot → empty slot → 3rd party (unidentified) → Bambu Lab. The
order matters; the empty branch must not swallow an occupied-but-unidentified
slot.

## Anti-patterns

- Reading `process.env` outside `config.js`.
- `console.log("some message")` with the normal one-argument signature.
- Awaiting slow I/O inside `handleMqttMessage` outside the existing interval
  guard. Every printer report during that time is lost.
- Refetching Spoolman lists per slot. `processSlot()` returns whether it mutated
  Spoolman; only then does the caller refetch.
- Comparing spool arrays by index. Spoolman may reorder between calls, and
  `haveSpoolDataChanged()` matches by id for that reason.
- Sending `last_used` to Spoolman's `/use` endpoint. It is silently dropped;
  the timestamp needs a separate PATCH.

## Related context

- Root overview and global rules: [`../AGENTS.md`](../AGENTS.md)
- Frontend consuming this API: `../public/frontend.js`
- Known gaps and unverified paths: `../OPEN.md`
