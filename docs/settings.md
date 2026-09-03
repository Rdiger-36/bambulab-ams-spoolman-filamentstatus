# Settings

[← Documentation](README.md)

Everything is stored in `printers/settings.json` and applied to the running service as soon as it is saved, unless a field says otherwise.

![Settings](images/settings.png)

| Card | Holds |
| :---- | :---- |
| **Spoolman connection** | Endpoint, plus host, port, subfolder and public URL in a collapsed section. The line under the field says which URL the service actually talks to |
| **Tracking** | Operation mode and [legacy mode](legacy-mode.md) |
| **Synchronisation** | AMS update interval, writing the AMS slot as the spool location, never merging a tagged spool, [archiving empty spools](how-it-works.md#archiving-empty-spools) |
| **Printer connection** | Offline check interval, the backoff limit for a printer that stays offline and the retry limit |
| **Logging** | Debug logging, log file size and how many rotated files are kept, for the server and per printer |
| **Network access** | The host names this service may be addressed under. IP addresses, `localhost` and `.local` names are always accepted, so most installations leave it empty |
| **Printers** | Add, edit and remove printers, each with a connection test for MQTT and FTPS |
| **Service** | Version, Node, platform, uptime, memory, the tracking mode the process actually runs in, the supervisor state and the Spoolman connection |

A new printer connects right away, a removed one is disconnected and its assignments are dropped. Removing a printer, or changing its address or access code, asks first while a print is running, because the consumption of a running job is booked only when it ends. The serial number cannot be changed, it keys the MQTT topic, the log file and the assignments. **Test connection** checks MQTT on port 8883 and FTPS on port 990 with the values in the form, so an address can be verified before it is saved:

![Printer dialog](images/printer-dialog.png)

The access code is stored on the server and never sent back to the browser; leave the field empty while editing to keep the stored one.

The **Service** card is what a support question usually asks for first, plus the actions that work on the running service rather than on a stored setting:

![Service card](images/settings-service.png)

- **Restart service**: the container runs a small supervisor, so this works whether or not the container has a restart policy. While a print is running it asks first.
- **Reconnect all printers**: rebuilds the MQTT connections without ending the process, so the consumption tracking of a running print is kept.
- **Pause all monitoring**: nothing is processed and nothing written to Spoolman, for while Spoolman is being worked on.
- **Download diagnostics**: see [Diagnostics and privacy](troubleshooting.md#diagnostics-and-privacy).
- **Update check** against the GitHub releases. Nothing is downloaded or installed and nothing about the installation is sent, it is one request for the latest version number, cached for six hours.

> [!IMPORTANT]
> The Web UI has no authentication and is meant for a trusted local network. It can change the printer list and the Spoolman endpoint, so do not expose the port to the internet. The access code of a printer is stored in plain text in `printers/printers.json` and is never sent back to the browser.
>
> Other websites cannot reach the API of an installation on your network: the service answers only requests addressed to it, and refuses a writing request that comes from another site. A Web UI reached under a real domain name or through a reverse proxy has to name that host under **Network access**.

## A printer that is switched off

Nothing has to be configured for a printer that is off most of the time. The monitor loop probes it with a plain TCP connect, and the wait between two probes doubles from **Offline check interval** up to **Offline backoff limit** (five minutes by default) for as long as it stays away. The log says so once per step and then goes quiet, instead of repeating the same line every twenty seconds all day, and it says when the printer answered again.

Setting the backoff limit to the check interval keeps the old constant pace.

Anything the user does clears the wait, so a printer switched back on is picked up at once rather than after the current backoff: resuming its monitoring, **Reconnect all printers**, and saving its address. Monitoring can also be switched off per printer, in the Web UI or over the API, which is what the [Home Assistant integration](https://github.com/Rdiger-36/ha-bambulab-ams-spoolman-filamentstatus) drives from a switch: nothing is probed at all while it is off.
