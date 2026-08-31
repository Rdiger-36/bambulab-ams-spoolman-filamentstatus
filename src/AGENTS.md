# Backend modules

## Purpose

Owns everything between the printer's MQTT stream and Spoolman: reading AMS
slot data, deciding what each slot means, creating/merging/updating spools in
Spoolman, booking filament consumption per print, and exposing the HTTP + SSE
API the frontend consumes.

Does **not** own rendering (`../public/`), process lifecycle (`../entrypoint.js`)
or the Express app wiring itself (`../backend.js`).

## Entry points

| File | Owns |
|---|---|
| `config.js` | Every environment variable, resolved once. The only module allowed to read `process.env`. Also derives `SPOOLMAN_URL` and the on-disk paths. |
| `logger.js` | The `console.*` overrides, the serialised per-file write queue, and `tailFileLines()` for the log viewer. |
| `printers.js` | Loads `printers/printers.json` (or falls back to `PRINTER_*` env vars) and seeds the mutable per-printer runtime object. |
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

**G-code tracking (default, `LEGACY_MODE=false`)**: on `gcode_state` reaching
`RUNNING`, `fetchSliceInfo()` pulls `Metadata/slice_info.config` out of the
sliced `.gcode.3mf` over FTPS. On a terminal state the consumed grams are
computed (`calcFullConsumption` for `FINISH`, `calcPartialConsumption` for
`FAILED`/`CANCEL`) and booked via Spoolman's `/use` endpoint. Works for spools
without an RFID chip.

**Legacy tracking (`LEGACY_MODE=true`)**: the AMS `remain` percentage is
converted to a weight and PATCHed onto the spool. The print handler is skipped
entirely (`mqtt.js`, in `handleMqttMessage`). The AMS Lite reports only 0 % or
100 %, so it is unusable here.

Consequence: in G-code mode the `remain` field is deliberately stripped before
change detection, so a drifting RFID percentage does not trigger endless
reprocessing.

## Contracts & invariants

- **`console.log/error/debug` take `(device, logFilePath, ...args)`.** Set up in
  `logger.js`; see the root AGENTS.md. Use `originalConsoleLog` to bypass.
- **All Spoolman HTTP goes through `spoolman.js`.** Do not `got()` a Spoolman URL
  from anywhere else.
- **`slot.remain` is never mutated in place.** It is compared raw against the
  next MQTT message in `extractComparableTrayData()`; normalise into a local
  (`correctRemainInt`) instead. Mutating it desyncs change detection forever for
  any spool whose `tray_weight != 1000`.
- **`state.lastSpoolData === null` means "not yet seeded".** `[]` is a legitimate
  value (empty Spoolman) and must stay comparable. Never re-seed on empty.
- **An unidentified spool looks exactly like an empty slot** in every field
  except `state`. `slotIsOccupied()` is the only correct test; a slot with
  `tray_uuid === "N/A"` is not automatically empty.
- **A consumption booking requires a known physical spool**, either
  `connectedViaTag` (Spoolman `extra.tag` == the slot's `tray_uuid`) or
  `connectedViaMapping` (explicit user assignment). Type/colour similarity alone
  never books.
- **A mapping carries a fingerprint** (`tray_type|colour`). When it stops
  matching, the assignment is dropped rather than booked onto the wrong spool.
- **`mappings.json` is written temp-file-then-rename**, so a crash mid-write
  cannot truncate it.
- **Reconnects are driven only by `monitorPrinters()`.** The MQTT `close` and
  `error` handlers must not reschedule themselves. Two independent retry paths
  used to race.
- **`printer.blockMqttUpdates` serialises message handling.** Messages arriving
  during processing are dropped, not queued.

## Patterns

**Adding an env var:** declare and coerce it in `config.js` (clamp ranges there,
not at the use site), document it in the README table, and add it to the compose
example.

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
