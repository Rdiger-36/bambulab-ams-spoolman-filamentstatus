# Updating from 1.2.x

[← Documentation](README.md)

1.3.0 is the first release after 1.2.1, and the `:latest` image moves straight from one to the other. Most of what changed needs nothing from you: the container starts, finds your `printers.json` and your environment variables, and carries on. Four things can need a hand, and the dashboard says so once on the first visit after the update, with the same list as below. The startup lines in `docker logs` repeat it until the notice is dismissed.

## What can need you

### AMS slots are numbered from 1

The first slot of the first unit is `A1` and the last one of a fourth unit is `D4`, the way the printer's display and Bambu Studio count. Every slot label moved up by one, in the Web UI, in the logs, in the API and in the Spoolman location of a spool.

- Nothing has to be done by hand. The Spoolman location follows on the next reading of the AMS, so `P1S - A0` becomes `P1S - A1` on its own. A location set by hand is left alone.
- A script or a home automation reading slot labels from the API sees the new labels in `amsId`. The Home Assistant integration is the one to check.
- Two log lines changed their wording as well: `No new AMS Data or changes in Spoolman found ...` and `Spool successfully created for AMS Slot => ...` both say "slot" now. A script that greps the log for either has to be adjusted.

### The API needs a key

The API answers two kinds of caller: the Web UI of this installation, and a request carrying an API key. Anything else is answered with `401`, whether or not a Web UI password is set.

- A script, a home automation or an integration that called the API without a key stops working and needs one. Create it under **Network access → API keys** on the [settings page](settings.md) and send it as `Authorization: Bearer <key>` or `X-API-Key: <key>`.
- The pages themselves stay open to the network unless a password is set. See [API](api.md) for who may call what.

### A host name has to be allowed

A request is refused unless it was addressed to this service under a name it accepts. An IP address, `localhost` and a `.local` name are accepted as they are. Every other name has to be listed under **Network access → Allowed host names**.

- An installation reached under a real domain or through a reverse proxy is the one that notices: it answers `403` and a sentence saying so until that name is filled in once and saved, which takes effect without a restart. Open the settings page under the IP address of the host to do that, or set `ALLOWED_HOSTS` in the container definition.
- An installation reached under an IP address, which is most of them, notices nothing.

### Consumption comes from the sliced file

Filament consumption is tracked from the sliced G-code of a print instead of the AMS RFID remain percentage, and that is the default. The sliced file is fetched from the printer over FTPS while the print runs and booked onto the Spoolman spool when the job ends, which covers 3rd party spools without an RFID chip as well.

- A P2S, an H2 series printer or an X2D needs a USB stick in the printer. These printers expose only the stick over FTPS; without one nothing is booked, and the log and the print card say "No sliced file on the printer". See [Installation](installation.md).
- A 3rd party spool is booked only once its slot is linked to a Spoolman spool, by hand in the Web UI or automatically when switched on. See [Web UI](web-ui.md).
- `LEGACY_MODE=true` keeps the previous behaviour. See [Legacy mode](legacy-mode.md) for what it cannot do.

## What keeps working

- **Environment variables and a hand-written `printers.json`.** Both are deprecated and both keep working. A variable only seeds a setting that has never been saved in the Web UI; after the first save, `printers/settings.json` owns the value. The printer list is edited on the settings page from now on, and the service writes `printers.json` itself. See [Deprecated configuration](deprecated-configuration.md).
- **The volumes.** `/app/printers` and `/app/logs` are the same as before. `settings.json`, `mappings.json` and `apikeys.json` appear next to `printers.json` as they are needed.
- **`TZ`, `DATA_DIR`, `LOG_DIR` and `SUPERVISOR`** are container level and stay as they are.

The full list of what changed is in the [CHANGELOG](../CHANGELOG.md).
