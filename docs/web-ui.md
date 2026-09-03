# Web UI

[← Documentation](README.md)

Reachable on `http://<host>:4000`. No authentication, see the warning under [Settings](settings.md).

The dashboard shows the running print, its layer progress, and every loaded spool joined with what the print needs from it: what is on the spool, how much this print takes, and what is left afterwards.

![Dashboard](images/dashboard.png)

Above each unit's table stands what the unit reports about itself: the relative humidity inside it, its temperature, and, while a drying cycle runs, its target temperature and the minutes left. Which of those appear depends on the hardware. An AMS 2 Pro and an AMS HT report all of it. The original AMS and the AMS Lite report only the five step humidity level, 1 being the driest, and have no temperature sensor. The AMS Lite has no humidity sensor either and always reports 5, so take that level for what it is. The external spool holder reports none of it and gets no header.

Under each spool stands whether its consumption can be booked:

| Marker | Meaning |
| :---- | :---- |
| **tag-linked** | An original Bambu Lab spool, linked through the `tag` extra field. Booked automatically |
| **assigned** | Linked by hand to a Spoolman spool. Booked onto that spool |
| **not tracked** | Nothing links this slot to Spoolman yet. The print runs, but nothing is booked. Use **Assign Spool** |

**Assign Spool** offers both ways of linking a slot the printer cannot identify. Picking a spool that already exists in Spoolman, which opens on the ones that fit the slot, same material and closest colour first, and searches the rest by name, vendor, material or location:

![Assign an existing spool](images/assign-dialog.png)

A spool of another material can still be chosen, and says so: the material a slot reports can be wrong, and only you know what is really in there.

Or creating filament and spool right there, filled in from the SpoolmanDB catalogue: manufacturer, then material, then the filament itself. Picking one fills in the colours, the density, the diameter, the temperatures and both weights, none of which a chipless spool reports. A filament that already exists in your Spoolman is used instead of created a second time, and multi colour spools are entered as what they are, one row per colour plus the direction they run in:

![Create a spool for a slot](images/assign-dialog-create.png)

Clicking the filament name of a slot opens what Spoolman and the printer each hold about it. Remaining weight, lot number and comment are corrected in place, each behind a pencil in its row. The remaining weight stays read only while something else is about to write it, in legacy mode and while a print is running, and it cannot be set above what the spool can hold:

![The spool behind a slot](images/spool-dialog.png)

The second tab carries the filament behind the spool, shared by every spool of its kind and therefore edited in Spoolman itself. Both tabs link to their Spoolman page:

![The filament behind a spool](images/spool-dialog-filament.png)

In manual mode the merge and create actions of a Bambu Lab spool work the same way: a button per slot, opening a dialog with what would be written to Spoolman.

One menu on every page carries the dashboard, the printers, the settings and the logs, with the dark and light mode switch on the right:

![Menu](images/menu.png)

Logs are read per printer and for the server, across the rotated history, and can be downloaded:

![Logs](images/logs.png)

Every page follows the dark mode switch:

![Dashboard in dark mode](images/dashboard-dark.png)
