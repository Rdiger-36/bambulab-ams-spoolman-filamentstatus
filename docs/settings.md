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
| **Network access** | The Web UI password, the host names this service may be addressed under, and the API keys for callers that have no browser. All three are empty by default: without a password the Web UI is open to the network, and IP addresses, `localhost` and `.local` names are accepted whatever the host list says |
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

## The Web UI password

Type one into **Web UI password** in the **Network access** card and save. From then on every page and every API call asks for it first, and the browser stays signed in for 30 days. Leave the field empty and nothing changes: that is how every installation behaved before this existed, and it is still the right setting for a service only your own network can reach.

The password is stored as a scrypt hash in `printers/settings.json` and is never sent back to the browser, so the field says "unchanged" rather than showing anything. Typing into it replaces the password, **remove** next to the label takes it away again on the next save, and both take effect without a restart. Repeated wrong guesses from one address have to wait, doubling up to fifteen minutes.

Changing or removing the password ends every session that exists, on every device, because the cookie is signed with it. The browser that made the change keeps working, every other one asks again. **Log out** in the menu ends the session of that browser.

Forgotten it? Stop the container, remove the `AUTH_PASSWORD` line from `printers/settings.json`, start it again. The Web UI is then open until a new one is set.

> [!IMPORTANT]
> The Web UI asks for a password only once you set one under **Network access**. Without one it is open to everyone on the network and can change the printer list and the Spoolman endpoint, so do not expose the port to the internet either way. The access code of a printer is stored in plain text in `printers/printers.json` and is never sent back to the browser.
>
> Other websites cannot reach the API of an installation on your network: the service answers only requests addressed to it, and refuses a writing request that comes from another site. A Web UI reached under a real domain name or through a reverse proxy has to name that host under **Network access** as well.

## API keys

Home Assistant, Node-RED and a shell script have no browser to log in with, and a password typed into an automation is a password stored in clear text somewhere else. **Add key** under **API keys** in the **Network access** card creates one, under a name you pick so you know later which one to revoke.

The key is shown once, when it is created. Only a SHA-256 of it is stored, in `printers/apikeys.json`, so a lost key is replaced rather than looked up. Copy it into the tool that needs it and send it as a header:

```bash
curl -H "Authorization: Bearer ams_..." http://192.168.1.50:4000/api/printers
```

`X-API-Key: ams_...` works just as well, which is the header most home automations ask for by name.

A key is a full session: it reads and it changes everything the Web UI can, including the settings and other keys. There is no permission split, because an installation of this size has no two kinds of caller to separate. What a key does buy over the password is that each one can be revoked on its own, without signing anybody out and without the other keys noticing.

The list shows when each key was created and when it was last used, so a key nothing uses any more is easy to spot. The last use is written at most once a minute: a polling home automation would otherwise rewrite the file a few times a minute forever, and the column is there to say "still in use", not to be an access log.

Locked out of everything, keys included? Stop the container, delete `printers/apikeys.json` and remove the `AUTH_PASSWORD` line from `printers/settings.json`, start it again. The key file is read once at start, so editing it by hand takes effect on the next one.

Keys work whether or not a Web UI password is set. Without a password nothing is behind a login anyway and a key changes nothing about who can reach the service; with one, a key is the way in for everything that cannot log in.

> [!NOTE]
> The key travels in a header on purpose, never in the URL. A URL ends up in the log of every proxy in front of this service, and a value a browser can put in a URL is one a page on another site could put there too. A header cannot be set on a cross site request without a preflight, which the request guard refuses, so a key cannot be used against you by a page you happen to have open.

## A printer that is switched off

Nothing has to be configured for a printer that is off most of the time. The monitor loop probes it with a plain TCP connect, and the wait between two probes doubles from **Offline check interval** up to **Offline backoff limit** (five minutes by default) for as long as it stays away. The log says so once per step and then goes quiet, instead of repeating the same line every twenty seconds all day, and it says when the printer answered again.

Setting the backoff limit to the check interval keeps the old constant pace.

Anything the user does clears the wait, so a printer switched back on is picked up at once rather than after the current backoff: resuming its monitoring, **Reconnect all printers**, and saving its address. Monitoring can also be switched off per printer, in the Web UI or over the API, which is what the [Home Assistant integration](https://github.com/Rdiger-36/ha-bambulab-ams-spoolman-filamentstatus) drives from a switch: nothing is probed at all while it is off.
