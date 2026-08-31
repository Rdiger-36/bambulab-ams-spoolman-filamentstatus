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
| `state.js` | Shared mutable process state (Spoolman status, vendor id, SSE clients, last spool snapshot). |
| `utils.js` | Date/interval formatting, `sleep`, AMS id → slot label (`A0`, `HT-A`). |

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

Consequence: in G-code mode the `remain` field is deliberately stripped before
change detection, so a drifting RFID percentage does not trigger endless
reprocessing.

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
- **`state.lastSpoolData === null` means "not yet seeded".** `[]` is a legitimate
  value (empty Spoolman) and must stay comparable. Never re-seed on empty.
- **An unidentified spool looks exactly like an empty slot** in every field
  except `state`. `slotIsOccupied()` is the only correct test; a slot with
  `tray_uuid === "N/A"` is not automatically empty.
- **Manual assignment is a G-code mode feature.** `legacyMode()` gates it in
  three places: the 3rd party branch and the Bambu fallback in `processSlot`,
  and `rejectInLegacyMode()` on the mutating routes. A new entry point has to
  gate it too, or a direct API call creates a mapping that silently takes effect
  on the next mode switch.
- **A consumption booking requires a known physical spool**, either
  `connectedViaTag` (Spoolman `extra.tag` == the slot's `tray_uuid`) or
  `connectedViaMapping` (explicit user assignment). Type/colour similarity alone
  never books.
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

**Pushing something to the UI:** `broadcastSlotUpdate()` for a single slot,
`broadcastSSE()` for status/refresh events. Both strip `logFilePath` and
`printerName` via `sanitizeSpoolForClient()`. Keep server-only fields out of
the client payload.

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
