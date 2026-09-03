# Deprecated configuration

[← Documentation](README.md)

Configuring this service through **environment variables** and a hand-written **`printers.json`** is deprecated since 1.3.0. Both keep working and nothing has to change today, but the [settings page](settings.md) is the supported place now.

- A variable only **seeds** a setting that has never been saved in the Web UI. After the first save `printers/settings.json` owns the value and the variable is ignored, so a value changed in the UI is not silently reverted by the container definition on the next start.
- `printers.json` no longer has to exist before the first start. The service writes it itself, and the printer list is edited under **Settings → Printers**.
- An installation that still relies on the variables says so once in the Web UI and on every start in `docker logs`, naming the ones that are actually still in charge:

  ```
  [Deprecated] Configuring this service through environment variables is deprecated since 1.3.0.
  [Deprecated] It keeps working, but the settings page in the Web UI is the supported way now: http://<host>:4000/settings.html
  [Deprecated] Still taken from the environment: MODE, UPDATE_INTERVAL, DEBUG. ...
  ```

  Dismissing the hint is stored on the server. It stops appearing on its own as soon as nothing is left that the environment still decides.

The full list of variables and the `printers.json` format are documented in the **[README of v1.2.1](https://github.com/Rdiger-36/bambulab-ams-spoolman-filamentstatus/blob/v1.2.1/README.md)**.

Three variables are container level and stay as they are, they have no field in the Web UI:

| Variable | Description |
|----------|-------------|
| `TZ` | Time zone of the container, e.g. `Europe/Berlin`. The log timestamps follow it, without it the container runs on UTC |
| `DATA_DIR`, `LOG_DIR` | Where `printers.json`, `settings.json`, `mappings.json` and `apikeys.json` live and where the logs are written. Default to `/app/printers` and `/app/logs`, which the volumes of the [installation](installation.md) mount. Only set these when you cannot mount those paths |
| `SUPERVISOR` | Set to `false` to run the service in a single process, without the supervisor that restarts it from the Web UI. Saves about 30 MB of memory, which matters on a 32 bit Raspberry Pi. The restart button then depends on the restart policy of the container, and says so (default: on) |
