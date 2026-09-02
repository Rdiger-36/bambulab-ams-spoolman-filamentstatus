import {
    ACTIVE_PRINT_STATES,
    EXTERNAL_SLOT,
    SLOT_OPTIONS,
    correctRemainInt,
    filamentColors,
    formatDate,
    normColor,
    slotColors,
    spoolWeightLimit,
} from "./shared.js";
import { bambuProfile, materialsAgree, slotMaterial } from "./materials.js";
import { escapeHtml, fetchJson } from "./ui.js";

let autoButton = null;
// When false (default) the spool weight is tracked from the sliced G-code, so the
// main table shows the Spoolman remaining weight instead of the AMS RFID remain %.
let legacyMode = false;
// Spoolman reachability, mirrored from /api/status. Read as a flag rather than
// parsed back out of the status pill's text, which carries a "● " prefix.
let spoolmanConnected = false;
// Render context of the last full legacy-table render, reused for single-row
// SSE updates (see upsertSpoolRow).
let lastLegacyCtx = null;
// Printer name, used to suggest a location matching the SET_LOCATION format.
let currentPrinterName = "";
// gcode_state of the shown printer, mirrored from /api/status and kept fresh by
// the G-code view, which reads it again from /api/print.
let printerGcodeState = "IDLE";
// Why a slot without an RFID tag is not a fault. Shown in both views: on the
// identity line of the row and on the warning triangle in the State column,
// which names no reason by itself.
const THIRD_PARTY_HINT = "3rd party spool: no RFID tag, so the printer cannot identify it. Assign a Spoolman spool to track it.";

// The payload behind every rendered row, by AMS slot id. The detail dialog is
// opened from a delegated listener, which sees the clicked element rather than
// the object the row was built from, and rows are recreated on every update.
const renderedSpools = new Map();

