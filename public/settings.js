// Settings page. Renders the fields the backend describes in /api/settings, so
// a new setting only has to be added to the schema in src/settings.js, and
// manages the printer list through /api/printers.
//
// A module, so the HTTP and escaping helpers can be shared with the dashboard
// rather than kept as a second copy here. The menu bar and the export dialog
// stay classic scripts and are read off the global scope.
import { escapeHtml, fetchJson, sendJson } from "./ui.js";

// Order and headline of the field groups. The group key comes from the schema,
// the fields the schema marks as advanced go into the collapsed part.
const GROUPS = [
    { key: "spoolman", title: "Spoolman connection", advancedLabel: "Host, port, subfolder and public URL" },
    { key: "tracking", title: "Tracking" },
    { key: "sync",     title: "Synchronisation" },
    { key: "printer",  title: "Printer connection" },
    { key: "logging",  title: "Logging" },
    { key: "network",  title: "Network access" },
];

let fields = [];
let values = {};
let sources = {};
// Which password fields hold a stored value. The values themselves are never
// sent, so this is all the page knows about them.
let hasValue = {};
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
// The API keys as the server lists them: name, when it was created and when it
// was last used, never the key itself. Cached here because the Network access
// card is rebuilt from the settings response on every save and over SSE.
let apiKeys = [];
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
    document.getElementById("download-diagnostics").addEventListener("click", downloadDiagnostics);
    document.getElementById("reconnect-printers").addEventListener("click", reconnectPrinters);
    document.getElementById("toggle-monitoring").addEventListener("click", toggleAllMonitoring);
    document.getElementById("printer-dialog-cancel").addEventListener("click", () => closeDialog("printer-dialog"));
    document.getElementById("apikey-dialog-cancel").addEventListener("click", () => closeDialog("apikey-dialog"));
    document.getElementById("logdetail-dialog-cancel").addEventListener("click", () => closeDialog("logdetail-dialog"));
    document.getElementById("printer-dialog-test").addEventListener("click", testPrinterConnection);

    window.addEventListener("beforeunload", event => {
        if (!formDirty) return;
        event.preventDefault();
        event.returnValue = "";
    });

    loadSettings();
    loadEnvInfo();
    loadPrinters();
    loadApiKeys();
    loadSystemInfo();
    loadUpdate();

    const eventSource = new EventSource("./api/events");
    eventSource.onmessage = event => {
        const data = JSON.parse(event.data);
        if (data.type === "printers_update") {
            loadPrinters();
            // A renamed or removed printer changes the menu as well
            refreshMenubarPrinters();
        }
        if (data.type === "settings_update" && !formDirty) {
            loadSettings();
            // A save anywhere can be the one that takes the last variable out of
            // service, which is exactly when this note has to change.
            loadEnvInfo();
        }
    };
});

/* ---- The standing note about environment variables ---- */

/**
 * The standing note at the head of the page, for as long as a setting is still
 * taken from an environment variable.
 *
 * The badge on a field says that this one value comes from a variable. What it
 * cannot say is what happens on the next save, which is the part that surprises
 * people: the page sends every field, so the first save writes the whole
 * configuration into `settings.json` and every one of those variables goes
 * quiet, including the ones nobody touched.
 *
 * Shown exactly when a field carries the badge, and not dismissible, unlike the
 * dialog the dashboard shows once per installation: this is read again by
 * whoever opens the settings page a year later with the compose file in the
 * other window. An install that never used the variables never sees it, and one
 * that used them loses it the moment the save takes them out of service.
 */
