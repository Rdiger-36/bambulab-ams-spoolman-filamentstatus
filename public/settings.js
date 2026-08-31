// Settings page. Renders the fields the backend describes in /api/settings, so
// a new setting only has to be added to the schema in src/settings.js, and
// manages the printer list through /api/printers.

// Order and headline of the field groups. The group key comes from the schema,
// the fields the schema marks as advanced go into the collapsed part.
const GROUPS = [
    { key: "spoolman", title: "Spoolman connection", advancedLabel: "Host, port, subfolder and public URL" },
    { key: "tracking", title: "Tracking" },
    { key: "sync",     title: "Synchronisation" },
    { key: "printer",  title: "Printer connection" },
    { key: "logging",  title: "Logging" },
];

let fields = [];
let values = {};
let sources = {};
let spoolmanUrl = "";
// Revision of the settings this page last read, sent back with a save so a
// state somebody else replaced is not overwritten
let revision = 0;
// True while a saved value waits for the next start of the service
let restartPending = false;
// True when a supervisor starts the service again by itself, so the page can
// say what will happen instead of listing conditions
let supervised = false;
let printers = [];
// Set once an input was touched. Blocks the save button while nothing changed,
// keeps a settings update pushed over SSE from overwriting what is being typed,
// and drives the warning when leaving the page.
let formDirty = false;

document.addEventListener("DOMContentLoaded", () => {
    // Menu bar, including the dark mode button
    initMenubar();

    document.getElementById("settings-form").addEventListener("submit", saveSettings);
    document.getElementById("reload-settings").addEventListener("click", () => loadSettings(true));
    document.getElementById("add-printer").addEventListener("click", () => openPrinterDialog(null));
    document.getElementById("restart-service").addEventListener("click", confirmRestart);
    document.getElementById("printer-dialog-cancel").addEventListener("click", () => closeDialog("printer-dialog"));
    document.getElementById("printer-dialog-test").addEventListener("click", testPrinterConnection);

    window.addEventListener("beforeunload", event => {
        if (!formDirty) return;
        event.preventDefault();
        event.returnValue = "";
    });

    loadSettings();
    loadPrinters();

    const eventSource = new EventSource("./api/events");
    eventSource.onmessage = event => {
        const data = JSON.parse(event.data);
        if (data.type === "printers_update") {
            loadPrinters();
            // A renamed or removed printer changes the menu as well
            refreshMenubarPrinters();
        }
        if (data.type === "settings_update" && !formDirty) loadSettings();
    };
});

/* ---- HTTP helpers ---- */

async function fetchJson(url, options) {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
        const error = new Error(body.error || `HTTP ${res.status}`);
        error.conflict = !!body.conflict;
        error.printInFlight = !!body.printInFlight;
        throw error;
    }

    return body;
}