// Initialize the document once it has fully loaded
document.addEventListener("DOMContentLoaded", () => {
    
    document.getElementById("monitoring-toggle").addEventListener("change", toggleMonitoring);

    // Clicking a filament name opens the spool detail dialog. Delegated, because
    // both views rebuild their rows on every update and an SSE slot update
    // replaces a single row in place, which would drop a listener bound to it.
    document.getElementById("spool-list").addEventListener("click", event => {
        const name = event.target.closest(".spool-name-link");
        if (!name) return;
        const amsSpool = renderedSpools.get(name.dataset.amsid);
        if (amsSpool) showSpoolDetailDialog(amsSpool);
    });

    // The menu bar owns the printer list and the dark mode button. Picking a
    // printer switches the dashboard in place instead of navigating.
    initMenubar({
        onPrinters: showPrinters,
        onPrinterSelect: printer => {
            loadPrinterData(printer.id);
            return true;
        },
    });

    // Set up Server-Sent Events (SSE) connection for real-time updates
    const eventSource = new EventSource('./api/events'); // Backend URL for events

    // Handle incoming messages from SSE
    eventSource.onmessage = function (event) {
        // Parse the event data
        const data = JSON.parse(event.data);
        const printerId = document.getElementById('printer-serial').textContent;
            
        if (data.type === 'slot_update' && data.printer === printerId && !isDialogOpen()) {
            if (legacyMode) upsertSpoolRow(data.spool);
            else scheduleGcodeRefresh();
        } else if (data.type === 'status' && data.printer === printerId) {

            if (data.lastMqttUpdate) {
                updateElementText(
                   "last-mqtt-update",
                   formatDate(new Date(data.lastMqttUpdate))
                );
            }
            if (data.lastMqttAmsUpdate) {
                updateElementText(
                   "last-mqtt-ams-update",
                   formatDate(new Date(data.lastMqttAmsUpdate))
                );
            }
            // Keep the G-code dashboard (print state / progress) live
            if (!legacyMode) scheduleGcodeRefresh();
        } else if (data.type === 'refresh' && data.printer === printerId) {
          refreshMenubarPrinters();
        } else if (data.type === "monitoring_update") {
            const current = document.getElementById("printer-serial").textContent;

            if (data.printer === current) {
                document.getElementById("monitoring-toggle").checked = data.enabled;
            }
      } else if (data.type === "printers_update") {
            // A printer was added, renamed or removed on the settings page
            refreshMenubarPrinters();
      } else if (data.type === "settings_update") {
            // The status card shows the operation mode and the tracking mode,
            // so it has to be refetched when they change
            if (currentPrinterId) loadPrinterData(currentPrinterId);
      }

    };

    // Handle errors in SSE connection
    eventSource.onerror = function(error) {
        console.error("Error with the SSE connection:", error);
    };

    // Configuration through environment variables is deprecated since 1.3.0.
    // Shown once per installation rather than once per browser: the dismissal
    // is stored server side, and the notice stops being sent on its own as soon
    // as the values have been saved on the settings page.
    async function showDeprecationNotice() {
        let notice;
        try {
            const response = await fetch("./api/notices");
            notice = (await response.json())["env-config"];
        } catch {
            // A hint is not worth an error message of its own.
            return;
        }

        if (!notice || !notice.active || notice.acknowledged) return;

        const code = list => `<code>${list.map(escapeHtml).join("</code>, <code>")}</code>`;
        const parts = [
            "<p>This installation is still configured through environment variables. That is <b>deprecated since 1.3.0</b>.</p>",
            "<p>They keep working, so nothing has to change today. The settings page is the supported place for them now, and the printer list is edited there as well instead of by hand in <code>printers.json</code>.</p>",
        ];

        if (notice.variables && notice.variables.length) {
            parts.push(`<p>Still taken from the environment: ${code(notice.variables)}</p>`);
        }

        if (notice.printerVariables && notice.printerVariables.length) {
            parts.push(notice.printerVariablesIgnored
                ? `<p>${code(notice.printerVariables)} are set but no longer have an effect: <code>printers.json</code> exists and owns the printer list.</p>`
                : `<p>The printer list was seeded from ${code(notice.printerVariables)} and written to <code>printers.json</code>, which owns it from now on.</p>`);
        }

        parts.push("<p>One thing to know before editing your compose file again: once a setting has been saved here, the settings file owns it and the matching variable stops changing anything.</p>");

        const dialog = document.getElementById("notice-dialog");
        document.getElementById("notice-dialog-title").textContent = "Configuration has moved into the Web UI";
        document.getElementById("notice-dialog-content").innerHTML = parts.join("");

        // Dismissed either way, because both buttons mean the hint was read.
        const acknowledge = async () => {
            try {
                await fetch("./api/notices/env-config/ack", { method: "POST" });
            } catch {
                // Then it is shown again on the next load, which is the safe way round.
            }
        };

        document.getElementById("notice-dialog-close").onclick = async () => {
            await acknowledge();
            dialog.close();
        };

        document.getElementById("notice-dialog-open").onclick = async () => {
            await acknowledge();
            dialog.close();
            window.location.href = "settings.html";
        };

        dialog.showModal();
        document.getElementById("notice-dialog-close").focus();
    }

    showDeprecationNotice();

    // Check if any modal dialog is currently open. A live update that rerenders
    // the table underneath an open dialog replaces the row it was opened from,
    // so every dialog that reads a row has to be listed here.
    function isDialogOpen() {
        return ["info-dialog", "spool-detail-dialog"]
            .some(id => document.getElementById(id)?.open);
    }
    
    // Opens a printer whenever the menu bar has loaded or reloaded the list
    function showPrinters(printers) {
        if (!printers.length) {
            // A fresh install has no printers yet. Point at the page that can
            // add one instead of showing an empty dashboard.
            document.getElementById("status").style.display = "none";
            document.getElementById("spool-list").innerHTML =
                '<p style="text-align:center">No printers configured yet. Add one on the <a href="settings.html">settings page</a>.</p>';
            currentPrinterId = null;
            return;
        }

        // Undo the empty state above, in case a printer was just added
        document.getElementById("status").style.display = "";

        // The remembered printer may have been removed on the settings page
        const lastSelectedPrinterId = sessionStorage.getItem("lastSelectedPrinterId");
        const known = printers.some(printer => printer.id === lastSelectedPrinterId);
        loadPrinterData(known ? lastSelectedPrinterId : printers[0].id);
    }

    // Fetch and display data for a specific printer
    async function loadPrinterData(printerId) {
        try {
            const [statusResponse, spoolsResponse] = await Promise.all([
                fetch(`./api/status/${printerId}`),
                fetch(`./api/spools/${printerId}`)
            ]);

            if (!statusResponse.ok || !spoolsResponse.ok) {
                throw new Error("Error fetching printer data.");
            }

            const status = await statusResponse.json();
            const spools = await spoolsResponse.json();

            currentPrinterId = printerId;
            document.getElementById("monitoring-toggle").checked = status.monitoringEnabled === true;

            updateStatus(status); // sets the global legacyMode flag

            if (legacyMode) {
                updateSpools(spools);            // classic AMS table
            } else {
                await loadGcodeView(printerId);  // G-code dashboard
            }
        } catch (error) {
            console.error(`Error loading data for printer ${printerId}:`, error);
        }
    }
    
    // One table per AMS unit: the four slot units in tables of four, the single
    // slot ones (AMS HT and the external spool holder) in a table of their own.
    //
    // Both views group their slots this way and each used to write the grouping
    // out itself, the classic one with its header block spelled out a second
    // time for the single slot tables. The view passes its columns as
    // `[label, alignment]` and the function that builds one of its rows.
    //
    // @param {object[]} spools - the slots to render
    // @param {Array[]} columns - the header cells
    // @param {function(object): HTMLTableRowElement} makeRow - one row
    // @param {string|null} emptyMessage - what to show when nothing is loaded
    // @returns {HTMLTableElement[]} the tables, in display order
    function buildSpoolTables(spools, columns, makeRow, emptyMessage = null) {
        const makeTable = (slots) => {
            const table = document.createElement("table");
            table.className = "spool-table";

            const thead = document.createElement("thead");
            const headerRow = document.createElement("tr");
            for (const [label, align] of columns) {
                const th = document.createElement("th");
                th.textContent = label;
                if (align) th.style.textAlign = align;
                headerRow.appendChild(th);
            }
            thead.appendChild(headerRow);
            table.appendChild(thead);

            const tbody = document.createElement("tbody");
            for (const spool of slots) tbody.appendChild(makeRow(spool));
            table.appendChild(tbody);

            return table;
        };

        const normalAMS = spools.filter(s => !isSingleSlotUnit(s.amsId));
        const singles = spools.filter(s => isSingleSlotUnit(s.amsId));

        const tables = [];
        for (let i = 0; i < normalAMS.length; i += 4) tables.push(makeTable(normalAMS.slice(i, i + 4)));
        for (const single of singles) tables.push(makeTable([single]));

        if (!tables.length && emptyMessage) {
            const empty = makeTable([]);
            empty.querySelector("tbody").innerHTML =
                `<tr><td colspan="${columns.length}" style="opacity:0.5">${escapeHtml(emptyMessage)}</td></tr>`;
            tables.push(empty);
        }

        return tables;
    }

    // Every column of the spool tables, the action column included. Left out, it
    // is the only column without a fixed width and therefore absorbs all the
    // leftover space of the full width table, which parks the button in the
    // middle of a wide empty cell and crams the other columns against the left
    // edge. Both views have these five columns, and all three call sites want
    // all of them.
    const SYNCED_COLUMNS = [0, 1, 2, 3, 4];

    // How often each filament identity is loaded across all units. Two slots the
    // automatic match cannot tell apart get the ⚠ in the Spool cell, which needs
    // the count over every slot and cannot be derived from one row. Both views
    // ask, and both used to count it themselves.
    function countSpoolKeys(spools) {
        const keyCount = {};
        for (const spool of spools) {
            if (spool.slotState === "Empty") continue;
            keyCount[spool.key] = (keyCount[spool.key] || 0) + 1;
        }
        return keyCount;
    }

    // Update the displayed list of spools based on fetched data
    async function updateSpools(spools) {
        const spoolListElement = getElementSafe("spool-list");
        if (!spoolListElement) return;

        spoolListElement.innerHTML = "";

        const columns = [
            ["Spool"], ["Remaining (estimated)"],
            ["Serialnumber"], ["State"], ["Action"],
        ];

        const ctx = { keyCount: countSpoolKeys(spools) };
        // Remembered so single-row SSE updates keep the duplicate-spool ⚠, which
        // needs the counts across all slots and can't be derived from one row.
        lastLegacyCtx = ctx;

        for (const table of buildSpoolTables(spools, columns, spool => createSpoolRow(spool, ctx))) {
            spoolListElement.appendChild(table);
        }

        // Every column to its widest cell, so the tables of the units line up.
        synchronizeSelectedColumns(SYNCED_COLUMNS);
    }
    
    function synchronizeSelectedColumns(indices) {
        const tables = Array.from(document.querySelectorAll('.spool-table'));
        if (tables.length === 0) return;

        // Measure the *content* width of each cell. The tables default to
        // width:100% (generic `table` rule), which stretches every cell; if we
        // measured in that state the per-column maxima would sum to far more
        // than the container and the table would overflow past the menubar /
        // status card. So shrink the tables to their content width first.
        tables.forEach(table => {
            table.style.tableLayout = 'auto';
            table.style.width = 'auto';
        });

        indices.forEach(colIdx => {
            let maxWidth = 0;
            tables.forEach(table => {
                Array.from(table.rows).forEach(row => {
                    const cell = row.cells[colIdx];
                    if (!cell) return;
                    cell.style.width = 'auto';
                    cell.style.minWidth = 'unset';
                    const cellWidth = cell.offsetWidth;
                    if (cellWidth > maxWidth) maxWidth = cellWidth;
                });
            });
            tables.forEach(table => {
                Array.from(table.rows).forEach(row => {
                    const cell = row.cells[colIdx];
                    if (!cell) return;
                    cell.style.minWidth = maxWidth + "px";
                    cell.style.width = maxWidth + "px";
                });
            });
        });

        // Restore full width so the table spans the same width as the menubar
        // and the status card; the synced columns keep their fixed px widths and
        // the remaining (non-synced) columns absorb the leftover space.
        tables.forEach(table => {
            table.style.width = '';
            table.style.tableLayout = '';
        });
    }
    
    // The CSS background showing a whole colour set in one box.
    //
    // `direction` is Spoolman's multi_color_direction. A "longitudinal"
    // filament changes colour along its length, which is what the gradient
    // spools do, so it fades. A "coaxial" one carries its colours side by side
    // down the strand and reads as hard bands. An unknown or missing direction
    // is drawn as bands too: equal hard stripes still show every colour, while
    // a fade would invent a transition that may not exist.
    function colorSetBackground(colors, direction) {
        if (!colors.length) return "";
        if (colors.length === 1) return `#${colors[0]}`;

        if (direction === "longitudinal") {
            return `linear-gradient(to right, ${colors.map(c => `#${c}`).join(", ")})`;
        }

        const stops = colors.map((color, index) => {
            const from = (index / colors.length) * 100;
            const to = ((index + 1) / colors.length) * 100;
            return `#${color} ${from.toFixed(2)}% ${to.toFixed(2)}%`;
        });
        return `linear-gradient(to right, ${stops.join(", ")})`;
    }

    // The small square in front of a filament name. Empty string when there is
    // no colour to show, so a caller can concatenate it unconditionally.
    function swatchHtml(colors, direction = null) {
        const background = colorSetBackground(colors, direction);
        if (!background) return "";
        // Uppercase only here: the sets arrive lowercased, because that is the
        // case the colour comparisons settled on, and a hex reads as a colour
        // in upper.
        const title = colors.map(c => `#${normColor(c)}`).join(" ");
        return `<span class="gc-swatch" style="background:${background}" title="${title}"></span>`;
    }

    // Build an action button with the shared Create/Merge/Show behaviour.
    function createActionButton(amsSpool) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-small";
        button.disabled = true;
        setupButton(button, amsSpool);

        button.addEventListener("click", () => {
            // Spool assignment has its own flow: it needs a picker populated from
            // Spoolman rather than a fixed confirmation text.
            if (button.textContent === SLOT_OPTIONS.ASSIGN)   return showAssignDialog(button, amsSpool);
            if (button.textContent === SLOT_OPTIONS.UNASSIGN) return showUnassignDialog(button, amsSpool);

            const content = generateDialogContent(button, amsSpool);
            const actionMap = {
                [SLOT_OPTIONS.CREATE]: "Create",
                [SLOT_OPTIONS.MERGE]: "Merge",
                [SLOT_OPTIONS.CREATE_WITH_FILAMENT]: SLOT_OPTIONS.CREATE_WITH_FILAMENT,
                [SLOT_OPTIONS.SHOW_INFO]: "Go to Spoolman"
            };
            const actionText = actionMap[button.textContent] || SLOT_OPTIONS.NONE;
            const actionCallback = () => performAction(button, amsSpool);
            showDialog(button, content, actionText, actionCallback);
        });

        return button;
    }

    // ---------------------------------------------------------------------
    // Manual spool assignment
    //
    // 3rd-party spools have no RFID chip, so nothing links them to a Spoolman
    // spool automatically and their consumption can't be booked. The same picker
    // also resolves two tagged spools that are identical in material and color,
    // which the automatic match can't tell apart.
    // ---------------------------------------------------------------------

    // Ranks Spoolman spools by how well they fit the slot: the same material and
    // the same colours first, then the same material by how close its colour is,
    // then the rest. An inventory of forty spools is otherwise a list to read
    // through rather than a choice to make.
    function rankSpoolsForSlot(spools, slot) {
        // The material of the profile the AMS names, compared by family: the
        // printer reports "PLA" where Spoolman holds "PLA Silk", so the exact
        // comparison this used to make put almost every spool in the last rank.
        const reported = slotMaterial(slot || {});
        // Compared as a set rather than as a single hex, so a multi colour spool
        // can reach the top for its own slot. Those carry no color_hex at all,
        // so against the single field they always ranked last.
        const slotColorSet = slotColors(slot);

        const score = (sp) => {
            const material = sp.filament?.material;
            const sameMaterial = Boolean(reported && material && materialsAgree(reported, material));
            const distance = colorSetDistance(slotColorSet, filamentColors(sp.filament));

            if (sameMaterial && distance === 0) return { rank: 0, distance };
            if (sameMaterial) return { rank: 1, distance };
            return { rank: 2, distance };
        };

        return [...spools]
            .map(sp => ({ sp, ...score(sp) }))
            .sort((a, b) => a.rank - b.rank || a.distance - b.distance || a.sp.id - b.sp.id);
    }

    // How far two colour sets sit apart, 0 for the same colours and Infinity when
    // one of them has no colour at all.
    //
    // Every colour is measured against the closest one on the other side, in both
    // directions: taken one way only, a two colour spool would count as identical
    // to a single colour one as soon as one of its colours matched.
    function colorSetDistance(a, b) {
        if (!a.length || !b.length) return Infinity;

        const rgb = (color) => {
            const hex = normColor(color).padEnd(6, "0");
            return [0, 2, 4].map(at => parseInt(hex.slice(at, at + 2), 16) || 0);
        };

        const nearest = (color, set) => Math.min(...set.map(other => {
            const [r1, g1, b1] = rgb(color);
            const [r2, g2, b2] = rgb(other);
            return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
        }));

        const distances = [...a.map(c => nearest(c, b)), ...b.map(c => nearest(c, a))];
        return distances.reduce((total, one) => total + one, 0) / distances.length;
    }

    function spoolPickerLabel(sp) {
        const fil   = sp.filament || {};
        const parts = [fil.vendor?.name, fil.material, fil.name].filter(Boolean);
        const left  = sp.remaining_weight != null ? `${Math.round(sp.remaining_weight)}g left` : "unknown weight";
        const swatch = swatchHtml(filamentColors(fil), fil.multi_color_direction);
        return `${swatch}#${sp.id} ${parts.join(" · ") || "Unknown filament"} <span class="gc-muted">(${left})</span>`;
    }

    async function showAssignDialog(button, amsSpool) {
        showDialog(button, `<p>Loading data from Spoolman…</p>`, "Assign", () => {});
        const dialogContent = document.getElementById("dialog-content");
        const actionButton  = document.getElementById("action-button");
        actionButton.disabled = true;

        let spools, lookups;
        try {
            [spools, lookups] = await Promise.all([
                fetchJson("./api/spoolman/spools"),
                fetchJson("./api/spoolman/lookups"),
            ]);
        } catch (err) {
            dialogContent.innerHTML = `<p class="gc-bad">Could not load data from Spoolman: ${escapeHtml(err.message)}</p>`;
            return;
        }

        const slot = amsSpool.slot || {};
        dialogContent.innerHTML = `
            <p style="margin-top:0">AMS slot <strong>${escapeHtml(amsSpool.amsId)}</strong> holds a spool the printer cannot identify
               (${escapeHtml([slot.tray_type, slot.tray_sub_brands].filter(Boolean).join(" · ") || "unknown filament")}).
               Link it to a Spoolman spool so its consumption can be booked.</p>
            <div class="sp-tabs">
                <button type="button" class="sp-tab sp-tab-active" data-mode="assign">Use existing spool</button>
                <button type="button" class="sp-tab" data-mode="create">Create new spool</button>
            </div>
            <div id="sp-pane"></div>`;

        const pane = dialogContent.querySelector("#sp-pane");
        const tabs = [...dialogContent.querySelectorAll(".sp-tab")];

        const selectMode = (mode) => {
            for (const t of tabs) t.classList.toggle("sp-tab-active", t.dataset.mode === mode);
            if (mode === "assign") renderAssignPane(pane, actionButton, button, amsSpool, spools);
            else renderCreatePane(pane, actionButton, button, amsSpool, lookups);
        };
        for (const t of tabs) t.addEventListener("click", () => selectMode(t.dataset.mode));

        // Nothing to assign yet on a fresh Spoolman, so start on the form instead of
        // an empty picker.
        selectMode(spools.length ? "assign" : "create");
    }

    // How many spools the suggestion list offers before the rest is left to the
    // full list below it. Enough to hold the obvious candidates of a slot,
    // short enough to stay a suggestion.
    const ASSIGN_SUGGESTIONS = 6;

    function renderAssignPane(pane, actionButton, button, amsSpool, spools) {
        actionButton.textContent = "Assign";
        actionButton.disabled = true;

        if (!spools.length) {
            pane.innerHTML = `<p class="gc-muted">No spools in Spoolman yet. Use "Create new spool".</p>`;
            return;
        }

        // The printer knows what material sits in the slot even for a spool it
        // cannot identify, so an assignment that would book PLA onto an ABS spool
        // can be pointed out. It is a warning, not a rule: the material a slot
        // reports can be wrong, and only the user knows what is really in there.
        const reported = slotMaterial(amsSpool.slot || {});
        const mismatched = new Set(spools
            .filter(sp => !materialsAgree(reported, sp.filament?.material))
            .map(sp => sp.id));

        const ranked = rankSpoolsForSlot(spools, amsSpool.slot || {});
        // Only a spool of the right material is ever suggested. Suggesting the
        // closest colour out of an inventory that holds nothing fitting would put
        // an ABS spool at the top of a PLA slot.
        const suggested = ranked.filter(entry => entry.rank < 2).slice(0, ASSIGN_SUGGESTIONS);
        const suggestedIds = new Set(suggested.map(entry => entry.sp.id));

        const pick = (entry) => `
            <label class="sp-pick">
                <input type="radio" name="assign-spool" value="${entry.sp.id}"> ${spoolPickerLabel(entry.sp)}${entry.rank === 0
                    ? ` <span class="gc-ok" title="Same material and the same colours as the slot reports">● same colour</span>`
                    : ""}${mismatched.has(entry.sp.id)
                    ? ` <span class="gc-warn" title="The printer reports ${escapeHtml(reported)} in this slot">⚠ ${escapeHtml(entry.sp.filament?.material ?? "other material")}</span>`
                    : ""}
            </label>`;

        // Everything a spool can be recognised by, so the search does not have to
        // guess which of them the user typed.
        const haystack = (sp) => [
            `#${sp.id}`,
            sp.filament?.vendor?.name,
            sp.filament?.material,
            sp.filament?.name,
            sp.location,
            sp.lot_nr,
            sp.comment,
        ].filter(Boolean).join(" ").toLowerCase();

        pane.innerHTML = `
            <label class="sp-search">
                <input id="sp-search" type="search" autocomplete="off" placeholder="Search by name, material, vendor or location">
            </label>
            <div class="sp-scroll" id="sp-list"></div>
            <p class="sp-note gc-warn" id="sp-material-warning"></p>`;

        const list = pane.querySelector("#sp-list");
        const search = pane.querySelector("#sp-search");
        const warning = pane.querySelector("#sp-material-warning");

        // Rerendered on every keystroke, so the selection has to be carried over
        // rather than read off the DOM that is about to be replaced.
        let selectedId = null;

        const render = () => {
            const term = search.value.trim().toLowerCase();
            const matches = term ? ranked.filter(entry => haystack(entry.sp).includes(term)) : ranked;

            if (!matches.length) {
                list.innerHTML = `<p class="gc-muted sp-wide">No spool matches "${escapeHtml(search.value.trim())}".</p>`;
                return;
            }

            // While searching, the split into suggestions and the rest only gets
            // in the way: what was typed is the filter, and the ranking still puts
            // the closest first.
            if (term) {
                list.innerHTML = `
                    <div class="sp-section">${matches.length} of ${ranked.length} spools</div>
                    ${matches.map(pick).join("")}`;
            } else {
                const rest = ranked.filter(entry => !suggestedIds.has(entry.sp.id));
                list.innerHTML = `
                    ${suggested.length ? `
                        <div class="sp-section" title="Same material as the slot reports, closest colour first">Suggested for this slot</div>
                        ${suggested.map(pick).join("")}` : ""}
                    ${rest.length ? `
                        <div class="sp-section">${suggested.length ? "Other spools" : "All spools"} (${rest.length})</div>
                        ${rest.map(pick).join("")}` : ""}`;
            }

            const stillThere = selectedId != null && list.querySelector(`input[value="${selectedId}"]`);
            if (stillThere) stillThere.checked = true;
            actionButton.disabled = !stillThere;
        };

        list.addEventListener("change", () => {
            const picked = list.querySelector('input[name="assign-spool"]:checked');
            if (!picked) return;

            selectedId = Number(picked.value);
            actionButton.disabled = false;

            const spool = spools.find(sp => sp.id === selectedId);
            warning.textContent = spool && mismatched.has(spool.id)
                ? `The printer reports ${reported} in this slot, spool #${spool.id} is ${spool.filament?.material ?? "of another material"}. It can still be assigned, and this slot's consumption is then booked onto that spool.`
                : "";
        });

        search.addEventListener("input", render);
        render();

        actionButton.onclick = () => {
            if (selectedId == null) return;
            document.getElementById("info-dialog").close();
            sendMapping(button, amsSpool, selectedId);
        };
    }

    // Keeps the first spelling of every entry and drops the later duplicates, so
    // the local "PLA" is not listed a second time as the catalogue's "pla".
    function uniqueByCase(values) {
        const seen = new Set();
        const unique = [];

        for (const value of values) {
            const key = String(value ?? "").trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            unique.push(String(value).trim());
        }
        return unique;
    }

    // Runs the last call of a burst, once the typing has stopped.
    function debounce(fn, ms = 250) {
        let timer = null;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
    }

    function sameText(a, b) {
        return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
    }

    /** The colours a catalogue entry carries, in the shape the swatches use. */
    function catalogueColors(entry) {
        if (entry.color_hexes?.length) return entry.color_hexes.map(c => normColor(c).toLowerCase());
        return entry.color_hex ? [normColor(entry.color_hex).toLowerCase()] : [];
    }

    // What each catalogue entry is called in the picker.
    //
    // The name alone, because the two steps above it already said which
    // manufacturer and which material this is. The catalogue lists the same
    // filament once per spool it is sold on, so "Panchroma Regular Grey" is
    // three entries that differ in weight and in the spool they come on, and a
    // name that occurs more than once carries exactly the fields that differ
    // between its entries. Adding the manufacturer to all of them, as this did
    // at first, only printed the same qualifier twice.
    function catalogueLabels(entries) {
        const parts = {
            manufacturer: entry => entry.manufacturer,
            material: entry => entry.material,
            weight: entry => (entry.weight == null ? null : `${Math.round(entry.weight)} g`),
            diameter: entry => (entry.diameter == null ? null : `${entry.diameter} mm`),
            spool_type: entry => entry.spool_type,
        };

        const byName = new Map();
        for (const entry of entries) {
            const name = entry.name ?? "";
            byName.set(name, [...(byName.get(name) ?? []), entry]);
        }

        const labelled = [];
        for (const [name, group] of byName) {
            if (group.length === 1) {
                labelled.push([name, group[0]]);
                continue;
            }

            const telling = Object.entries(parts)
                .filter(([, read]) => new Set(group.map(read)).size > 1)
                .map(([, read]) => read);

            for (const entry of group) {
                const qualifiers = telling.map(read => read(entry)).filter(Boolean);
                labelled.push([[name, ...qualifiers].join(" · "), entry]);
            }
        }

        return labelled;
    }

    // Values a chipless spool does report, used to pre-fill the form.
    //
    // The AMS reports every colour of a multi colour spool, so all of them are
    // offered: taking only `tray_color` created a plain black spool for a
    // filament that is black and red.
    function slotDefaults(slot) {
        const colors = slotColors(slot).map(c => normColor(c));
        return {
            material: slot.tray_type || "",
            colors: colors.length ? colors : [normColor(slot.tray_color) || "000000"],
        };
    }

    function renderCreatePane(pane, actionButton, button, amsSpool, lookups) {
        actionButton.textContent = "Create";
        actionButton.disabled = false;

        const slot = amsSpool.slot || {};
        const defaults = slotDefaults(slot);

        // What this Spoolman already holds comes first in every list, and the
        // SpoolmanDB catalogue fills in what it does not: a first spool would
        // otherwise be typed into empty fields with nothing to pick from.
        const materials = uniqueByCase([
            ...(lookups.materials || []),
            ...(lookups.externalMaterials || []).map(m => m.material),
        ]);

        const vendors = uniqueByCase([
            ...(lookups.vendors || []).map(v => v.name),
            ...(lookups.externalVendors || []),
        ]);

        const filamentOptions = (lookups.filaments || [])
            .map(f => `<option value="${f.id}">#${f.id} ${escapeHtml([f.vendor?.name, f.material, f.name].filter(Boolean).join(" · "))}</option>`)
            .join("");

        pane.innerHTML = `
            <div class="sp-scroll">
                <div class="sp-section">Filament</div>
                <label class="sp-field sp-wide">
                    <span>Use a filament you already have</span>
                    <select id="sp-filament">
                        <option value="">+ Create a new filament</option>
                        ${filamentOptions}
                    </select>
                </label>

                <div id="sp-filament-fields">
                    <div class="sp-wide sp-catalogue">
                        <div class="sp-catalogue-title">Fill the new filament in from the catalogue</div>
                        <div class="sp-catalogue-steps">
                            <label class="sp-field">
                                <span>1. Manufacturer</span>
                                <input id="sp-cat-vendor" list="sp-cat-vendors" autocomplete="off" placeholder="all manufacturers">
                                <datalist id="sp-cat-vendors">${(lookups.externalVendors || []).map(v => `<option value="${escapeHtml(v)}">`).join("")}</datalist>
                            </label>
                            <label class="sp-field">
                                <span>2. Material</span>
                                <input id="sp-cat-material" list="sp-cat-materials" autocomplete="off" placeholder="all materials"
                                    value="${escapeHtml(defaults.material)}">
                                <datalist id="sp-cat-materials"></datalist>
                            </label>
                            <label class="sp-field">
                                <span>3. Filament</span>
                                <input id="sp-cat-filament" list="sp-cat-filaments" autocomplete="off" placeholder="pick one to fill the form">
                                <datalist id="sp-cat-filaments"></datalist>
                            </label>
                        </div>
                        <small class="gc-muted" id="sp-catalogue-hint"></small>
                    </div>

                    <div class="sp-subsection">Filament data</div>
                    <label class="sp-field">
                        <span>Manufacturer</span>
                        <input id="sp-vendor" list="sp-vendors" autocomplete="off" placeholder="e.g. Sunlu">
                        <datalist id="sp-vendors">${vendors.map(v => `<option value="${escapeHtml(v)}">`).join("")}</datalist>
                        <small class="gc-muted" id="sp-vendor-hint"></small>
                    </label>
                    <label class="sp-field">
                        <span>Material *</span>
                        <input id="sp-material" list="sp-materials" autocomplete="off" value="${escapeHtml(defaults.material)}">
                        <datalist id="sp-materials">${materials.map(m => `<option value="${escapeHtml(m)}">`).join("")}</datalist>
                        <small class="gc-muted" id="sp-material-hint"></small>
                    </label>
                    <label class="sp-field">
                        <span>Name</span>
                        <input id="sp-name" placeholder="e.g. Galaxy Black">
                    </label>

                    <div class="sp-subsection">Colour</div>
                    <div class="sp-wide">
                        <div id="sp-colours" class="sp-colours"></div>
                        <div class="sp-colour-actions">
                            <button type="button" class="btn btn-small" id="sp-colour-add">Add a colour</button>
                            <select id="sp-direction" title="How the colours run along the filament">
                                <option value="coaxial">coaxial</option>
                                <option value="longitudinal">longitudinal</option>
                            </select>
                        </div>
                        <small class="gc-muted" id="sp-colour-hint"></small>
                    </div>

                    <div class="sp-subsection">Specifications</div>
                    <label class="sp-field">
                        <span>Density * (g/cm³)</span>
                        <input type="number" id="sp-density" step="0.01" min="0.01">
                    </label>
                    <label class="sp-field">
                        <span>Diameter * (mm)</span>
                        <input type="number" id="sp-diameter" step="0.01" min="0.01" value="1.75">
                    </label>
                    <label class="sp-field">
                        <span>Nozzle temp (°C)</span>
                        <input type="number" id="sp-extruder-temp">
                    </label>
                    <label class="sp-field">
                        <span>Bed temp (°C)</span>
                        <input type="number" id="sp-bed-temp">
                    </label>

                    <div class="sp-subsection">Weights</div>
                    <label class="sp-field">
                        <span>Full weight (g)</span>
                        <input type="number" id="sp-weight" min="0" value="1000">
                    </label>
                    <label class="sp-field">
                        <span>Empty spool (g)</span>
                        <input type="number" id="sp-spool-weight" min="0" value="250">
                    </label>
                </div>

                <div class="sp-section">Spool</div>
                <label class="sp-field">
                    <span>Initial weight (g)</span>
                    <input type="number" id="sp-initial-weight" min="0" value="1000">
                </label>
                <label class="sp-field">
                    <span>Remaining (g)</span>
                    <input type="number" id="sp-remaining-weight" min="0" placeholder="leave empty if full">
                </label>
                <label class="sp-field">
                    <span>Location</span>
                    <input id="sp-location" list="sp-locations" autocomplete="off" value="${escapeHtml(currentPrinterName ? `${currentPrinterName} - ${amsSpool.amsId}` : "")}">
                    <datalist id="sp-locations">${(lookups.locations || []).map(l => `<option value="${escapeHtml(l)}">`).join("")}</datalist>
                </label>
                <label class="sp-field sp-wide">
                    <span>Comment</span>
                    <input id="sp-comment" placeholder="optional">
                </label>
                <p class="gc-muted sp-note">The spool is linked to this AMS slot right away. A chipless spool reports no weight,
                   so full and remaining weight have to be entered by hand.</p>
                <p id="sp-error" class="gc-bad"></p>
            </div>`;

        const $ = (id) => pane.querySelector(`#${id}`);

        // Picking an existing filament makes every filament field irrelevant
        $("sp-filament").addEventListener("change", (e) => {
            $("sp-filament-fields").style.display = e.target.value ? "none" : "";
        });

        // The SpoolmanDB catalogue, narrowed down in steps rather than searched in
        // one go: it holds around seven thousand entries, and reading a list of
        // that length is what picking a manufacturer first avoids. Every step is
        // an input with its own suggestions, so a name can also just be typed.
        //
        // Picking an entry fills in the colours, the density, the temperatures and
        // the weights, none of which can be read off a chipless spool at all.
        const catalogue = new Map();
        // Answers can come back out of order, and the first load is the slowest
        // one: without this the unfiltered list of the initial load landed after
        // the narrowed one and put the whole catalogue back on screen. The two
        // lists count separately, they are loaded together and neither of them
        // supersedes the other.
        const pending = { materials: 0, entries: 0 };

        const catalogueQuery = (extra = {}) => {
            const params = new URLSearchParams();
            const vendor = $("sp-cat-vendor").value.trim();
            const material = $("sp-cat-material").value.trim();
            if (vendor) params.set("manufacturer", vendor);
            if (material) params.set("material", material);
            for (const [key, value] of Object.entries(extra)) params.set(key, value);
            return params;
        };

        const askCatalogue = async (params) => {
            try {
                return await fetchJson(`./api/spoolman/external/filaments?${params}`);
            } catch {
                // The form works without it, so a catalogue that cannot be reached
                // costs the suggestions and nothing else.
                $("sp-catalogue-hint").textContent = "The filament catalogue could not be loaded";
                return null;
            }
        };

        const fillDatalist = (id, values) => {
            document.getElementById(id).innerHTML = values
                .map(value => `<option value="${escapeHtml(value)}">`).join("");
        };

        // The materials the chosen manufacturer actually sells.
        const loadMaterials = async () => {
            const request = ++pending.materials;
            const materials = await askCatalogue(catalogueQuery({ facet: "material" }));
            if (materials && request === pending.materials) fillDatalist("sp-cat-materials", materials);
        };

        // The entries left once manufacturer and material have been narrowed down.
        const loadEntries = async () => {
            const request = ++pending.entries;
            const entries = await askCatalogue(catalogueQuery({ limit: 500 }));
            if (!entries || request !== pending.entries) return;

            const ordered = [...entries].sort((a, b) =>
                String(a.name ?? "").localeCompare(String(b.name ?? "")));

            catalogue.clear();
            for (const [label, entry] of catalogueLabels(ordered)) catalogue.set(label, entry);

            fillDatalist("sp-cat-filaments", [...catalogue.keys()]);
            $("sp-catalogue-hint").textContent = ordered.length
                ? `${ordered.length}${ordered.length === 500 ? "+" : ""} entries, by name`
                : "Nothing in the catalogue matches this manufacturer and material";
        };

        // Picking an entry fills the form. A filament this Spoolman already holds
        // wins over the catalogue: creating a second one that only differs in its
        // id is how an inventory ends up with four "Sunlu PLA Grey".
        const applyCatalogueEntry = () => {
            const entry = catalogue.get($("sp-cat-filament").value.trim());
            if (!entry) return;

            const sameVendorAndName = (lookups.filaments || []).filter(f =>
                sameText(f.name, entry.name) && sameText(f.vendor?.name, entry.manufacturer));
            const local = sameVendorAndName.find(f => sameText(f.material, entry.material));

            if (local) {
                $("sp-filament").value = String(local.id);
                $("sp-filament-fields").style.display = "none";
                showNotification(`This filament already exists in Spoolman as #${local.id}, using it.`, "success");
                return;
            }

            $("sp-vendor").value = entry.manufacturer ?? "";
            $("sp-material").value = entry.material ?? "";
            $("sp-name").value = entry.name ?? "";
            if (entry.density != null) $("sp-density").value = entry.density;
            if (entry.diameter != null) $("sp-diameter").value = entry.diameter;
            if (entry.extruder_temp != null) $("sp-extruder-temp").value = entry.extruder_temp;
            if (entry.bed_temp != null) $("sp-bed-temp").value = entry.bed_temp;
            if (entry.weight != null) $("sp-weight").value = entry.weight;
            if (entry.spool_weight != null) $("sp-spool-weight").value = entry.spool_weight;
            if (entry.weight != null) $("sp-initial-weight").value = entry.weight;

            const colors = catalogueColors(entry);
            if (colors.length) {
                drawColours(colors.map(c => normColor(c)));
                if (entry.multi_color_direction) $("sp-direction").value = entry.multi_color_direction;
            }

            const notes = ["Filled in from the catalogue"];
            if (sameVendorAndName.length) {
                notes.push(`your Spoolman already holds #${sameVendorAndName[0].id} ${sameVendorAndName[0].material ?? ""} of this name`.trim());
            }
            $("sp-catalogue-hint").textContent = notes.join(", ");
        };

        // A step that changes invalidates the ones below it, otherwise a filament
        // picked for one manufacturer stays in the field for the next.
        const onVendorStep = debounce(() => {
            $("sp-cat-filament").value = "";
            loadMaterials();
            loadEntries();
        });

        const onMaterialStep = debounce(() => {
            $("sp-cat-filament").value = "";
            loadEntries();
        });

        $("sp-cat-vendor").addEventListener("input", onVendorStep);
        $("sp-cat-material").addEventListener("input", onMaterialStep);
        $("sp-cat-filament").addEventListener("input", applyCatalogueEntry);
        $("sp-cat-filament").addEventListener("change", applyCatalogueEntry);

        loadMaterials();
        loadEntries();

        // Density is required and cannot be read off the spool, so fill it (and the
        // temperatures) from Spoolman's material catalogue as soon as one matches.
        const applyMaterialDefaults = () => {
            const value = $("sp-material").value.trim().toLowerCase();
            const known = (lookups.externalMaterials || []).find(m => m.material.toLowerCase() === value);
            const hint = $("sp-material-hint");
            if (!known) {
                hint.textContent = value ? "Not a known material, enter density yourself" : "";
                return;
            }
            hint.textContent = `Defaults from ${known.material}`;
            if (!$("sp-density").value) $("sp-density").value = known.density ?? "";
            if (!$("sp-extruder-temp").value && known.extruder_temp != null) $("sp-extruder-temp").value = known.extruder_temp;
            if (!$("sp-bed-temp").value && known.bed_temp != null) $("sp-bed-temp").value = known.bed_temp;
        };
        $("sp-material").addEventListener("input", applyMaterialDefaults);
        applyMaterialDefaults();

        // Typing a manufacturer that does not exist yet creates it on save
        const vendorNames = new Set((lookups.vendors || []).map(v => v.name.toLowerCase()));
        $("sp-vendor").addEventListener("input", () => {
            const value = $("sp-vendor").value.trim();
            $("sp-vendor-hint").textContent = value && !vendorNames.has(value.toLowerCase())
                ? "New manufacturer, will be created"
                : "";
        });

        // A filament can carry more than one colour, and both the AMS and the
        // catalogue report all of them. Spoolman keeps them as a list plus the
        // direction they run in, so the form does the same: one row per colour,
        // and the direction only asked for once there is more than one.
        const colourRow = (hex) => `
            <span class="sp-colour">
                <input type="color" class="sp-colour-pick" value="#${hex}">
                <input class="sp-colour-hex" value="${hex}" maxlength="6" autocomplete="off">
                <button type="button" class="sp-colour-remove" title="Remove this colour">✕</button>
            </span>`;

        const currentColours = () => [...pane.querySelectorAll(".sp-colour-hex")]
            .map(input => normColor(input.value))
            .filter(hex => /^[0-9A-F]{6}$/.test(hex));

        const drawColours = (colours) => {
            $("sp-colours").innerHTML = colours.map(colourRow).join("");
            // A single colour has no direction to run in, and Spoolman stores it
            // in the plain colour field then.
            $("sp-direction").style.display = colours.length > 1 ? "" : "none";
            $("sp-colours").classList.toggle("sp-colours-single", colours.length < 2);
            $("sp-colour-hint").textContent = colours.length > 1
                ? `${colours.length} colours, stored as a multi colour filament`
                : "";
        };

        $("sp-colours").addEventListener("input", (event) => {
            const row = event.target.closest(".sp-colour");
            if (!row) return;

            if (event.target.classList.contains("sp-colour-pick")) {
                row.querySelector(".sp-colour-hex").value = event.target.value.replace("#", "").toUpperCase();
            } else {
                const hex = normColor(event.target.value);
                if (/^[0-9A-F]{6}$/.test(hex)) row.querySelector(".sp-colour-pick").value = `#${hex}`;
            }
        });

        $("sp-colours").addEventListener("click", (event) => {
            if (!event.target.classList.contains("sp-colour-remove")) return;
            const colours = currentColours();
            const index = [...pane.querySelectorAll(".sp-colour")].indexOf(event.target.closest(".sp-colour"));
            colours.splice(index, 1);
            drawColours(colours.length ? colours : ["000000"]);
        });

        $("sp-colour-add").addEventListener("click", () => {
            drawColours([...currentColours(), "FFFFFF"]);
        });

        drawColours(defaults.colors);

        // Full weight is the usual starting point for a spool's initial weight
        $("sp-weight").addEventListener("input", () => { $("sp-initial-weight").value = $("sp-weight").value; });

        actionButton.onclick = () => submitNewSpool(pane, actionButton, button, amsSpool, lookups);
    }

    async function submitNewSpool(pane, actionButton, button, amsSpool, lookups) {
        const $ = (id) => pane.querySelector(`#${id}`);
        const error = $("sp-error");
        error.textContent = "";

        const filamentId = $("sp-filament").value;
        const payload = { spool: {
            initialWeight:   $("sp-initial-weight").value,
            remainingWeight: $("sp-remaining-weight").value,
            location:        $("sp-location").value,
            comment:         $("sp-comment").value,
        } };

        if (filamentId) {
            payload.filamentId = Number(filamentId);
        } else {
            const vendorName = $("sp-vendor").value.trim();
            const known = (lookups.vendors || []).find(v => v.name.toLowerCase() === vendorName.toLowerCase());

            payload.filament = {
                vendorId:     known?.id ?? null,
                vendorName:   known ? null : vendorName,
                name:         $("sp-name").value,
                material:     $("sp-material").value,
                density:      $("sp-density").value,
                diameter:     $("sp-diameter").value,
                colorHexes:   [...pane.querySelectorAll(".sp-colour-hex")].map(input => input.value),
                multiColorDirection: $("sp-direction").value,
                weight:       $("sp-weight").value,
                spoolWeight:  $("sp-spool-weight").value,
                extruderTemp: $("sp-extruder-temp").value,
                bedTemp:      $("sp-bed-temp").value,
            };

            if (!payload.filament.material.trim()) { error.textContent = "Material is required."; return; }
            if (!(Number(payload.filament.density) > 0))  { error.textContent = "Density is required and must be greater than 0."; return; }
            if (!(Number(payload.filament.diameter) > 0)) { error.textContent = "Diameter is required and must be greater than 0."; return; }
        }

        const original = actionButton.textContent;
        actionButton.disabled = true;
        actionButton.textContent = "Creating...";

        try {
            const res = await fetch(`./api/thirdparty/spool/${encodeURIComponent(currentPrinterId)}/${encodeURIComponent(amsSpool.amsId)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const body = await res.json().catch(() => ({}));

            if (!res.ok) {
                error.textContent = body.error || `Request failed (HTTP ${res.status})`;
                actionButton.disabled = false;
                actionButton.textContent = original;
                return;
            }

            document.getElementById("info-dialog").close();
            showNotification(`Spool #${body.spoolId} created and assigned to ${amsSpool.amsId}.`, "success");
            await loadPrinterData(currentPrinterId);
        } catch (err) {
            console.error("Spool creation failed:", err);
            error.textContent = "Request failed. Please check your connection.";
            actionButton.disabled = false;
            actionButton.textContent = original;
        }
    }

    function showUnassignDialog(button, amsSpool) {
        const sp = amsSpool.existingSpool;
        const content = `
            <p>Remove the assignment of AMS slot <strong>${amsSpool.amsId}</strong>
               ${sp ? `from Spoolman spool <strong>#${sp.id}</strong>` : ""}?</p>
            <p class="gc-muted" style="font-size:0.85em">Consumption for this slot will no longer be booked until it is assigned again.
               Already booked weight is not reverted.</p>`;
        showDialog(button, content, "Unassign", () => sendMapping(button, amsSpool, null));
    }

    // null spoolId removes the assignment.
    async function sendMapping(button, amsSpool, spoolId) {
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = "Sending...";

        const url = `./api/mappings/${encodeURIComponent(currentPrinterId)}/${encodeURIComponent(amsSpool.amsId)}`;

        try {
            const res = spoolId == null
                ? await fetch(url, { method: "DELETE" })
                : await fetch(url, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ spoolId }),
                  });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                showNotification(`Error: ${err.error || "Assignment failed"}`, "error");
                button.textContent = originalText;
                button.disabled = false;
                return;
            }

            showNotification(spoolId == null ? "Assignment removed." : `Slot assigned to spool #${spoolId}.`, "success");
            // The backend also pushes a slot_update over SSE, but re-render right
            // away so the row never sits on "Sending..." if that event is missed.
            await loadPrinterData(currentPrinterId);
        } catch (err) {
            console.error("Assignment failed:", err);
            showNotification("Request failed. Please check your connection.", "error");
            button.textContent = originalText;
            button.disabled = false;
        }
    }

    // ---- Spool detail dialog -------------------------------------------------
    // Opened from a filament name in either table. One tab for the spool, one for
    // the filament behind it, each showing the whole Spoolman record next to a
    // large colour swatch and a link to its Spoolman page. The dashboard payload
    // is narrowed on purpose, so the record is fetched here rather than carried
    // on every slot of every update.

    // The name both tables print, without any of the markup around it.
    function spoolReadableName(amsSpool) {
        const slot = amsSpool.slot || {};
        const fil = amsSpool.existingSpool?.filament;

        if (amsSpool.slotState === "Empty") {
            // An empty slot the AMS is busy with is a spool going in or out, which
            // reports nothing the backend could tell from a truly empty slot.
            return amsSpool.option === SLOT_OPTIONS.WAITING ? "Reading spool" : "Empty slot";
        }

        const parts = [
            fil?.vendor?.name ?? amsSpool.matchingExternalFilament?.manufacturer,
            fil?.material     ?? slot.tray_type,
            fil?.name         ?? amsSpool.matchingExternalFilament?.name ?? slot.tray_sub_brands,
        ].filter(Boolean);
        return parts.length ? parts.join(" · ") : "Unknown filament";
    }

    // The em dash is this UI's "no value", so an absent field reads the same here
    // as it does in the tables.
    function detailText(value) {
        return value == null || value === "" ? "—" : escapeHtml(value);
    }

    function detailGrams(value) {
        return value == null ? "—" : `${Math.round(value)} g`;
    }

    function detailDate(value) {
        if (!value) return "—";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? escapeHtml(value) : formatDate(date);
    }

    // Spoolman stores an extra field as its JSON representation, so a tag comes
    // back wrapped in quotes and would be shown with them.
    function detailExtra(value) {
        if (value == null || value === "") return "—";
        try {
            return detailText(JSON.parse(value));
        } catch {
            return detailText(value);
        }
    }

    // Which colours a slot is drawn in: the linked Spoolman spool's, and the ones
    // the printer reports for a slot that has no spool behind it.
    //
    // The AMS reports what physically sits in the tray, which is the only source
    // for an unlinked slot. As soon as a spool is linked, the Spoolman record is
    // the one a user keeps, so the swatch follows it and stops disagreeing with
    // the spool page it links to. Where the two differ, the detail dialog names
    // both under "Colour (AMS)" and "Colour (Spoolman)".
    //
    // The direction is never reported by the AMS, so it always comes from
    // whichever filament record was matched.
    function spoolSwatchColors(amsSpool, spool = null) {
        const filament = (spool ?? amsSpool.existingSpool)?.filament || null;
        const spoolmanColors = filamentColors(filament || {});
        const direction = filament?.multi_color_direction ?? amsSpool.matchingExternalFilament?.multi_color_direction ?? null;

        return {
            colors: spoolmanColors.length ? spoolmanColors : slotColors(amsSpool.slot || {}),
            direction,
        };
    }

    // A colour set as the small swatch plus the hex codes behind it. The AMS and
    // Spoolman each report their own, and the two disagreeing is what explains a
    // spool the automatic match will not connect.
    function detailColors(colors, direction) {
        if (!colors.length) return "—";
        return `${swatchHtml(colors, direction)}${colors.map(c => `#${normColor(c)}`).join(" ")}`;
    }

    // Same colours as the inline swatch, drawn large enough to tell two shades of
    // one filament apart, which is what the 12px one in the table cannot do.
    function bigSwatchHtml(colors, direction) {
        const background = colorSetBackground(colors, direction);
        if (!background) return "";
        const title = colors.map(c => `#${normColor(c)}`).join(" ");
        return `<span class="sd-swatch" style="background:${background}" title="${title}"></span>`;
    }

    // A row is `[label, value]`, or `[label, value, field]` for one of the three
    // fields that can be corrected here. The pencil turns that row into an input
    // in place, so the values stay where they are read instead of being repeated
    // in a form of their own further down.
    //
    // It sits in front of the value rather than behind it. Behind it, every row
    // had to reserve its width to keep the values on one right edge, which left
    // a gap along the whole list; in front, it takes the empty space between the
    // label and the value that every row already has.
    function detailRows(rows) {
        return `<div class="sd-grid">${rows
            .filter(Boolean)
            .map(([label, value, field]) => `
                <div class="sd-row"${field ? ` data-field="${field}"` : ""}>
                    <span class="sd-label">${escapeHtml(label)}</span>
                    <span class="sd-value">${field ? editButtonHtml(field, label) : ""}${value}</span>
                </div>`)
            .join("")}</div>`;
    }

    function editButtonHtml(field, label) {
        const what = `Change ${label.toLowerCase()}`;
        return `<button type="button" class="sd-edit" data-field="${field}" title="${escapeHtml(what)}" aria-label="${escapeHtml(what)}">✎</button>`;
    }

    // The link out to Spoolman belongs to whichever tab is open, so it sits in
    // that pane's head rather than in the button row, where it read as a third
    // action next to Close and Save.
    function spoolmanLinkHtml(path, label) {
        return `<a class="sd-link gc-link" href="${spoolmanBase()}${path}" target="_blank" rel="noopener">${escapeHtml(label)} ↗</a>`;
    }

    function spoolmanBase() {
        return (document.getElementById("spoolmanLink")?.href || "").replace(/\/+$/, "");
    }

    // Why a spool cannot be edited right now, or null when it can. Legacy mode
    // closes the whole form, a running print only the remaining weight: both of
    // them write that number afterwards, and neither touches comment or lot
    // number. The backend refuses the same two cases.
    function spoolEditBlockedReason() {
        if (legacyMode) {
            return {
                everything: true,
                reason: "Legacy mode writes the remaining weight from the AMS RFID reading, so a value entered here would be overwritten on the next update. Edit this spool in Spoolman instead.",
            };
        }
        if (ACTIVE_PRINT_STATES.includes(printerGcodeState)) {
            return {
                everything: false,
                reason: `The printer is printing (${printerGcodeState}). The consumption of the running job is booked onto this spool when the job ends, which would overwrite a weight entered now. The other fields can still be changed.`,
            };
        }
        return null;
    }

    async function showSpoolDetailDialog(amsSpool) {
        const dialog  = document.getElementById("spool-detail-dialog");
        const content = document.getElementById("spool-detail-content");
        const close   = document.getElementById("spool-detail-close");

        updateElementText("spool-detail-title", `${amsSpool.amsId} · ${spoolReadableName(amsSpool)}`);
        content.innerHTML = `<p>Loading data from Spoolman…</p>`;
        close.onclick = () => dialog.close();
        dialog.showModal();
        close.focus();

        let spool = null;
        if (amsSpool.existingSpool?.id) {
            try {
                spool = await fetchJson(`./api/spoolman/spool/${amsSpool.existingSpool.id}`);
            } catch (err) {
                content.innerHTML = `<p class="gc-bad">Could not load the spool from Spoolman: ${escapeHtml(err.message)}</p>`;
                return;
            }
        }

        renderSpoolDetail(amsSpool, spool);
    }

    // Rerendered after a save as well, from the record Spoolman answered with
    // rather than from what was sent, so the dialog shows what was really stored.
    function renderSpoolDetail(amsSpool, spool) {
        const content = document.getElementById("spool-detail-content");

        content.innerHTML = `
            <div class="sp-tabs">
                <button type="button" class="sp-tab sp-tab-active" data-tab="spool">Spool</button>
                <button type="button" class="sp-tab" data-tab="filament">Filament</button>
            </div>
            <div id="sd-pane"></div>`;

        const pane = content.querySelector("#sd-pane");
        const tabs = [...content.querySelectorAll(".sp-tab")];

        const selectTab = (tab) => {
            for (const t of tabs) t.classList.toggle("sp-tab-active", t.dataset.tab === tab);
            if (tab === "spool") renderSpoolPane(pane, amsSpool, spool);
            else renderFilamentPane(pane, amsSpool, spool);
        };
        for (const t of tabs) t.addEventListener("click", () => selectTab(t.dataset.tab));

        selectTab("spool");
    }

    function renderSpoolPane(pane, amsSpool, spool) {
        const slot = amsSpool.slot || {};
        const isEmpty = amsSpool.slotState === "Empty";

        // The record the dialog just fetched, where there is one: it is fresher
        // than the copy the table was drawn from.
        const { colors, direction } = spoolSwatchColors(amsSpool, spool);
        const swatch = isEmpty ? "" : bigSwatchHtml(colors, direction);

        const linkState = amsSpool.connectedViaMapping
            ? `<span class="gc-ok">assigned by hand</span>`
            : amsSpool.connectedViaTag
                ? `<span class="gc-ok">linked by RFID tag</span>`
                : `<span class="gc-warn">not linked</span>`;

        const profile = bambuProfile(slot.tray_info_idx);

        // The two sides disagreeing about the material is what a spool assigned to
        // the wrong slot looks like, so it is marked where both are shown.
        const materialsDiffer = spool && !materialsAgree(slotMaterial(slot), spool.filament?.material)
            ? ` <span class="gc-warn" title="Spoolman holds ${escapeHtml(spool.filament?.material ?? "another material")} for the spool linked to this slot">⚠</span>`
            : "";

        const amsRows = detailRows([
            ["AMS slot", detailText(amsSpool.amsId)],
            ["State", detailText(amsSpool.slotState)],
            // The id alone says nothing to read, so the filament Bambu Studio would
            // print it as leads and the id follows it. An id no profile is known
            // for stands on its own.
            ["Tray profile", profile
                ? `${escapeHtml(profile.name)} <span class="gc-muted">(${escapeHtml(slot.tray_info_idx)})</span>`
                : detailText(slot.tray_info_idx)],
            ["Material (AMS)", `${detailText(profile?.material ?? slot.tray_type)}${materialsDiffer}`],
            ["Colour (AMS)", detailColors(slotColors(slot), direction)],
            ["Serialnumber", detailText(slot.tray_uuid)],
            // An empty slot and a spool without a tag both report 0 rather than
            // nothing, and neither of them weighs nothing.
            ["Tray weight", Number(slot.tray_weight) ? detailGrams(slot.tray_weight) : "—"],
            // Without a tag there is nothing to read a percentage from, and the
            // printer reports 0 rather than nothing for such a slot.
            ["RFID remain", slot.tray_uuid == null || slot.remain == null ? "—" : `${slot.remain}%`],
            ["Spoolman link", linkState],
        ]);

        if (!spool) {
            pane.innerHTML = `
                <div class="sd-head">${swatch}<div>
                    <div class="sd-name">${escapeHtml(spoolReadableName(amsSpool))}</div>
                    <div class="gc-muted sd-sub">No Spoolman spool is linked to this slot, so this is what the printer reports about it.</div>
                </div></div>
                <div class="sd-scroll">
                    <div class="sd-section">Printer</div>
                    ${amsRows}
                </div>`;
            return;
        }

        const blocked = spoolEditBlockedReason();
        // A pencil on a field something else is about to write would promise an
        // edit that does not hold, so the reason is shown instead of the pencil.
        const weightField = blocked ? null : "remainingWeight";
        const textField = (field) => (blocked?.everything ? null : field);

        pane.innerHTML = `
            <div class="sd-head">${swatch}<div>
                <div class="sd-name">${escapeHtml(spoolReadableName(amsSpool))}</div>
                <div class="gc-muted sd-sub">Spoolman spool #${spool.id}</div>
                ${spoolmanLinkHtml(`/spool/show/${spool.id}`, "Open this spool in Spoolman")}
            </div></div>
            <div class="sd-scroll">
                <div class="sd-section">Spool</div>
                ${blocked ? `<p class="sd-note gc-warn">${escapeHtml(blocked.reason)}</p>` : ""}
                ${detailRows([
                    ["Remaining", `${detailGrams(spool.remaining_weight)}${spool.remaining_percentage == null ? "" : ` (${Math.round(spool.remaining_percentage)}%)`}`, weightField],
                    ["Used", detailGrams(spool.used_weight)],
                    ["Initial weight", detailGrams(spool.initial_weight)],
                    ["Empty spool", detailGrams(spool.spool_weight)],
                    ["Material (Spoolman)", detailText(spool.filament?.material)],
                    ["Colour (Spoolman)", detailColors(filamentColors(spool.filament || {}), spool.filament?.multi_color_direction)],
                    ["Location", detailText(spool.location)],
                    ["Price", spool.price == null ? "—" : detailText(spool.price)],
                    ["Registered", detailDate(spool.registered)],
                    ["First used", detailDate(spool.first_used)],
                    ["Last used", detailDate(spool.last_used)],
                    ["Archived", spool.archived ? "yes" : "no"],
                    ["Lot number", detailText(spool.lot_nr), textField("lotNr")],
                    ["Comment", detailText(spool.comment), textField("comment")],
                    ["Tag", detailExtra(spool.extra?.tag)],
                ])}

                <div class="sd-section">Printer</div>
                ${amsRows}
            </div>`;

        pane.addEventListener("click", event => {
            const button = event.target.closest(".sd-edit");
            if (button) startFieldEdit(button.closest(".sd-row"), button.dataset.field, amsSpool, spool);
        });
    }

    // What each editable row holds, reads back and refuses. The three entries are
    // the only fields this dialog writes; everything else about a spool is either
    // derived, owned by this service, or belongs to the shared filament record.
    const SPOOL_EDIT_FIELDS = {
        remainingWeight: {
            type: "number",
            unit: "g",
            value: spool => (spool.remaining_weight == null ? "" : String(Math.round(spool.remaining_weight))),
            check: (raw, spool) => {
                const weight = Number(raw);
                if (raw === "" || !Number.isFinite(weight)) return { error: "Enter the grams left on the spool." };
                if (weight < 0) return { error: "A spool cannot hold less than nothing." };

                const limit = spoolWeightLimit(spool);
                if (limit != null && weight > limit) return { error: `This spool holds at most ${Math.round(limit)} g.` };

                return { value: Math.round(weight) };
            },
        },
        lotNr: {
            type: "text",
            value: spool => spool.lot_nr ?? "",
            check: raw => ({ value: raw.trim() }),
        },
        comment: {
            type: "text",
            value: spool => spool.comment ?? "",
            check: raw => ({ value: raw.trim() }),
        },
    };

    // Turns one row into an input in place. The row is rebuilt from the record
    // Spoolman answers with, so what stays on screen is what was really stored.
    function startFieldEdit(row, field, amsSpool, spool) {
        const spec = SPOOL_EDIT_FIELDS[field];
        if (!spec || row.classList.contains("sd-row-editing")) return;

        const value = row.querySelector(".sd-value");
        const before = value.innerHTML;

        row.classList.add("sd-row-editing");
        value.innerHTML = `
            <span class="sd-editing">
                <input class="sd-input" type="${spec.type}" ${spec.type === "number" ? 'min="0" step="1"' : 'autocomplete="off"'}
                    value="${escapeHtml(spec.value(spool))}">
                ${spec.unit ? `<span class="gc-muted">${spec.unit}</span>` : ""}
                <button type="button" class="sd-confirm" title="Save">✓</button>
                <button type="button" class="sd-cancel" title="Cancel">✕</button>
            </span>
            <span class="sd-inline-error gc-bad"></span>`;

        const input = value.querySelector(".sd-input");
        const error = value.querySelector(".sd-inline-error");

        const stop = () => {
            row.classList.remove("sd-row-editing");
            value.innerHTML = before;
        };

        const submit = async () => {
            const checked = spec.check(input.value, spool);
            if (checked.error) {
                error.textContent = checked.error;
                input.focus();
                return;
            }

            error.textContent = "";
            input.disabled = true;
            try {
                await saveSpoolField(field, checked.value, amsSpool, spool);
            } catch (err) {
                error.textContent = err.message;
                input.disabled = false;
                input.focus();
            }
        };

        value.querySelector(".sd-confirm").addEventListener("click", submit);
        value.querySelector(".sd-cancel").addEventListener("click", stop);
        input.addEventListener("keydown", event => {
            if (event.key === "Enter") { event.preventDefault(); submit(); }
            if (event.key === "Escape") { event.preventDefault(); stop(); }
        });

        input.focus();
        input.select();
    }

    async function saveSpoolField(field, value, amsSpool, spool) {
        const updated = await fetchJson(`./api/spoolman/spool/${spool.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [field]: value }),
        });

        showNotification(`Spool #${spool.id} updated.`, "success");
        renderSpoolDetail(amsSpool, updated);

        // The table shows the remaining weight of this spool, so it has to be
        // refetched rather than waiting for the next AMS report.
        if (currentPrinterId) await loadPrinterData(currentPrinterId);
    }

    function renderFilamentPane(pane, amsSpool, spool) {

        const fil = spool?.filament || null;
        const external = amsSpool.matchingExternalFilament;

        if (!fil) {
            pane.innerHTML = external
                ? `
                    <div class="sd-head">${bigSwatchHtml(slotColors(amsSpool.slot || {}), external.multi_color_direction)}<div>
                        <div class="sd-name">${escapeHtml([external.manufacturer, external.material, external.name].filter(Boolean).join(" · "))}</div>
                        <div class="gc-muted sd-sub">From the SpoolmanDB catalogue. No filament of this kind exists in your Spoolman yet.</div>
                    </div></div>
                    <div class="sd-scroll">
                        <div class="sd-section">Catalogue entry</div>
                        ${detailRows([
                            ["Manufacturer", detailText(external.manufacturer)],
                            ["Material", detailText(external.material)],
                            ["Name", detailText(external.name)],
                            ["Density", external.density == null ? "—" : `${external.density} g/cm³`],
                            ["Diameter", external.diameter == null ? "—" : `${external.diameter} mm`],
                            ["External id", detailText(external.id)],
                        ])}
                    </div>`
                : `<p class="gc-muted">No filament is known for this slot. Link a Spoolman spool to it to see one here.</p>`;
            return;
        }

        pane.innerHTML = `
            <div class="sd-head">${bigSwatchHtml(filamentColors(fil), fil.multi_color_direction)}<div>
                <div class="sd-name">${escapeHtml([fil.vendor?.name, fil.material, fil.name].filter(Boolean).join(" · ") || "Unknown filament")}</div>
                <div class="gc-muted sd-sub">Spoolman filament #${fil.id}. Shared by every spool of this kind, so it is edited in Spoolman itself.</div>
                ${spoolmanLinkHtml(`/filament/show/${fil.id}`, "Open this filament in Spoolman")}
            </div></div>
            <div class="sd-scroll">
                <div class="sd-section">Filament</div>
                ${detailRows([
                    ["Manufacturer", detailText(fil.vendor?.name)],
                    ["Material", detailText(fil.material)],
                    ["Name", detailText(fil.name)],
                    ["Colour", detailText((filamentColors(fil).map(c => `#${normColor(c)}`).join(" ")) || null)],
                    ["Multi colour", detailText(fil.multi_color_direction)],
                    ["Density", fil.density == null ? "—" : `${fil.density} g/cm³`],
                    ["Diameter", fil.diameter == null ? "—" : `${fil.diameter} mm`],
                    ["Full weight", detailGrams(fil.weight)],
                    ["Empty spool", detailGrams(fil.spool_weight)],
                    ["Nozzle temp", fil.settings_extruder_temp == null ? "—" : `${fil.settings_extruder_temp} °C`],
                    ["Bed temp", fil.settings_bed_temp == null ? "—" : `${fil.settings_bed_temp} °C`],
                    ["External id", detailText(fil.external_id)],
                    ["Comment", detailText(fil.comment)],
                ])}
            </div>`;
    }

    // Combined "Spool" identity cell shared by both the G-code dashboard and the
    // (legacy) classic table: color swatch + readable filament name
    // (vendor · material · name) with an optional ambiguity warning, then a muted
    // second line with the AMS slot id, tray index, Spoolman link and the
    // tag/booking status. Pass `ctx` with a `keyCount` map to enable the
    // duplicate-spool ⚠ marker (only meaningful when all slots are known).
    function spoolIdentityHtml(amsSpool, ctx = null) {
        const slot = amsSpool.slot || {};
        const isEmpty = amsSpool.slotState === "Empty";

        const readable = spoolReadableName(amsSpool);

        // A linked spool is drawn in its Spoolman colours, an unlinked slot in the
        // ones the printer reports for it. See spoolSwatchColors().
        const { colors, direction } = spoolSwatchColors(amsSpool);
        const color = isEmpty ? "" : swatchHtml(colors, direction);

        // A spool without an RFID tag: the AMS reports the generic profile and no
        // serial, so nothing but this label separates it from a Bambu spool the
        // printer simply has not read yet. Both views show it, the classic table
        // only had the ⚠ in its State column, which names no reason.
        const thirdParty = amsSpool.slotState === "Loaded (3rd party)"
            ? ` · <span class="gc-warn" title="${THIRD_PARTY_HINT}">3rd party</span>`
            : "";

        const spoolman = amsSpool.existingSpool?.id
            ? `<a class="gc-link" href="${spoolmanBase()}/spool/show/${amsSpool.existingSpool.id}" target="_blank">Spoolman #${amsSpool.existingSpool.id}</a>`
            : `<span class="gc-muted">not linked</span>`;

        // Tag/booking status is G-code-consumption semantics, so only shown there.
        let booking = "";
        if (!isEmpty && ctx?.showBooking) {
            if (amsSpool.connectedViaMapping) {
                booking = ` · <span class="gc-ok" title="Manually assigned to a Spoolman spool, consumption is booked onto it">● assigned</span>`;
            } else if (amsSpool.connectedViaTag) {
                booking = ` · <span class="gc-ok" title="Physically connected via Spoolman extra.tag, consumption is booked automatically">● tag-linked</span>`;
            } else {
                booking = ` · <span class="gc-warn" title="No extra.tag link, consumption cannot be booked automatically; assign a Spoolman spool to track it">● not tracked</span>`;
            }
        }

        // A manual assignment resolves the ambiguity for this slot, so the warning
        // only applies while the slot still relies on the automatic match.
        const ambiguous = (!isEmpty && !amsSpool.connectedViaMapping && ctx?.keyCount && ctx.keyCount[amsSpool.key] > 1)
            ? ` <span class="gc-warn" title="Another loaded spool is identical in profile and colour. Consumption is still split correctly whenever the sliced file names the slot each filament was meant for. Where it does not, the whole amount goes to one of them; assign one to choose which.">⚠</span>`
            : "";

        // The name opens the detail dialog. A button rather than a styled span, so
        // it is reachable by keyboard and announced as the control it is.
        const name = `<button type="button" class="spool-name-link" data-amsid="${escapeHtml(amsSpool.amsId)}"
            title="Show everything about this slot">${escapeHtml(readable)}</button>`;

        return `
            ${color}${name}${ambiguous}<br>
            <span style="font-size:0.82em">
                <span class="gc-muted">${amsSpool.amsId} · <code>${isEmpty ? "—" : (slot.tray_info_idx ?? "—")}</code></span>${thirdParty} · ${spoolman}${booking}
            </span>`;
    }

    function createSpoolRow(amsSpool, ctx = null) {
        const tr = document.createElement("tr");
        tr.setAttribute("data-amsid", amsSpool.amsId);
        renderedSpools.set(amsSpool.amsId, amsSpool);
    
        let amsSpoolRemainingWeight = amsSpool.correctedWeight ?? (amsSpool.slot.remain == null
            ? null
            : (amsSpool.slot.tray_weight / 100) * amsSpool.slot.remain);
        let correctedRemain = amsSpool.correctedRemain ?? amsSpool.slot.remain;
        let totalWeight = amsSpool.slot.tray_weight;

        // In G-code mode the AMS RFID remain % is not tracked, so show the actual
        // Spoolman remaining weight/percentage of the tag-connected spool instead.
        const sp = amsSpool.existingSpool;
        if (!legacyMode && (amsSpool.connectedViaTag || amsSpool.connectedViaMapping) && sp && sp.remaining_weight != null) {
            const full = sp.filament?.weight;
            amsSpoolRemainingWeight = Math.round(sp.remaining_weight);
            if (sp.remaining_percentage != null) {
                correctedRemain = Math.round(sp.remaining_percentage);
            } else if (full) {
                correctedRemain = Math.round((sp.remaining_weight / full) * 100);
            }
            if (full) totalWeight = Math.round(full);
        }

        const button = createActionButton(amsSpool);

        tr.innerHTML = `
            <td data-label="Spool" style="text-align:left">${spoolIdentityHtml(amsSpool, ctx)}</td>
            <td data-label="Remaining">${amsSpoolRemainingWeight == null ? "—" : `${amsSpoolRemainingWeight} g`} / ${totalWeight} g (${correctedRemain == null ? "—" : `${correctedRemain}%`})</td>
            <td data-label="Serialnumber">${amsSpool.slot.tray_uuid ?? "—"}</td>
            <td data-label="State">${setIcon(amsSpool.error, amsSpool.slotState)}</td>
        `;
        const tdBtn = document.createElement("td");
        tdBtn.setAttribute("data-label", "Action");
        tdBtn.appendChild(button);
        tr.appendChild(tdBtn);
    
        return tr;
    }
    
    function upsertSpoolRow(amsSpool) {
        const selector = `[data-amsid="${amsSpool.amsId}"]`;
        const existingRow = document.querySelector(selector);
        const newRow = createSpoolRow(amsSpool, lastLegacyCtx);
    
        if (existingRow && existingRow.parentElement) {
            existingRow.parentElement.replaceChild(newRow, existingRow);
        } else {
            const tables = document.querySelectorAll('.spool-table tbody');
            const targetTbody = tables[tables.length - 1] || null;
            if (targetTbody) {
                targetTbody.appendChild(newRow);
                if (typeof synchronizeSelectedColumns === 'function') {
                    try { synchronizeSelectedColumns(SYNCED_COLUMNS); } catch (e) {}
                }
            } else {
                if (currentPrinterId) loadPrinterData(currentPrinterId);
            }
        }
    }
    
    // =======================================================================
    // G-code mode main view
    //
    // Replaces the classic AMS table with a print-centric dashboard: live print
    // state + each loaded spool joined with its consumption requirement (on spool
    // / needed / rest) and the same action button as the classic table. Driven by
    // /api/spools (full spool objects, for the buttons) + /api/print (print
    // state and per-filament consumption). Refreshed on SSE events.
    // =======================================================================

    let gcodeRefreshTimer = null;

    // Coalesce bursts of SSE events into at most one dashboard refresh per second.
    // Skip while an action dialog is open so the table doesn't change mid-action.
    function scheduleGcodeRefresh() {
        if (gcodeRefreshTimer) return;
        gcodeRefreshTimer = setTimeout(() => {
            gcodeRefreshTimer = null;
            if (currentPrinterId && !legacyMode && !isDialogOpen()) loadGcodeView(currentPrinterId);
        }, 1000);
    }

    // Slots that stand alone rather than filling a four slot AMS unit. The
    // external spool holder reports one spool and gets a table of its own, like
    // an AMS HT unit, because it belongs to no four slot unit and would
    // otherwise break their grouping.
    function isSingleSlotUnit(amsId) {
        return amsId === EXTERNAL_SLOT || amsId.startsWith("HT-");
    }

    function gcodeStateBadge(state) {
        const variants = {
            RUNNING: "gc-state-running", FINISH: "gc-state-done",
            FAILED:  "gc-state-error",   CANCEL: "gc-state-error",
            PAUSE:   "gc-state-paused",
        };
        return `<span class="gc-state ${variants[state] || ""}">${state || "—"}</span>`;
    }

    async function loadGcodeView(printerId) {
        const el = getElementSafe("spool-list");
        if (!el) return;
        try {
            const [spoolsRes, printRes] = await Promise.all([
                fetch(`./api/spools/${printerId}`),
                fetch(`./api/print/${printerId}`),
            ]);
            if (!spoolsRes.ok || !printRes.ok) {
                const failed = !spoolsRes.ok ? spoolsRes : printRes;
                const body = await failed.json().catch(() => ({}));
                throw new Error(body.error || `HTTP ${failed.status}`);
            }

            const spools = await spoolsRes.json();
            const printData = await printRes.json();
            printerGcodeState = printData.gcodeState || "IDLE";

            el.innerHTML = "";
            el.appendChild(buildGcodeCard(printData));

            for (const table of buildGcodeSpoolTables(spools, printData)) {
                el.appendChild(table);
            }

            // Every column to its widest cell, so AMS A / AMS B / … line up.
            synchronizeSelectedColumns(SYNCED_COLUMNS);

            const missing = buildGcodeMissing(printData);
            if (missing) el.appendChild(missing);
        } catch (err) {
            el.innerHTML = `<p class="gc-required">Request failed: ${err.message}</p>`;
        }
    }

    function buildGcodeCard(printData) {
        const active = ACTIVE_PRINT_STATES.includes(printData.gcodeState);
        const humanLayer  = (printData.layerNum ?? 0) + 1;
        const humanTotal  = printData.totalLayers != null ? printData.totalLayers + 1 : null;
        const progressPct = humanTotal ? Math.round((humanLayer / humanTotal) * 100) : null;

        const card = document.createElement("div");
        card.className = "gc-card";

        let html = `<div class="gc-card-head">
            ${gcodeStateBadge(printData.gcodeState)}
            <strong>${printData.jobName ? printData.jobName : "No active print"}</strong>
            <span class="gc-card-note">${printData.consumptionBooked ? "✔ consumption booked" : ""}</span>
        </div>`;
        if (active && humanTotal) {
            html += `<div class="gc-progress">
                <div class="gc-progress-labels">
                    <span>Layer ${humanLayer} / ${humanTotal}</span><span>${progressPct}%</span>
                </div>
                <div class="gc-progress-track">
                    <div class="gc-progress-bar" style="width:${progressPct}%"></div>
                </div>
            </div>`;
        }
        // The backend reports why consumption data is missing (e.g. the FTPS
        // download failed); without this the table would just show a placeholder with no
        // explanation.
        if (printData.error) {
            html += `<p class="gc-required" style="margin:10px 0 0">${printData.error}</p>`;
        }
        card.innerHTML = html;
        return card;
    }

    // Build one table per AMS unit, like the classic view: normal AMS up to 4
    // slots per table, AMS HT a single slot per table. The generic `table`
    // margin gives a clear gap between units.
    function buildGcodeSpoolTables(spools, printData) {
        const fullCons = printData.fullConsumption || {};
        const partCons = printData.consumption || {};

        const ctx = { fullCons, partCons, keyCount: countSpoolKeys(spools), showBooking: true };

        const columns = [
            ["Spool", "left"],
            ["On spool / total", "right"],
            ["Needed", "right"],
            ["After print", "right"],
            ["Action"],
        ];

        return buildSpoolTables(spools, columns, spool => createGcodeSpoolRow(spool, ctx), "No spools loaded");
    }

    // The grams a slot carries in a consumption map.
    //
    // The server decides which sliced filament belongs to which slot, in
    // matchConsumption() (src/ams.js), the same function the booking uses, and
    // names the slot on every entry as `matchedAmsId`. This used to be a second
    // implementation of that decision, and both defects fixed at the end of
    // PR #89 sat in it.
    //
    // Summed rather than picked: one slot can serve two filaments of a print,
    // and the booking writes both of their amounts onto its spool.
    function consumedGrams(cons, amsId) {
        return Object.values(cons)
            .filter(e => e.matchedAmsId && e.matchedAmsId === amsId)
            .reduce((total, e) => total + (e.grams || 0), 0);
    }

    function createGcodeSpoolRow(amsSpool, ctx) {
        const { fullCons, partCons, keyCount } = ctx;
        const tr = document.createElement("tr");
        tr.setAttribute("data-amsid", amsSpool.amsId);
        renderedSpools.set(amsSpool.amsId, amsSpool);

        const slot   = amsSpool.slot || {};
        const isEmpty = amsSpool.slotState === "Empty";
        const needed = isEmpty ? 0 : consumedGrams(fullCons, amsSpool.amsId);
        const used   = isEmpty ? 0 : consumedGrams(partCons, amsSpool.amsId);

        // On spool: Spoolman remaining/initial weight whenever we know which spool
        // this is (tag link or manual assignment), else the AMS-reported
        // remaining/total weight (g/g, like the legacy MQTT table but without the
        // percentage).
        const sp = amsSpool.existingSpool;
        let onSpool = amsSpool.correctedWeight ?? null;
        // tray_weight arrives from MQTT as a string, so a weightless 3rd party
        // spool reports "0", which is truthy. Left as-is it passed the guard
        // below, divided by zero in the remain% fallback and rendered "NaNg".
        let totalSpool = Number(slot.tray_weight) || null;
        if ((amsSpool.connectedViaTag || amsSpool.connectedViaMapping) && sp && sp.remaining_weight != null) {
            onSpool = Math.round(sp.remaining_weight);
            if (sp.initial_weight != null) totalSpool = Math.round(sp.initial_weight);
        } else if (onSpool == null && !isEmpty && slot.remain != null && totalSpool) {
            // Fallback if correctedWeight wasn't provided by the backend: derive
            // it client-side from the AMS remain%, same as the legacy table does.
            const pct = correctRemainInt(slot.remain, totalSpool, slot.tray_type);
            onSpool = Math.round((pct / 100) * totalSpool);
        }

        let neededCell     = "—";
        let afterPrintCell = "—";
        if (needed > 0) {
            neededCell = `${needed}g${used ? `<br><span class="gc-muted" style="font-size:0.8em">printed: ${used}g</span>` : ""}`;
            if (onSpool != null) {
                const afterPrint = Math.round((onSpool - needed) * 100) / 100;
                afterPrintCell = `<span class="${afterPrint < 0 ? "gc-bad" : "gc-ok"}">${afterPrint}g</span>`;
            }
        }

        // 3rd-party spools report tray_weight 0, so only show the total when the
        // AMS or Spoolman actually knows it.
        const onSpoolCell = onSpool != null && !isEmpty
            ? `${onSpool}g${totalSpool ? ` / ${totalSpool}g` : ""}`
            : "—";

        tr.innerHTML = `
            <td data-label="Spool" style="text-align:left">${spoolIdentityHtml(amsSpool, ctx)}</td>
            <td data-label="On spool / total" style="text-align:right">${onSpoolCell}</td>
            <td data-label="Needed" style="text-align:right">${neededCell}</td>
            <td data-label="After print" style="text-align:right">${afterPrintCell}</td>
        `;

        const tdBtn = document.createElement("td");
        tdBtn.setAttribute("data-label", "Action");
        tdBtn.appendChild(createActionButton(amsSpool));
        tr.appendChild(tdBtn);

        return tr;
    }

    function buildGcodeMissing(printData) {
        const fullCons = printData.fullConsumption || {};

        // An entry the server could place on a loaded slot is by definition not
        // missing. It matched the slots over every loaded one, not only the
        // bookable ones, which is exactly the question this list asks.
        const missing = Object.values(fullCons).filter(e => !e.matchedAmsId);
        if (!missing.length) return null;

        const wrap = document.createElement("div");
        let html = `<h4 class="gc-required" style="margin:16px 0 4px">Required but not loaded</h4>`;
        html += `<table class="data-table gc-required-table">`;
        for (const e of missing) {
            // The sliced file names one colour per filament, so there is never a
            // set to draw here, unlike on a slot.
            const swatch = swatchHtml(e.color ? [normColor(e.color)] : []);
            const label = e.type ? `${e.type} <code>${e.tray_info_idx}</code>` : `<code>${e.tray_info_idx}</code>`;
            html += `<tr><td>${swatch}${label}</td>
                <td class="gc-required-amount">${e.grams}g needed</td></tr>`;
        }
        html += `</table>`;
        wrap.innerHTML = html;
        return wrap;
    }

    // The options this button knows how to label. Anything else, including an
    // option a newer server has learned, reads as no action rather than putting
    // a word on a button that does nothing. SLOT_OPTIONS.WAITING is in the list
    // and is not an action: the AMS has not reported the remaining percentage
    // yet, and creating a spool without it would store a partly used one as
    // brand new. The server offers the real action as soon as the reading
    // arrives, or after five updates without one.
    const KNOWN_OPTIONS = new Set([
        SLOT_OPTIONS.MERGE,
        SLOT_OPTIONS.CREATE,
        SLOT_OPTIONS.CREATE_WITH_FILAMENT,
        SLOT_OPTIONS.ASSIGN,
        SLOT_OPTIONS.UNASSIGN,
        SLOT_OPTIONS.SHOW_INFO,
        SLOT_OPTIONS.WAITING,
    ]);

    function setupButton(button, amsSpool) {
        if (amsSpool.error && amsSpool.slotState === "Loaded (Bambu Lab)") {
            button.textContent = SLOT_OPTIONS.SHOW_INFO;
            button.disabled = false;
            return;
        }

        button.textContent = KNOWN_OPTIONS.has(amsSpool.option) ? amsSpool.option : SLOT_OPTIONS.NONE;
        button.disabled = amsSpool.enableButton !== "true" || !spoolmanConnected;
        if (amsSpool.option === SLOT_OPTIONS.WAITING) {
            button.title = "The AMS has not reported how much filament is left yet. Creating the spool now would store it as brand new.";
        }
    }

    // What the printer reports about the slot the action is about. The same row
    // opens all three confirmations, which used to spell it out once each.
    function amsSpoolRow(amsSpool) {
        return `<tr>
                        <th>AMS Spool:</th>
                        <td>${amsSpool.slot.tray_sub_brands} - ${amsSpool.matchingExternalFilament.name} - ${amsSpool.slot.tray_uuid}</td>
                    </tr>`;
    }

    // Generate the content of the confirmation dialog
    function generateDialogContent(button, amsSpool) {
        if (button.textContent === SLOT_OPTIONS.CREATE) {
            return `
                <p>Do you really want to create a Spool with the following stats in Spoolman?</p>
                <table class="data-table">
                    ${amsSpoolRow(amsSpool)}
                    <tr>
                        <th>Spoolman Filament:</th>
                        <td>Bambu Lab - ${amsSpool.matchingInternalFilament.material} - ${amsSpool.matchingInternalFilament.name}</td>
                    </tr>
                </table>
            `;
        } else if (button.textContent === SLOT_OPTIONS.MERGE) {
            const remain = amsSpool.slot.remain == null
                ? null
                : (amsSpool.slot.remain / 100) * amsSpool.slot.tray_weight;

            return `
                <p>Do you really want to merge this Spool with an existing Spool in Spoolman?</p>
                <table class="data-table">
                    ${amsSpoolRow(amsSpool)}
                    <tr>
                        <th>Spoolman Spool:</th>
                        <td>Spool-ID ${amsSpool.mergeableSpool.id} - Bambu Lab - ${amsSpool.mergeableSpool.filament.material} - ${amsSpool.mergeableSpool.filament.name} - ${remain == null ? "unknown" : `${remain} g`} left on spool</td>
                    </tr>
                </table>
            `;
        } else if (button.textContent === SLOT_OPTIONS.CREATE_WITH_FILAMENT) {
            return `
                <p>Do you really want to create a Spool and a new Filament with the following stats in Spoolman?</p>
                <table class="data-table">
                    ${amsSpoolRow(amsSpool)}
                    <tr>
                        <th>New Spool & Filament:</th>
                        <td>${amsSpool.matchingExternalFilament.manufacturer} - ${amsSpool.matchingExternalFilament.material} - ${amsSpool.matchingExternalFilament.name} - ${amsSpool.matchingExternalFilament.density} g/cm³ - ${amsSpool.matchingExternalFilament.diameter} mm</td>
                    </tr>
                </table>
            `;
        } else {
            return `
                <p>No machting Filament found in Database, please check manually!</p>
                <p>This error shows up when the official data from BambuLab does not matches with the collected data from the spool!</p>
                <p>To solve this issue, please follow this guide:</p>
                <p>&emsp;1. Click on "Go to Spoolman". This will open Spoolman in the Spool creation menu.</p>
                <p>&emsp;2. Type in the Name of your BambuLab Filament and select it, the necessary data will be filled in automatically.</p>
                <p>&emsp;3. If you wish, you can enter any optional data you need (e.g., first used, price, location…)</p>
                <p>&emsp;4. Copy the serial into the Extra Field 'tag' and click save</p>
                <p>&emsp;5. Wait until the new data is collected. After this, the spool will be displayed correctly!</p>
            `;
        }
    }

    // Show a confirmation dialog
    function showDialog(button, content, actionButtonText, actionCallback) {
        const dialog = document.getElementById("info-dialog");
        const dialogContent = document.getElementById("dialog-content");
        const closeDialog = document.getElementById("close-dialog");
        const actionButton = document.getElementById("action-button");

        dialogContent.innerHTML = content;
        updateElementText("action-button", actionButtonText);
        // The dialog is shared, and whatever ran in it last may have left the
        // button disabled: the create form disables it while it saves and then
        // closes the dialog, which is what made the next Unassign do nothing
        // until the page was reloaded.
        actionButton.disabled = false;

        if (actionButton.textContent === "Go to Spoolman") {
            actionButton.onclick = () => {
                actionCallback();
                dialog.close();
                
                const spoolmanLink = document.getElementById("spoolmanLink");
                let linkUrl = spoolmanLink.href;
                linkUrl += "spool/create";
                window.open(linkUrl, "_blank");
            };
        } else {
            actionButton.onclick = () => {
                actionCallback();
                dialog.close();
            };
        }
        
        closeDialog.onclick = () => dialog.close();
        dialog.showModal();
        // The harmless choice takes the focus, not the one that writes to Spoolman
        closeDialog.focus();
    }

    // Send the selected action to the backend
    async function performAction(button, amsSpool) {
        const endpointMap = {
            [SLOT_OPTIONS.CREATE]: "./api/createSpool",
            [SLOT_OPTIONS.MERGE]: "./api/mergeSpool",
            [SLOT_OPTIONS.CREATE_WITH_FILAMENT]: "./api/createSpoolWithFilament"
        };

        const endpoint = endpointMap[button.textContent];
        if (!endpoint) return;

        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = "Sending...";

        try {
            const res = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ printerId: currentPrinterId, amsId: amsSpool.amsId })
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                showNotification(`Error: ${err.error || "Action failed"}`, "error");
                button.textContent = originalText;
                button.disabled = false;
                return;
            }

            button.textContent = SLOT_OPTIONS.NONE;
            showNotification("Action sent successfully. UI updates after next MQTT event.", "success");
        } catch (err) {
            console.error("Action failed:", err);
            showNotification("Request failed. Please check your connection.", "error");
            button.textContent = originalText;
            button.disabled = false;
        }
    }

    function showNotification(message, type = "success") {
        let note = document.getElementById("action-notification");
        if (!note) {
            note = document.createElement("div");
            note.id = "action-notification";
            note.style.cssText = "position:fixed;bottom:1.5rem;right:1.5rem;padding:0.75rem 1.25rem;border-radius:6px;font-size:0.9rem;z-index:9999;transition:opacity 0.4s";
            document.body.appendChild(note);
        }
        note.textContent = message;
        note.style.background = type === "error" ? "#c0392b" : "#27ae60";
        note.style.color = "#fff";
        note.style.opacity = "1";
        clearTimeout(note._timeout);
        note._timeout = setTimeout(() => { note.style.opacity = "0"; }, 3500);
    }

    // Update various status elements in the UI
    function updateStatus(data) {
                
        data.lastMqttUpdate = data.lastMqttUpdate
            ? formatDate(new Date(data.lastMqttUpdate))
            : "No update yet";

        data.lastMqttAmsUpdate = data.lastMqttAmsUpdate
            ? formatDate(new Date(data.lastMqttAmsUpdate))
            : "No update yet";
        
        if (typeof data.LEGACY_MODE === "boolean") legacyMode = data.LEGACY_MODE;
        printerGcodeState = data.gcodeState || "IDLE";

        // Active tracking mode badge
        const modeEl = getElementSafe("tracking-mode");
        if (modeEl) {
            if (legacyMode) {
                modeEl.className = "pill pill-legacy";
                modeEl.textContent = "Legacy · MQTT remain";
                modeEl.title = "Spool weight is tracked from the AMS RFID remain % via MQTT";
            } else {
                modeEl.className = "pill pill-gcode";
                modeEl.textContent = "G-code tracking";
                modeEl.title = "Spool weight is tracked from the sliced G-code consumption";
            }
        }

        spoolmanConnected = data.spoolmanStatus === "Connected";

        updateStatusWithIcon("spoolman-status", data.spoolmanStatus);
        updateStatusWithIcon("mqtt-status", data.mqttStatus);
        updateElementText("last-mqtt-update", data.lastMqttUpdate);
        updateElementText("last-mqtt-ams-update", data.lastMqttAmsUpdate);
        currentPrinterName = data.printerName || "";
        updateElementText("printer-name", data.printerName);
        updateElementText("mode", data.MODE);
        updateElementText("printer-serial", data.PRINTER_ID);
        
        const footer = document.getElementById("dynamic-footer");

        if (footer) {
            const URL = data.SPOOLMAN_FQDN || data.SPOOLMAN_URL;
            footer.innerHTML = `
                <div class="container">
                    <div class="content">
                        2026 - v.${data.VERSION} | 
                        <a href="https://github.com/Rdiger-36/bambulab-ams-spoolman-filamentstatus" target="_blank">GitHub Repository</a> - 
                        Created by 
                        <a href="https://github.com/Rdiger-36" target="_blank">Rdiger-36</a> |
                        <a id="spoolmanLink" href="${URL}" target="_blank">Link to Spoolman</a>
                    </div>
                </div>
            `;
        }
    }
    
    // Set status icon for element
    function updateStatusWithIcon(elementId, status) {
        const el = getElementSafe(elementId);
        if (!el) return;
        const ok = status === "Connected";
        el.innerHTML = `<span class="pill ${ok ? "pill-ok" : "pill-bad"}">● ${status}</span>`;
    }
    
    // Set status icon for spool behavior
    function setIcon(status, slotState) {
        if (slotState === "Loaded (Bambu Lab)") return status ? "❗️" : "✅";
        // Everything else is a warning triangle, so it carries the reason as a
        // tooltip: an untagged 3rd party spool is a normal state, not a fault.
        const title = slotState === "Loaded (3rd party)"
            ? THIRD_PARTY_HINT
            : "No spool data from the AMS for this slot.";
        return `<span title="${title}">⚠️</span>`;
    }

    // Safely get an element by ID and log a warning if it doesn't exist
    function getElementSafe(id) {
        const element = document.getElementById(id);
        if (!element) {
            console.warn(`Element with ID "${id}" was not found.`);
        }
        return element;
    }

    // Update the text content of a specific element
    function updateElementText(id, text) {
        const element = getElementSafe(id);
        if (element) element.textContent = text;
    }

});

let currentPrinterId = null;


async function toggleMonitoring() {
    if (!currentPrinterId) return;

    const toggle = document.getElementById("monitoring-toggle");
    const enable = toggle.checked;

    const action = enable ? "start" : "stop";

    await fetch(`./api/printer/${currentPrinterId}/monitoring/${action}`, {
        method: "POST"
    });
}