async function loadEnvInfo() {
    const box = document.getElementById("set-env-info");
    if (!box) return;

    let notice;
    try {
        notice = (await fetchJson("./api/notices"))["env-config"];
    } catch {
        // A standing hint is not worth an error message of its own.
        box.hidden = true;
        return;
    }

    // Exactly the condition the badges follow: no field carries one, so there is
    // nothing here to explain. Emptied as well, so a save that ends the last
    // variable does not leave its own text behind the hidden attribute.
    if (!notice?.variables?.length) {
        box.hidden = true;
        box.innerHTML = "";
        return;
    }

    const code = list => `<code>${list.map(escapeHtml).join("</code>, <code>")}</code>`;
    const parts = ["<h2>Information</h2>"];

    parts.push(`<p>These settings are still taken from environment variables, which is
                   <b>deprecated since 1.3.0</b>: ${code(notice.variables)}. They are marked
                   <span class="pill pill-gcode">from the environment</span> in the fields below.</p>`);
    parts.push(`<p>Saving on this page writes <b>every</b> setting into
                   <code>printers/settings.json</code>, not only the field that was changed. After
                   that the file owns them all and none of these variables changes anything any
                   more, whatever the compose file says.</p>`);

    if (notice.printerVariables?.length) {
        parts.push(notice.printerVariablesIgnored
            ? `<p>${code(notice.printerVariables)} are set but have no effect:
                  <code>printers.json</code> exists and owns the printer list.</p>`
            : `<p>The printer list was seeded from ${code(notice.printerVariables)} and written to
                  <code>printers.json</code>, which owns it from now on.</p>`);
    }

    box.innerHTML = parts.join("");
    box.hidden = false;
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
    hasValue = view.hasValue ?? {};
    spoolmanUrl = view.spoolmanUrl;
    restartPending = view.restartPending;
    revision = view.revision;
    supervised = view.supervised;
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

/* ---- Service card ---- */

/**
 * The facts about this installation, rendered as a definition list.
 *
 * Shown rather than kept for the diagnostics bundle alone, because half of what
 * a support question asks for is on this line, and because "tracking" tells the
 * user what the process is actually doing, which is not always what the stored
 * setting says while a restart is pending.
 */
async function loadSystemInfo() {
    const container = document.getElementById("system-info");
    if (!container) return;

    let info;
    try {
        info = await fetchJson("./api/system");
    } catch (err) {
        container.innerHTML = `<div class="set-fact"><dt>System</dt><dd>could not be read: ${escapeHtml(err.message)}</dd></div>`;
        return;
    }

    const rows = [
        ["Version", info.version],
        ["Node", info.node],
        ["Platform", info.platform],
        ["Uptime", formatUptime(info.uptime)],
        ["Memory", `${info.memoryMB} MB`],
        ["Tracking", info.tracking],
        ["Supervisor", info.supervised ? "on" : "off"],
        ["Printers", String(info.printers)],
        ["API keys", String(info.apiKeys ?? 0)],
        ["Spoolman", info.spoolman],
    ];

    container.innerHTML = rows
        .map(([label, value]) => `<div class="set-fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
        .join("");
}

/** Seconds into the coarsest unit that still says something useful. */
function formatUptime(seconds) {
    if (!Number.isFinite(seconds)) return "unknown";
    if (seconds < 60) return `${seconds} s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
    return `${(seconds / 86400).toFixed(1)} days`;
}

/**
 * Compares this version against the latest GitHub release.
 *
 * Nothing is installed and nothing about the installation is sent. A failure is
 * reported as "could not check" rather than as an error, because a printer
 * network without internet access is a normal setup, not a broken one.
 */
async function loadUpdate() {
    const note = document.getElementById("update-note");
    if (!note) return;

    let update;
    try {
        update = await fetchJson("./api/update");
    } catch {
        note.textContent = "The update check could not be reached.";
        return;
    }

    if (update.error) {
        note.textContent = `Could not check for updates: ${update.error}`;
        return;
    }

    if (update.ahead) {
        // A dev or release candidate image. Saying "up to date" here would
        // suggest this version is the released one, which it is not.
        note.textContent = `This is a prerelease. The latest release is ${update.latest}.`;
        return;
    }

    if (!update.updateAvailable) {
        note.textContent = `Up to date, the latest release is ${update.latest}.`;
        return;
    }

    note.innerHTML = `Version <strong>${escapeHtml(update.latest)}</strong> is available.
        ${update.url ? `<a href="${escapeHtml(update.url)}" target="_blank" rel="noopener">Release notes</a>` : ""}`;
}

/** Asks whether the bundle should be anonymised, then downloads it. */
function downloadDiagnostics() {
    downloadWithExportMode({
        url: "./api/diagnostics/download",
        title: "Download diagnostics",
        what: "One archive with the logs, the settings, the printer list and the facts about this installation. This is what a bug report needs.",
    });
}

/**
 * Rebuilds every MQTT connection without ending the process.
 *
 * Deliberately without a confirmation, unlike the restart: the consumption of a
 * running print is tracked in memory and booked when the job ends, and that
 * state survives a reconnect. It is the smaller hammer of the two.
 */
async function reconnectPrinters() {
    const button = document.getElementById("reconnect-printers");
    button.disabled = true;

    try {
        const result = await sendJson("./api/printers/reconnect", "POST", {});
        const skipped = result.skipped ? `, ${result.skipped} skipped because monitoring is off` : "";
        showBanner(`Reconnecting ${result.reconnected.length} printer(s)${skipped}.`, "ok");
        loadPrinters();
    } catch (err) {
        showBanner(`Could not reconnect: ${err.message}`, "bad");
    } finally {
        button.disabled = false;
    }
}

/** Whether at least one printer is currently being monitored. */
function anyMonitoring() {
    return printers.some(printer => printer.monitoringEnabled);
}

/** Keeps the label of the monitoring button on what pressing it would do. */
function renderMonitoringButton() {
    const button = document.getElementById("toggle-monitoring");
    if (!button) return;

    button.disabled = !printers.length;
    button.textContent = anyMonitoring() ? "Pause all monitoring" : "Resume all monitoring";
    document.getElementById("service-note").textContent = printers.length && !anyMonitoring()
        ? "Monitoring is paused. No AMS report is processed and nothing is written to Spoolman."
        : "";
}

/**
 * Turns monitoring off or on for every printer at once.
 *
 * The per printer switch on the dashboard is the same thing; this is for the
 * case the switch exists for, a Spoolman that is being worked on, where doing it
 * one printer at a time is busywork.
 */
async function toggleAllMonitoring() {
    const button = document.getElementById("toggle-monitoring");
    const enable = !anyMonitoring();
    button.disabled = true;

    try {
        const result = await sendJson(`./api/monitoring/${enable ? "start" : "stop"}`, "POST", {});
        showBanner(
            result.changed.length
                ? `Monitoring ${enable ? "resumed" : "paused"} for ${result.changed.length} of ${result.total} printer(s).`
                : `Monitoring was already ${enable ? "on" : "off"} everywhere.`,
            "ok",
        );
        await loadPrinters();
    } catch (err) {
        showBanner(`Could not change monitoring: ${err.message}`, "bad");
    } finally {
        button.disabled = false;
        renderMonitoringButton();
    }
}

/* ---- Restarting the service ---- */

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

        // A field the schema hands to a dialog is not part of the card's grid.
        // It still arrives in `fields`, which is what lets the dialog render it
        // from the schema rather than holding a second copy of it.
        const carded = groupFields.filter(field => !field.dialog);
        const header = carded.filter(field => field.header);
        const main = carded.filter(field => !field.advanced && !field.header);
        const advanced = carded.filter(field => field.advanced && !field.header);

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
            ${group.key === "spoolman" ? renderSpoolmanTest() : ""}
            ${group.key === "logging" ? renderLogDetailShell() : ""}
            ${group.key === "network" ? renderApiKeyShell() : ""}`;
        container.appendChild(card);
    }

    container.querySelectorAll("input, select").forEach(input => {
        input.addEventListener("input", () => setDirty(true));
    });

    container.querySelectorAll("[data-reset]").forEach(button => {
        button.addEventListener("click", () => resetField(button.dataset.reset));
    });

    container.querySelectorAll("[data-clear]").forEach(button => {
        button.addEventListener("click", () => clearPassword(button.dataset.clear));
    });

    document.getElementById("test-spoolman")?.addEventListener("click", testSpoolmanConnection);
    document.getElementById("open-logdetail")?.addEventListener("click", () => openLogDetailDialog(null));
    // The printer list loads on its own, so this line may already be known
    renderLogDetailOverrides();
    document.getElementById("add-apikey")?.addEventListener("click", () => openApiKeyDialog());
    // The card was just rebuilt, so the list has to be painted into the new one
    renderApiKeys();
}

/* ---- Connection tests ---- */

function renderSpoolmanTest() {
    return `<div class="set-test-row">
                <button class="btn btn-small" type="button" id="test-spoolman">Test connection</button>
                <span class="set-test-result" id="test-spoolman-result"></span>
            </div>`;
}

/* ---- Log detail ----
 *
 * Level, areas and the raw MQTT trace live in a dialog rather than in the card,
 * because they belong together and because a printer can override them. The
 * dialog renders from the schema fields the server marks `dialog: "logDetail"`,
 * so a new one appears here without this file learning about it.
 */

/** The fields the log detail dialog owns, in schema order. */
function logDetailFields() {
    return fields.filter(field => field.dialog === "logDetail");
}

/** One field of that set, by key. */
function logDetailField(key) {
    return logDetailFields().find(field => field.key === key);
}

/** The button in the Logging card, under a line saying what is set right now. */
function renderLogDetailShell() {
    const level = values.LOG_LEVEL;
    const categories = values.LOG_CATEGORIES ?? [];
    const all = logDetailField("LOG_CATEGORIES")?.options ?? [];
    const areas = categories.length === all.length
        ? "every area"
        : categories.length
            ? `${categories.length} of ${all.length} areas`
            : "no area";

    // The line about printers that decided something of their own is filled by
    // renderPrinters(): the two cards are loaded independently, and this one is
    // rebuilt on every settings save while the printer list is not.
    return `<div class="set-test-row">
                <button class="btn btn-small" type="button" id="open-logdetail">Log detail...</button>
                <span class="set-test-reason">${escapeHtml(
                    // One text node, no inline markup: the row is a flex
                    // container, so an element inside this span would become a
                    // flex item and swallow the spaces around it
                    `Level ${level ?? ""}, ${areas}, raw MQTT trace ${values.MQTT_TRACE ? "on" : "off"}`
                )}</span>
            </div>
            <p class="set-note" id="logdetail-overrides" hidden></p>`;
}

/**
 * Names the printers that log by their own rules, in the Logging card.
 *
 * Without it the card describes settings that a printer is quietly ignoring,
 * which is exactly the confusion an override creates.
 */
function renderLogDetailOverrides() {
    const note = document.getElementById("logdetail-overrides");
    if (!note) return;

    const overriding = printers.filter(printer => Object.keys(printer.logDetail || {}).length);
    note.hidden = overriding.length === 0;
    const one = overriding.length === 1;
    note.textContent = overriding.length
        ? `${overriding.map(printer => printer.name).join(", ")} ${one ? "has" : "have"} log settings of ${one ? "its" : "their"} own, edited in the Printers card.`
        : "";
}

/**
 * Opens the log detail dialog, globally or for one printer.
 *
 * The printer variant carries one switch more: a printer follows the global
 * settings until it is told not to, and that is stored as an absent field
 * rather than as a copy of the global value, so a later change to the global
 * one still reaches it.
 *
 * @param {object|null} printer - the printer to edit, or null for the global settings
 */
function openLogDetailDialog(printer) {
    const dialog = document.getElementById("logdetail-dialog");
    const detail = printer?.logDetail || {};
    const inherits = !printer ? false : Object.keys(detail).length === 0;

    const levelField = logDetailField("LOG_LEVEL");
    const categoryField = logDetailField("LOG_CATEGORIES");
    const traceField = logDetailField("MQTT_TRACE");

    const level = detail.level ?? values.LOG_LEVEL;
    const categories = detail.categories ?? values.LOG_CATEGORIES ?? [];
    const trace = detail.mqttTrace ?? values.MQTT_TRACE;

    document.getElementById("logdetail-dialog-title").textContent =
        printer ? `Log detail for ${printer.name}` : "Log detail";
    document.getElementById("logdetail-dialog-error").textContent = "";

    const inheritRow = printer
        ? `<div class="set-field set-field-toggle">
               <label class="set-field-label" for="ld-inherit"><span>Follow the global settings</span></label>
               <label class="set-switch" for="ld-inherit">
                   <input type="checkbox" id="ld-inherit" ${inherits ? "checked" : ""}>
                   <span class="set-switch-track"></span>
               </label>
               <small>On, this printer logs whatever the Logging card says. Off, the values below apply to
                      this printer only and a later change to the global ones does not reach it.</small>
           </div>`
        : "";

    // The rotation budget of the trace file is global: it is disk space, not a
    // decision about one printer, and every trace file shares the setting.
    const budget = printer
        ? ""
        : ["MQTT_TRACE_MAX_SIZE_MB", "MQTT_TRACE_KEEP"]
            .map(key => renderField(logDetailField(key)))
            .join("");

    document.getElementById("logdetail-dialog-body").innerHTML = `
        <div class="set-form">
            ${inheritRow}
            <div class="set-field">
                <label class="set-field-label" for="ld-level"><span>${escapeHtml(levelField.label)}</span></label>
                <input type="range" id="ld-level" class="set-slider"
                       min="0" max="${levelField.options.length - 1}" step="1"
                       value="${Math.max(0, levelField.options.indexOf(level))}">
                <div class="set-slider-scale">
                    ${levelField.options.map(option => `<span>${escapeHtml(option)}</span>`).join("")}
                </div>
                <small>${escapeHtml(levelField.description)}</small>
            </div>
            <div class="set-field">
                <label class="set-field-label"><span>${escapeHtml(categoryField.label)}</span></label>
                <div class="set-checks" id="ld-categories">
                    ${categoryField.options.map(option => `
                        <label class="set-check">
                            <input type="checkbox" value="${escapeHtml(option)}"
                                   ${categories.includes(option) ? "checked" : ""}>
                            <span>${escapeHtml(option)}</span>
                        </label>`).join("")}
                </div>
                <small>${escapeHtml(categoryField.description)}</small>
            </div>
            <div class="set-field set-field-toggle">
                <label class="set-field-label" for="ld-trace"><span>${escapeHtml(traceField.label)}</span></label>
                <label class="set-switch" for="ld-trace">
                    <input type="checkbox" id="ld-trace" ${trace ? "checked" : ""}>
                    <span class="set-switch-track"></span>
                </label>
                <small>${escapeHtml(traceField.description)}</small>
            </div>
            ${budget}
        </div>`;

    // Everything below the inherit switch is only editable once this printer has
    // been taken off the global settings, so the dialog shows what applies
    // rather than an empty form.
    const applyInherit = () => {
        const off = document.getElementById("ld-inherit")?.checked;
        document.querySelectorAll("#logdetail-dialog-body input:not(#ld-inherit)")
            .forEach(input => { input.disabled = !!off; });
    };
    document.getElementById("ld-inherit")?.addEventListener("change", applyInherit);
    applyInherit();

    // The two budget fields come from renderField(), which builds a "default"
    // button the card's own handler would normally wire up
    dialog.querySelectorAll("[data-reset]").forEach(button => {
        button.onclick = () => resetField(button.dataset.reset);
    });

    document.getElementById("logdetail-dialog-save").onclick = () => saveLogDetail(printer);
    dialog.showModal();
}

/** Reads the dialog back and writes it, to the settings or to the printer. */
async function saveLogDetail(printer) {
    const error = document.getElementById("logdetail-dialog-error");
    const save = document.getElementById("logdetail-dialog-save");
    const options = logDetailField("LOG_LEVEL").options;

    const level = options[Number(document.getElementById("ld-level").value)];
    const categories = [...document.querySelectorAll("#ld-categories input:checked")].map(input => input.value);
    const trace = document.getElementById("ld-trace").checked;

    save.disabled = true;
    error.textContent = "";

    try {
        if (printer) {
            const inherits = document.getElementById("ld-inherit").checked;
            await sendJson(`./api/printers/${encodeURIComponent(printer.id)}/logdetail`, "PUT",
                inherits ? {} : { level, categories, mqttTrace: trace });
            await loadPrinters();
        } else {
            const payload = {
                LOG_LEVEL: level,
                LOG_CATEGORIES: categories,
                MQTT_TRACE: trace,
                MQTT_TRACE_MAX_SIZE_MB: document.getElementById("set-MQTT_TRACE_MAX_SIZE_MB").value,
                MQTT_TRACE_KEEP: document.getElementById("set-MQTT_TRACE_KEEP").value,
            };
            // Sent with the revision, like every other save on this page, so a
            // second tab cannot be overwritten silently.
            applyView(await sendJson("./api/settings", "PUT", { revision, values: payload }));
        }

        closeDialog("logdetail-dialog");
        showBanner("Saved and applied.", "ok");
    } catch (err) {
        error.textContent = err.conflict
            ? "The settings were changed somewhere else in the meantime. Discard changes to load them, then apply yours again."
            : `Could not save: ${err.message}`;
    } finally {
        save.disabled = false;
    }
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
                ${reset}
                <label class="set-switch" for="${id}">
                    <input type="checkbox" id="${id}" ${values[field.key] ? "checked" : ""}>
                    <span class="set-switch-track"></span>
                </label>
                <span class="set-info" tabindex="0" role="note"
                      aria-label="${escapeHtml(field.description)}"
                      data-tip="${escapeHtml(field.description)}">i</span>
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
    } else if (field.type === "password") {
        // Never prefilled, because the stored value is a hash the server does
        // not send. Left empty it keeps what is stored, which is the same rule
        // the printer access code follows.
        input = `<input type="password" id="${id}" autocomplete="new-password"
                        placeholder="${hasValue[field.key] ? "unchanged" : "not set"}">`;
    } else {
        input = `<input type="text" id="${id}" value="${escapeHtml(value ?? "")}">`;
    }

    const badges = [
        field.restartRequired ? `<span class="pill pill-legacy">restart required</span>` : "",
        sources[field.key] === "environment" ? `<span class="pill pill-gcode">from the environment</span>` : "",
        // Once saved, the file owns every field, so this is the only way back to
        // the documented value.
        isDefault(field) ? "" : `<button type="button" class="set-reset" data-reset="${field.key}">default</button>`,
        // Emptying the field means "unchanged", so removing a stored password
        // needs a gesture of its own.
        field.type === "password" && hasValue[field.key]
            ? `<button type="button" class="set-reset" data-clear="${field.key}">remove</button>`
            : "",
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
    // A dialog field is not part of the page form, so it must not arm the save
    // button or the warning about leaving with unsaved changes
    if (!field.dialog) setDirty(true);
}

/**
 * Marks a stored password for removal on the next save.
 *
 * Nothing is sent here. The field says what will happen and the save button
 * does it, like every other change on this page.
 */
function clearPassword(key) {
    const input = document.getElementById(`set-${key}`);
    if (!input) return;

    input.value = "";
    input.dataset.clear = "true";
    input.placeholder = "will be removed on save";
    document.querySelector(`[data-clear="${key}"]`)?.remove();
    setDirty(true);
}

/** Reads every field back out of the form, in the type the backend expects. */
function collectSettings() {
    const payload = {};

    for (const field of fields) {
        // A dialog field is saved by that dialog. It shares the id scheme, so
        // an open dialog would otherwise smuggle what is typed in it into a
        // save of the page behind it.
        if (field.dialog) continue;

        const input = document.getElementById(`set-${field.key}`);
        if (!input) continue;

        if (field.type === "boolean") payload[field.key] = input.checked;
        // An empty password field keeps what is stored, so removing one is an
        // explicit null rather than the empty string every save would send.
        else if (field.type === "password") payload[field.key] = input.dataset.clear === "true" ? null : input.value;
        else payload[field.key] = input.value;
    }

    return payload;
}

async function saveSettings(event) {
    event.preventDefault();
    const values = collectSettings();
    if (!await confirmKeysSurvivePassword(values)) return;

    const button = document.getElementById("save-settings");
    button.disabled = true;

    try {
        const result = await sendJson("./api/settings", "PUT", { revision, values });
        applyView(result);
        // This save may have been the one that took the variables out of service
        loadEnvInfo();

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

/**
 * Says what a first password does not do, before it is saved.
 *
 * Setting one ends every browser session, which is what people expect it to do,
 * and leaves every API key working, which is what they do not: a key is not
 * signed with the password and nothing about it changes here. Somebody turning
 * the password on is usually closing the Web UI to the network, and a key
 * created while it stood open keeps full access afterwards.
 *
 * Only for the step from no password to a password. Changing one that is
 * already set is not the surprising case: the keys were created next to it.
 *
 * @param {object} values - what the form is about to send
 * @returns {Promise<boolean>} whether the save should go ahead
 */
async function confirmKeysSurvivePassword(values) {
    const typed = typeof values.AUTH_PASSWORD === "string" && values.AUTH_PASSWORD !== "";
    if (!typed || hasValue.AUTH_PASSWORD || !apiKeys.length) return true;

    const list = apiKeys.map(key => `<li>${escapeHtml(key.name)}</li>`).join("");
    return confirmAction({
        title: "These API keys keep working",
        html: `<p>The password ends every browser session, but it does not touch an API key. These
                  ${apiKeys.length === 1 ? "key keeps" : `${apiKeys.length} keys keep`} full access to this
                  service without ever being asked for it:</p>
               <ul class="set-list">${list}</ul>
               <p class="set-note">That is what a key is for. Revoke the ones you do not recognise, under
                  API keys in this card, and save again.</p>`,
        okLabel: "Set the password",
    });
}

/* ---- Printers ---- */

async function loadPrinters() {
    try {
        printers = await fetchJson("./api/printers/config");
        renderPrinters();
        // The Logging card names the printers that log by their own rules
        renderLogDetailOverrides();
        // The Service card offers the opposite of what is currently the case,
        // so it has to follow every change to the list.
        renderMonitoringButton();
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

    // The data-label of a cell is what the phone layout puts above its value,
    // where there is no header row to read it off. See the responsive block in
    // styles.css, which the spool tables use the same way.
    const rows = printers.map(printer => `
        <tr>
            <td data-label="Name">${escapeHtml(printer.name)}</td>
            <td class="set-mono" data-label="Serial number">${escapeHtml(printer.id)}</td>
            <td class="set-mono" data-label="Address">${escapeHtml(printer.ip)}</td>
            <td data-label="MQTT">${statusPill(printer.mqttStatus)}</td>
            <td class="set-row-actions" data-label="">
                <button class="btn btn-small" data-edit="${escapeHtml(printer.id)}">Edit</button>
                <button class="btn btn-small" data-logdetail="${escapeHtml(printer.id)}">Log${
                    Object.keys(printer.logDetail || {}).length ? " *" : ""}</button>
                <button class="btn btn-small btn-danger" data-delete="${escapeHtml(printer.id)}">Delete</button>
            </td>
        </tr>`).join("");

    container.innerHTML = `<table class="data-table">
            <thead><tr><th>Name</th><th>Serial number</th><th>Address</th><th>MQTT</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <p class="set-note">The access code is stored on the server and never sent back to the browser. Leave it empty while editing to keep the one already stored. <strong>Log</strong> sets how much this printer writes; a star marks one that no longer follows the Logging card.</p>`;

    container.querySelectorAll("[data-edit]").forEach(button => {
        button.onclick = () => openPrinterDialog(printers.find(p => p.id === button.dataset.edit));
    });
    container.querySelectorAll("[data-logdetail]").forEach(button => {
        button.onclick = () => openLogDetailDialog(printers.find(p => p.id === button.dataset.logdetail));
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

/* ---- API keys ---- */

/**
 * The shell the key list is painted into, rendered as part of the Network
 * access card.
 *
 * Below the two fields rather than in a card of its own, because a key is the
 * same question those fields answer: who may talk to this service. The list
 * itself is filled by renderApiKeys(), which runs whenever the card is rebuilt
 * and after every change to the keys.
 */
function renderApiKeyShell() {
    return `<div class="set-subsection">
                <div class="set-subhead">
                    <h3>API keys</h3>
                    <button class="btn btn-small" type="button" id="add-apikey">Add key</button>
                </div>
                <div id="apikey-table"></div>
            </div>`;
}

async function loadApiKeys() {
    try {
        apiKeys = (await fetchJson("./api/apikeys")).keys ?? [];
    } catch (err) {
        apiKeys = [];
        const container = document.getElementById("apikey-table");
        if (container) container.innerHTML = `<p class="set-error">Could not load the API keys: ${escapeHtml(err.message)}</p>`;
        return;
    }
    renderApiKeys();
}

function renderApiKeys() {
    const container = document.getElementById("apikey-table");
    if (!container) return;

    if (!apiKeys.length) {
        container.innerHTML = `<p class="set-note">No API keys. This API answers only the Web UI of this installation, so
            a tool that has no browser, for example Home Assistant, Node-RED or a script, needs a key. It is shown once
            when it is created.</p>`;
        return;
    }

    const rows = apiKeys.map(key => `
        <tr>
            <td data-label="Name">${escapeHtml(key.name)}</td>
            <td data-label="Created">${escapeHtml(formatStamp(key.createdAt))}</td>
            <td data-label="Last used">${escapeHtml(key.lastUsedAt ? formatStamp(key.lastUsedAt) : "never")}</td>
            <td class="set-row-actions" data-label="">
                <button class="btn btn-small btn-danger" data-revoke="${escapeHtml(key.id)}">Revoke</button>
            </td>
        </tr>`).join("");

    container.innerHTML = `<table class="data-table">
            <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <p class="set-note">A key counts as a full session: it may read and change everything the Web UI can. Send it as
            <code>Authorization: Bearer &lt;key&gt;</code> or <code>X-API-Key: &lt;key&gt;</code>. Only a hash is stored,
            so a lost key is replaced rather than looked up. "Last used" is written at most once a minute.</p>`;

    container.querySelectorAll("[data-revoke]").forEach(button => {
        button.onclick = () => confirmRevokeApiKey(apiKeys.find(key => key.id === button.dataset.revoke));
    });
}

/**
 * A stored timestamp in the language of the browser, or "unknown".
 *
 * Every part two digits, so the column lines up rather than jumping between
 * "3.9.2026" and "13.10.2026". The order stays whatever the browser's language
 * puts it in; only the padding is asked for.
 */
function formatStamp(iso) {
    const date = iso ? new Date(iso) : null;
    if (!date || Number.isNaN(date.getTime())) return "unknown";

    return date.toLocaleString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

/** Asks for a name and creates the key. */
function openApiKeyDialog() {
    const dialog = document.getElementById("apikey-dialog");
    const save = document.getElementById("apikey-dialog-save");

    document.getElementById("apikey-dialog-title").textContent = "New API key";
    document.getElementById("apikey-dialog-error").textContent = "";
    document.getElementById("apikey-dialog-body").innerHTML = `
        <div class="set-form">
            <div class="set-field">
                <label class="set-field-label" for="apikey-name"><span>Name</span></label>
                <input type="text" id="apikey-name" maxlength="64" placeholder="Home Assistant">
                <small>Only for you, so you know which key to revoke later.</small>
            </div>
        </div>`;

    save.textContent = "Create key";
    save.hidden = false;
    save.onclick = createApiKey;
    document.getElementById("apikey-dialog-cancel").textContent = "Cancel";

    dialog.showModal();
    document.getElementById("apikey-name").focus();
}

async function createApiKey() {
    const error = document.getElementById("apikey-dialog-error");
    const save = document.getElementById("apikey-dialog-save");
    error.textContent = "";
    save.disabled = true;

    let result;
    try {
        result = await sendJson("./api/apikeys", "POST", { name: document.getElementById("apikey-name").value });
    } catch (err) {
        error.textContent = err.message;
        return;
    } finally {
        save.disabled = false;
    }

    apiKeys = result.keys ?? apiKeys;
    renderApiKeys();
    // The Service card counts the keys, so it is stale the moment one is added
    loadSystemInfo();
    showCreatedApiKey(result.entry?.name ?? "", result.key);
}

/**
 * Shows the key, once.
 *
 * In a field rather than as text, so it can be selected on the installations
 * where the clipboard is not available: the browser hands that API only to a
 * page served over HTTPS or from localhost, and most installations of this
 * service are reached over plain HTTP under their address.
 */
function showCreatedApiKey(name, key) {
    document.getElementById("apikey-dialog-title").textContent = `Key for ${name}`;
    document.getElementById("apikey-dialog-error").textContent = "";
    document.getElementById("apikey-dialog-body").innerHTML = `
        <p>Copy it now. Only a hash of it is stored, so this is the only time it is shown.</p>
        <div class="set-key-row">
            <input type="text" id="apikey-value" class="set-mono" readonly value="${escapeHtml(key)}">
            <button class="btn btn-small" type="button" id="apikey-copy">Copy</button>
        </div>
        <p class="set-note">Send it as <code>Authorization: Bearer &lt;key&gt;</code> or <code>X-API-Key: &lt;key&gt;</code>.</p>`;

    const save = document.getElementById("apikey-dialog-save");
    save.hidden = true;
    save.onclick = null;
    document.getElementById("apikey-dialog-cancel").textContent = "Done";

    const field = document.getElementById("apikey-value");
    field.focus();
    field.select();

    document.getElementById("apikey-copy").onclick = async () => {
        field.select();
        try {
            await navigator.clipboard.writeText(key);
            document.getElementById("apikey-copy").textContent = "Copied";
        } catch {
            // No clipboard permission, or no secure context. The field is
            // selected, so the key is one keyboard shortcut away either way.
            document.getElementById("apikey-copy").textContent = "Press Ctrl+C";
        }
    };
}

function confirmRevokeApiKey(key) {
    if (!key) return;

    confirmAction({
        title: `Revoke ${key.name}?`,
        html: `<p>Anything still using this key stops working at once. Every other key and every browser session keeps
                  working.</p>
               <p class="set-note">A revoked key cannot be brought back. Create a new one and give it to the tool.</p>`,
        okLabel: "Revoke",
    }).then(confirmed => confirmed && revokeApiKey(key));
}

async function revokeApiKey(key) {
    try {
        const result = await fetchJson(`./api/apikeys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
        apiKeys = result.keys ?? apiKeys;
        renderApiKeys();
        loadSystemInfo();
        showBanner(`Revoked the key "${key.name}".`, "ok");
    } catch (err) {
        showBanner(`Could not revoke the key: ${err.message}`, "bad");
    }
}

function closeDialog(id) {
    document.getElementById(id).close();
}
