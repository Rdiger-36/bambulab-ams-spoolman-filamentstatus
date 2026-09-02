# Legacy mode

[← Documentation](README.md)

The tracking of 1.2.x and earlier: the remaining weight is read from the RFID chip's remain percentage on every AMS update and written to Spoolman. Enable it under **Settings → Tracking**. It is the one setting that needs a restart, and the page offers one: the two tracking modes book consumption differently, so switching under a running print would book it twice or not at all.

What is different in this mode:

- G-code tracking is off completely: no FTPS download and no consumption booking.
- The Web UI shows the classic AMS table instead of the print dashboard.
- Original Bambu Lab spools only. A 3rd party spool reports no remain percentage, so its slot is shown as loaded but offers no action, and manual assignment is unavailable, since it exists to tell the G-code booking which spool to charge and this mode books nothing. Assignments already saved stay on disk and take effect again as soon as G-code tracking is back on.
- The **AMS Lite is not supported** for updating spools, it only reports 100% or 0% left ([#4](https://github.com/Rdiger-36/bambulab-ams-spoolman-filamentstatus/issues/4#issuecomment-2550571529)). Creating spools and filaments and linking their serials still works.

The behaviour, the Web UI and the configuration of this mode are documented in the README of the last release before G-code tracking:

➡️ **[README of v1.2.1](https://github.com/Rdiger-36/bambulab-ams-spoolman-filamentstatus/blob/v1.2.1/README.md)**