function sendJson(url, method, payload) {
    return fetchJson(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---- Banner and dirty state ---- */

function showBanner(message, kind = "ok") {
    const banner = document.getElementById("set-banner");
    banner.className = `set-banner set-banner-${kind}`;
    banner.textContent = message;
}

function clearBanner() {
    const banner = document.getElementById("set-banner");
    banner.className = "set-banner";
    banner.textContent = "";
}

/** Keeps the action buttons in sync with whether anything was edited. */
function setDirty(dirty) {
    formDirty = dirty;
    document.getElementById("save-settings").disabled = !dirty;
    document.getElementById("reload-settings").disabled = !dirty;
    document.getElementById("dirty-hint").textContent = dirty ? "Unsaved changes" : "";
}

/* ---- Settings form ---- */

async function loadSettings(userRequested = false) {
    try {
        applyView(await fetchJson("./api/settings"));
        if (userRequested) clearBanner();
        showRestartNotice();
    } catch (err) {
        showBanner(`Could not load the settings: ${err.message}`, "bad");
    }
}

/** Takes over a settings response and rebuilds the form from it. */
function applyView(view) {
    fields = view.fields;
    values = view.values;
    sources = view.sources;
    spoolmanUrl = view.spoolmanUrl;
    restartPending = view.restartPending;
    revision = view.revision;
    supervised = view.supervised;
    renderRestartNote();
    renderSettings();
    setDirty(false);
}

/**
 * A stored value that only takes effect on the next start keeps its notice on
 * the page, rather than showing it once after the save and losing it on the
 * next reload.
 */
function showRestartNotice() {
    if (!restartPending) return;

    // With the supervisor the button next to this does the whole job, so naming
    // the manual way would only send the user off to a terminal for nothing.
    showBanner(supervised
        ? "Legacy mode was changed. Restart the service to apply it."
        : "Legacy mode was changed. Restart the service to apply it: restart the container "
          + "(docker restart <container>) or the Home Assistant add-on.", "warn");
    // Straight from the notice, rather than sending the user looking for the
    // button further down the page.
    const action = document.createElement("button");
    action.className = "btn btn-small";
    action.type = "button";
    action.textContent = "Restart now";
    action.addEventListener("click", confirmRestart);
    document.getElementById("set-banner").append(" ", action);
}

/* ---- Restarting the service ---- */

/** The service card says what a restart will actually do on this installation. */
function renderRestartNote() {
    const note = document.getElementById("restart-note");
    if (!note) return;

    note.textContent = supervised
        ? "Ends the service and starts it again. This takes a few seconds, the page waits for it and reloads itself."
        : "Ends the process so that Docker or the Home Assistant supervisor starts it again. This only works when the container is set to restart, for example with restart: unless-stopped. Without that the service stays down and has to be started by hand.";
}

async function confirmRestart() {
    const warning = supervised
        ? `<p class="set-note">A running print keeps printing, but the consumption of that job is not booked.</p>`
        : `<p class="set-note">When the container is not set to restart, for example with
              <code>restart: unless-stopped</code>, it stays down and has to be started by hand.
              A running print keeps printing, but the consumption of that job is not booked.</p>`;

    const confirmed = await confirmAction({
        title: "Restart the service?",
        html: `<p>${supervised
            ? "The service ends and is started again right away."
            : "The process ends and has to be started again by Docker or the Home Assistant supervisor."}</p>${warning}`,
        okLabel: "Restart",
    });

    if (confirmed) restartNow(false);
}

async function restartNow(force) {
    try {
        await sendJson("./api/restart", "POST", { force });
        showBanner("Restarting, waiting for the service to come back...", "warn");
        waitForService();
    } catch (err) {
        if (err.printInFlight) {
            await confirmWhilePrinting(err, () => restartNow(true));
            return;
        }
        showBanner(`Could not restart: ${err.message}`, "bad");
    }
}

/**
 * Polls until the service answers again and reloads the page.
 *
 * A service that does not come back is the whole risk of the restart button, so
 * the wait ends with a message that says what to look at rather than spinning
 * forever.
 */
function waitForService(deadline = Date.now() + 60000) {
    setTimeout(async () => {
        try {
            const response = await fetch("./api/printers", { cache: "no-store" });
            if (response.ok) return window.location.reload();
        } catch {
            // still down, keep waiting
        }

        if (Date.now() < deadline) return waitForService(deadline);
        showBanner("The service has not come back. Check whether the container is set to restart.", "bad");
    }, 1500);
}

function renderSettings() {
    const container = document.getElementById("settings-groups");
    container.innerHTML = "";

    for (const group of GROUPS) {
        const groupFields = fields.filter(field => field.group === group.key);
        if (!groupFields.length) continue;

        const header = groupFields.filter(field => field.header);
        const main = groupFields.filter(field => !field.advanced && !field.header);
        const advanced = groupFields.filter(field => field.advanced && !field.header);

        const card = document.createElement("div");
        card.className = "set-card";
        card.innerHTML = `
            <div class="set-card-head">
                <h2>${escapeHtml(group.title)}</h2>
                ${header.map(renderHeaderField).join("")}
            </div>
            <div class="set-form">${main.map(renderField).join("")}</div>
            ${group.key === "spoolman" ? renderEffectiveUrl() : ""}
            ${advanced.length ? `
                <details class="set-advanced">
                    <summary>${escapeHtml(group.advancedLabel || "Advanced")}</summary>
                    <div class="set-form">${advanced.map(renderField).join("")}</div>
                </details>` : ""}
            ${group.key === "spoolman" ? renderSpoolmanTest() : ""}`;
        container.appendChild(card);
    }

    container.querySelectorAll("input, select").forEach(input => {
        input.addEventListener("input", () => setDirty(true));
    });

    container.querySelectorAll("[data-reset]").forEach(button => {
        button.addEventListener("click", () => resetField(button.dataset.reset));
    });

    document.getElementById("test-spoolman")?.addEventListener("click", testSpoolmanConnection);
}

/* ---- Connection tests ---- */

function renderSpoolmanTest() {
    return `<div class="set-test-row">
                <button class="btn btn-small" type="button" id="test-spoolman">Test connection</button>
                <span class="set-test-result" id="test-spoolman-result"></span>
            </div>`;
}

/**
 * One check result as a pill plus, when there is one, the reason next to it.
 * A warning means the connection came up but could not be fully confirmed, so
 * it gets its own colour rather than being sold as a clean result.
 */
function testPill(label, result) {
    const kind = !result.ok ? "pill-bad" : result.warning ? "pill-legacy" : "pill-ok";
    const state = !result.ok ? "failed" : result.warning ? "unconfirmed" : "reachable";
    const message = result.ok ? result.warning : result.error;
    const reason = message ? ` <span class="set-test-reason">${escapeHtml(message)}</span>` : "";

    return `<span class="pill ${kind}">${escapeHtml(label)} ${state}</span>${reason}`;
}

/**
 * Tries the Spoolman address currently in the form, not the stored one, so a
 * new endpoint can be verified before it is saved. The host and port from the
 * collapsed section count too, which is why the button sits below it.
 */
async function testSpoolmanConnection() {
    const button = document.getElementById("test-spoolman");
    const output = document.getElementById("test-spoolman-result");
    button.disabled = true;
    output.textContent = "Testing...";

    try {
        const payload = {};
        for (const key of ["SPOOLMAN_ENDPOINT", "SPOOLMAN_IP", "SPOOLMAN_PORT", "SPOOLMAN_SUBFOLDER"]) {
            payload[key] = document.getElementById(`set-${key}`)?.value ?? "";
        }

        const result = await sendJson("./api/test/spoolman", "POST", payload);
        output.innerHTML = `${testPill("Spoolman", result)}
            ${result.url ? `<span class="set-test-reason">${escapeHtml(result.url)}</span>` : ""}`;
    } catch (err) {
        output.innerHTML = testPill("Spoolman", { ok: false, error: err.message });
    } finally {
        button.disabled = false;
    }
}

/**
 * Tries both connections a printer needs: MQTT for the AMS data and FTPS for
 * the sliced file the consumption is read from. An empty access code means the
 * stored one is used, which is how an edit without retyping it is tested.
 */
async function testPrinterConnection() {
    const button = document.getElementById("printer-dialog-test");
    const output = document.getElementById("printer-test-result");
    button.disabled = true;
    output.textContent = "Testing...";

    try {
        const result = await sendJson("./api/test/printer", "POST", {
            id: document.getElementById("printer-id").value,
            ip: document.getElementById("printer-ip").value,
            code: document.getElementById("printer-code").value,
        });

        output.innerHTML = `<div>${testPill("MQTT", result.mqtt)}</div>
                            <div>${testPill("FTPS", result.ftps)}</div>`;
    } catch (err) {
        output.innerHTML = `<span class="set-test-reason set-test-failed">${escapeHtml(err.message)}</span>`;
    } finally {
        button.disabled = false;
    }
}

/**
 * Shows the URL the service actually talks to. The endpoint field alone does
 * not say it: a subfolder is appended, and with no endpoint the host and port
 * from the advanced section are used instead.
 */
function renderEffectiveUrl() {
    return spoolmanUrl
        ? `<p class="set-note">Currently talking to <code>${escapeHtml(spoolmanUrl)}</code></p>`
        : `<p class="set-note set-note-warn">No endpoint configured, nothing is synchronised.</p>`;
}

/**
 * A field that belongs to the whole card rather than to a row of its own.
 *
 * Only the label, the switch and an info icon carrying the description, so the
 * card header stays a header. Everything else about it works as usual, the id
 * is the same one the form is read back from.
 */
function renderHeaderField(field) {
    const id = `set-${field.key}`;
    const reset = isDefault(field)
        ? ""
        : `<button type="button" class="set-reset" data-reset="${field.key}">default</button>`;

    return `<div class="set-head-field">
                <label for="${id}">${escapeHtml(field.label)}</label>
                <span class="set-info" tabindex="0" role="note"
                      aria-label="${escapeHtml(field.description)}"
                      data-tip="${escapeHtml(field.description)}">i</span>
                ${reset}
                <label class="set-switch" for="${id}">
                    <input type="checkbox" id="${id}" ${values[field.key] ? "checked" : ""}>
                    <span class="set-switch-track"></span>
                </label>
            </div>`;
}

/** Builds the input for one field, chosen by the type the schema reports. */
function renderField(field) {
    const value = values[field.key];
    const id = `set-${field.key}`;
    let input;

    if (field.type === "boolean") {
        input = `<label class="set-switch" for="${id}">
                     <input type="checkbox" id="${id}" ${value ? "checked" : ""}>
                     <span class="set-switch-track"></span>
                 </label>`;
    } else if (field.type === "enum") {
        const options = field.options
            .map(option => `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option)}</option>`)
            .join("");
        input = `<select id="${id}">${options}</select>`;
    } else if (field.type === "integer") {
        input = `<input type="number" id="${id}" value="${escapeHtml(value)}"
                        ${field.min !== null ? `min="${field.min}"` : ""}
                        ${field.max !== null ? `max="${field.max}"` : ""}>`;
    } else {
        input = `<input type="text" id="${id}" value="${escapeHtml(value ?? "")}">`;
    }

    const badges = [
        field.restartRequired ? `<span class="pill pill-legacy">restart required</span>` : "",
        sources[field.key] === "environment" ? `<span class="pill pill-gcode">from the environment</span>` : "",
        // Once saved, the file owns every field, so this is the only way back to
        // the documented value.
        isDefault(field) ? "" : `<button type="button" class="set-reset" data-reset="${field.key}">default</button>`,
    ].join("");

    // A checkbox reads better next to its label than under it, so it sits in
    // the label row and the description stays where it is for every field.
    return `<div class="set-field${field.type === "boolean" ? " set-field-toggle" : ""}">
                <label class="set-field-label" for="${id}">
                    <span>${escapeHtml(field.label)}</span>${badges}
                </label>
                ${input}
                <small>${escapeHtml(field.description)}</small>
            </div>`;
}

/** Whether a field currently holds the value the schema documents as default. */
function isDefault(field) {
    const value = values[field.key];
    return value === field.default || (value === null && field.default === null);
}

/** Puts the schema default into a field without touching the rest of the form. */
function resetField(key) {
    const field = fields.find(f => f.key === key);
    const input = document.getElementById(`set-${key}`);
    if (!field || !input) return;

    if (field.type === "boolean") input.checked = !!field.default;
    else input.value = field.default ?? "";

    document.querySelector(`[data-reset="${key}"]`)?.remove();
    setDirty(true);
}

/** Reads every field back out of the form, in the type the backend expects. */
function collectSettings() {
    const payload = {};

    for (const field of fields) {
        const input = document.getElementById(`set-${field.key}`);
        if (!input) continue;

        if (field.type === "boolean") payload[field.key] = input.checked;
        else payload[field.key] = input.value;
    }

    return payload;
}

async function saveSettings(event) {
    event.preventDefault();
    const button = document.getElementById("save-settings");
    button.disabled = true;

    try {
        const result = await sendJson("./api/settings", "PUT", { revision, values: collectSettings() });
        applyView(result);

        if (restartPending) {
            showRestartNotice();
        } else if (result.changed.length) {
            showBanner("Saved and applied.", "ok");
        } else {
            showBanner("Nothing changed.", "ok");
        }
    } catch (err) {
        showBanner(err.conflict
            ? "The settings were changed somewhere else in the meantime. Discard changes to load them, then apply yours again."
            : `Could not save: ${err.message}`, "bad");
        button.disabled = false;
    }
}

/* ---- Printers ---- */

async function loadPrinters() {
    try {
        printers = await fetchJson("./api/printers/config");
        renderPrinters();
    } catch (err) {
        document.getElementById("printer-table").innerHTML =
            `<p class="set-error">Could not load the printers: ${escapeHtml(err.message)}</p>`;
    }
}

/** Maps an MQTT status onto one of the shared status pill styles. */
function statusPill(status) {
    const kind = status === "Connected" ? "pill-ok" : status === "Disabled" ? "pill-legacy" : "pill-bad";
    return `<span class="pill ${kind}">${escapeHtml(status)}</span>`;
}

function renderPrinters() {
    const container = document.getElementById("printer-table");

    if (!printers.length) {
        container.innerHTML = `<p class="set-note">No printers configured yet. The access code is the LAN code from the network settings of the printer.</p>`;
        return;
    }

    const rows = printers.map(printer => `
        <tr>
            <td>${escapeHtml(printer.name)}</td>
            <td class="set-mono">${escapeHtml(printer.id)}</td>
            <td class="set-mono">${escapeHtml(printer.ip)}</td>
            <td>${statusPill(printer.mqttStatus)}</td>
            <td class="set-row-actions">
                <button class="btn btn-small" data-edit="${escapeHtml(printer.id)}">Edit</button>
                <button class="btn btn-small btn-danger" data-delete="${escapeHtml(printer.id)}">Delete</button>
            </td>
        </tr>`).join("");

    container.innerHTML = `<table class="data-table">
            <thead><tr><th>Name</th><th>Serial number</th><th>Address</th><th>MQTT</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <p class="set-note">The access code is stored on the server and never sent back to the browser. Leave it empty while editing to keep the one already stored.</p>`;

    container.querySelectorAll("[data-edit]").forEach(button => {
        button.onclick = () => openPrinterDialog(printers.find(p => p.id === button.dataset.edit));
    });
    container.querySelectorAll("[data-delete]").forEach(button => {
        button.onclick = () => confirmDeletePrinter(printers.find(p => p.id === button.dataset.delete));
    });
}

/**
 * Opens the add or edit dialog. The serial number is read only while editing:
 * it keys the MQTT topic, the log file and the spool assignments, so a
 * different one describes a different printer.
 */
function openPrinterDialog(printer) {
    const editing = !!printer;
    const dialog = document.getElementById("printer-dialog");

    document.getElementById("printer-dialog-title").textContent = editing ? `Edit ${printer.name}` : "Add printer";
    document.getElementById("printer-dialog-error").textContent = "";
    document.getElementById("printer-test-result").textContent = "";
    document.getElementById("printer-dialog-fields").innerHTML = `
        <div class="set-field">
            <label class="set-field-label" for="printer-name"><span>Name</span></label>
            <input type="text" id="printer-name" value="${escapeHtml(printer?.name ?? "")}">
            <small>Shown in the Web UI and in the log files.</small>
        </div>
        <div class="set-field">
            <label class="set-field-label" for="printer-id"><span>Serial number</span></label>
            <input type="text" id="printer-id" value="${escapeHtml(printer?.id ?? "")}" ${editing ? "disabled" : ""}>
            <small>${editing ? "Cannot be changed. Add a new printer instead." : "Found on the printer under Settings, Device."}</small>
        </div>
        <div class="set-field">
            <label class="set-field-label" for="printer-ip"><span>Address</span></label>
            <input type="text" id="printer-ip" value="${escapeHtml(printer?.ip ?? "")}">
            <small>Host name or IP address in the local network.</small>
        </div>
        <div class="set-field">
            <label class="set-field-label" for="printer-code"><span>Access code</span></label>
            <input type="password" id="printer-code" value="" autocomplete="new-password"
                   placeholder="${editing ? "unchanged" : ""}">
            <small>${editing ? "Leave empty to keep the stored code." : "LAN access code from the network settings of the printer."}</small>
        </div>`;

    document.getElementById("printer-dialog-save").onclick = () => savePrinter(printer);
    dialog.showModal();
    // Straight into the first field, rather than on whatever the dialog focuses
    document.getElementById("printer-name").focus();
}

async function savePrinter(printer, force = false) {
    const error = document.getElementById("printer-dialog-error");
    const payload = {
        name: document.getElementById("printer-name").value,
        ip: document.getElementById("printer-ip").value,
        code: document.getElementById("printer-code").value,
        force,
    };

    try {
        if (printer) {
            await sendJson(`./api/printers/${encodeURIComponent(printer.id)}`, "PUT", payload);
            showBanner(`Saved ${payload.name || printer.name}.`, "ok");
        } else {
            await sendJson("./api/printers", "POST", { ...payload, id: document.getElementById("printer-id").value });
            showBanner(`Added ${payload.name}. The connection is being established.`, "ok");
        }
        closeDialog("printer-dialog");
        loadPrinters();
    } catch (err) {
        if (err.printInFlight) {
            // The dialog would sit on top of the confirmation, so it goes first
            // and comes back if the change is not carried out after all.
            closeDialog("printer-dialog");
            const done = await confirmWhilePrinting(err, () => savePrinter(printer, true));
            if (!done) document.getElementById("printer-dialog").showModal();
            return;
        }
        error.textContent = err.message;
    }
}

/**
 * Opens the confirmation dialog and resolves with what the user picked.
 *
 * @param {{title: string, html: string, okLabel?: string}} options
 * @returns {Promise<boolean>} whether the action was confirmed
 */
function confirmAction({ title, html, okLabel = "Delete" }) {
    const dialog = document.getElementById("confirm-dialog");
    const ok = document.getElementById("confirm-dialog-ok");
    const cancel = document.getElementById("confirm-dialog-cancel");

    document.getElementById("confirm-dialog-title").textContent = title;
    document.getElementById("confirm-dialog-text").innerHTML = html;
    ok.textContent = okLabel;

    return new Promise(resolve => {
        const finish = (result) => {
            ok.onclick = null;
            cancel.onclick = null;
            dialog.close();
            resolve(result);
        };
        ok.onclick = () => finish(true);
        cancel.onclick = () => finish(false);
        dialog.showModal();
        // The harmless choice takes the focus, not the one that deletes
        cancel.focus();
    });
}

/**
 * Asks whether an action that would interrupt a running print should go ahead
 * anyway, and repeats it with `force` when it should.
 *
 * @param {Error} err - the rejected request, carrying the reason from the server
 * @param {function(): Promise} retry - the same request with force set
 * @returns {Promise<boolean>} whether the action was carried out
 */
async function confirmWhilePrinting(err, retry) {
    const confirmed = await confirmAction({
        title: "A print is running",
        html: `<p>${escapeHtml(err.message)}</p>
               <p class="set-note">Waiting until the print has finished keeps the booking.</p>`,
        okLabel: "Do it anyway",
    });

    if (!confirmed) return false;
    await retry();
    return true;
}

function confirmDeletePrinter(printer) {
    confirmAction({
        title: `Delete ${printer.name}?`,
        html: `<p>The printer is disconnected and removed from the configuration.
                  Its spool assignments are dropped as well. The log file is kept.</p>
               <p class="set-note">Spools already created in Spoolman are not touched.</p>`,
    }).then(confirmed => confirmed && deletePrinter(printer, false));
}

async function deletePrinter(printer, force) {
    const url = `./api/printers/${encodeURIComponent(printer.id)}`;

    try {
        await fetchJson(url, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force }),
        });
        showBanner(`Removed ${printer.name}.`, "ok");
        loadPrinters();
    } catch (err) {
        if (err.printInFlight) {
            await confirmWhilePrinting(err, () => deletePrinter(printer, true));
            return;
        }
        showBanner(`Could not remove the printer: ${err.message}`, "bad");
    }
}

function closeDialog(id) {
    document.getElementById(id).close();
}
