// Shared menu bar. Every page renders the same bar into #menu-root, this file
// included the dark mode button, so navigation and the theme behave the same on
// the dashboard, the log viewer and the settings page.
//
// The bar carries three things and no more: who this is, where you can go, and
// your session. The brand at the left end is the way home. Next to it the
// dashboard and the logs sit as tabs with the current one underlined, and the
// dark mode button and the gear sit at the other end. The gear is the settings
// page: a link to it while there is nothing to log out of, and once a password
// is set a menu holding the settings page, the log out and, at its foot, the
// version. The settings are a gear among the tools rather than a tab among
// the pages: they are something you reach for, not a place you spend time on,
// and the tabs read as the two views of the printers. The language is a field
// of the settings page, not a control of the bar.
//
// What the page is showing does not belong in the bar, it belongs in the page.
// The dashboard headline already names the printer and the log viewer already
// names the log, so those names are the picker: click "Loaded Spools on Bambu
// P2S" and the printers drop down. That is also what took the download button
// out of the bar; it acts on the log and now sits with it.
//
// Before this, one "Menu" button hid all of it two levels deep, and the log
// entry opened the log of whichever printer had been picked last, which is a
// rule nothing on the screen ever stated.

// The moon and the sun, drawn here for the same reasons as the logout icon
// below: an installation without internet access used to show two broken
// images in the bar, and every page load asked an icon host for them. The
// colours are the ones the fetched icons had, a solid moon in the text colour
// and a yellow sun with orange rays, so the bar looks as it did.
const LIGHT_MODE_ICON = `
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
        <path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1z" fill="currentColor"/>
    </svg>`;
const DARK_MODE_ICON = `
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
        <path d="M12 1.8v3.2M12 19v3.2M1.8 12H5M19 12h3.2M4.8 4.8l2.2 2.2M17 17l2.2 2.2M4.8 19.2 7 17M17 7l2.2-2.2"
              fill="none" stroke="#f0932b" stroke-width="2.2" stroke-linecap="round"/>
        <circle cx="12" cy="12" r="5.2" fill="#f9ca24" stroke="#f0932b" stroke-width="1.2"/>
    </svg>`;

/**
 * The door with the arrow out of it, drawn here rather than fetched.
 *
 * It takes its colour from the entry it sits in, so it follows the theme
 * without a second file, and it is on screen at the same moment as the label
 * rather than whenever an icon host answers.
 */
const LOGOUT_ICON = `
    <svg class="menu-glyph" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
        <path d="M6.5 2.4H3.6c-.7 0-1.2.5-1.2 1.2v8.8c0 .7.5 1.2 1.2 1.2h2.9"
              fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        <path d="M10.4 5.2 13.2 8l-2.8 2.8M13.2 8H6.2"
              fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

/**
 * The HaspelSync spool, the same drawing as public/favicon.svg.
 *
 * The flanges take the text colour, so they are dark on the light bar and
 * light on the dark one without a second file; the winding keeps its two
 * colours in both. The clip path carries an id of its own because the icon
 * sits in the page's document, where "winding" from the favicon would be
 * another element of the same name.
 */
const BRAND_ICON = `
    <svg class="menu-brand-icon" viewBox="0 0 64 64" width="26" height="26" aria-hidden="true" focusable="false">
        <defs><clipPath id="menu-brand-winding"><rect x="15" y="9" width="34" height="46"/></clipPath></defs>
        <rect x="2" y="27.5" width="60" height="9" rx="4.5" fill="#8c8c8c"/>
        <g clip-path="url(#menu-brand-winding)">
            <rect x="15" y="9" width="34" height="46" fill="#00ae42"/>
            <path d="M37 9 L49 9 L49 55 L27 55 Z" fill="#dc7734"/>
        </g>
        <rect x="5" y="2" width="11" height="60" rx="4" fill="currentColor"/>
        <rect x="48" y="2" width="11" height="60" rx="4" fill="currentColor"/>
    </svg>`;

// The glyphs in front of the entries: four tiles for the dashboard, three
// lines for the logs, a gear for the settings. Drawn here like everything else
// in the bar, in the colour of the entry they sit in. The gear is a ring with
// eight teeth; a circle with rays around it was read as the sun, right next to
// the button that shows one.
const DASHBOARD_ICON = `
    <svg class="menu-glyph" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
        <path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" fill="currentColor"/>
    </svg>`;
const LOGS_ICON = `
    <svg class="menu-glyph" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
        <path d="M2 3h12M2 8h12M2 13h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;
const SETTINGS_ICON = `
    <svg class="menu-glyph" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="2.4"/>
        <path d="M8 .9v2.6M8 12.5v2.6M.9 8h2.6M12.5 8h2.6M2.98 2.98l1.84 1.84M11.18 11.18l1.84 1.84M2.98 13.02l1.84-1.84M11.18 4.82l1.84-1.84"
              fill="none" stroke="currentColor" stroke-width="2.6"/>
    </svg>`;

/** Where the picked printer is remembered, read by the dashboard as well. */
const SELECTED_PRINTER_KEY = "lastSelectedPrinterId";

let menuPrinters = [];
let menuOptions = {};
// Every control that opens a panel: the two in the bar, and the picker in the
// headline of the page. Opening one closes the others, wherever they sit.
let popupControls = [];

/**
 * Renders the menu bar and loads the printer list into it.
 *
 * @param {object} options
 * @param {function(object): boolean} [options.onPrinterSelect] - called with the
 *   picked printer. Return true when the page switched to it itself; anything
 *   else navigates to the dashboard.
 * @param {function(object[]): void} [options.onPrinters] - called with the
 *   printer list after every load, so a page can react to an empty list or to a
 *   printer that was added elsewhere.
 * @returns {Promise<object[]>} the loaded printer list
 */
function initMenubar(options = {}) {
    menuOptions = options;
    renderMenubar();
    setupDarkMode();
    return refreshMenubarPrinters();
}

/**
 * Which of the three pages this is, for the mark in the bar.
 *
 * The API page is reached from the settings page and has no entry of its own,
 * so it keeps the settings marked: that is where the way back is.
 */
function currentPage() {
    const file = (window.location.pathname.split("/").pop() || "index.html").toLowerCase();
    if (file.startsWith("settings") || file.startsWith("api")) return "settings";
    if (file.startsWith("logs")) return "logs";
    return "dashboard";
}

function renderMenubar() {
    const root = document.getElementById("menu-root");
    if (!root) return;

    const page = currentPage();

    const current = name => (page === name ? ' aria-current="page"' : "");

    root.innerHTML = `
        <nav class="menunav" aria-label="${t("menu.main")}">
            <a class="menu-brand" href="index.html" title="${t("menu.dashboard")}">
                ${BRAND_ICON}<span class="menu-wordmark">Haspel<b>Sync</b></span>
            </a>

            <button class="menu-item menu-burger" type="button" id="menu-burger"
                    aria-haspopup="true" aria-expanded="false" aria-controls="menu-pages"
                    ${page !== "settings" ? 'data-current="true"' : ""}>
                <span aria-hidden="true">☰</span><span>${t("menu.menu")}</span>
            </button>

            <div class="menu-pages" id="menu-pages">
                <a class="menu-item menu-tab" href="index.html"${current("dashboard")}>${DASHBOARD_ICON}<span>${t("menu.dashboard")}</span></a>
                <div class="menu-host">
                    <button class="menu-item menu-tab menu-caret" type="button" id="menu-logs"
                            aria-haspopup="true" aria-expanded="false" aria-controls="menu-logs-panel"
                            ${current("logs")}>${LOGS_ICON}<span>${t("menu.logs")}</span></button>
                    <div class="menu-panel" id="menu-logs-panel" hidden></div>
                </div>
            </div>

            <div class="menu-end">
                <button id="dark-mode-toggle" type="button" title="${t("menu.theme")}" aria-label="${t("menu.themeToggle")}">
                    <span id="dark-mode-icon">${LIGHT_MODE_ICON}</span>
                </button>
                <span class="menu-tools" id="menu-tools"></span>
            </div>
        </nav>`;

    setupMenuBehaviour(root);

    // The link first, the menu once the service has said there is a session:
    // the gear is on screen with the rest of the bar either way, and an
    // installation without a password never sees it change.
    renderTools(false);
    showSessionTools();
}

/**
 * Turns the gear into the menu where there is a session to end.
 *
 * A log out would otherwise sit in the bar of every installation that never
 * set a password, promising something that does nothing.
 */
async function showSessionTools() {
    try {
        const res = await fetch("./api/auth/state");
        if (!res.ok) return;
        const state = await res.json();
        if (state.required) renderTools(true);
    } catch {
        // The gear stays the link when the service cannot be asked, which is
        // what an installation without a password has anyway.
    }
}

/**
 * The gear at the right end of the bar.
 *
 * Without a password there is nothing to log out of, and a menu holding one
 * entry is a dead end, so the gear is the settings page itself, filled while
 * that page is open. With a password it opens a panel: the settings page, the
 * log out and, at the foot, the version and whether a newer release exists.
 * The filled gear is the only mark of the open page; the entries are actions,
 * not a list to pick from, so none of them carries the tick of a picker.
 *
 * @param {boolean} withSession - whether there is a session to end
 */
function renderTools(withSession) {
    const host = document.getElementById("menu-tools");
    if (!host) return;

    const onSettings = currentPage() === "settings";
    const current = onSettings ? ' aria-current="page"' : "";

    if (!withSession) {
        host.innerHTML = `<a class="menu-tool" href="settings.html" title="${t("menu.settings")}" aria-label="${t("menu.settings")}"${current}>${SETTINGS_ICON}</a>`;
        return;
    }

    host.innerHTML = `
        <div class="menu-host">
            <button class="menu-tool menu-caret" type="button" id="menu-tools-button"
                    aria-haspopup="true" aria-expanded="false" aria-controls="menu-tools-panel"
                    title="${t("menu.menu")}" aria-label="${t("menu.menu")}"${current}>${SETTINGS_ICON}</button>
            <div class="menu-panel menu-panel-end" id="menu-tools-panel" hidden>
                <a class="menu-entry" href="settings.html">${SETTINGS_ICON}${t("menu.settings")}</a>
                <a class="menu-entry" href="#" id="menu-logout">${LOGOUT_ICON}${t("menu.logout")}</a>
                <div class="menu-sep"></div>
                <div class="menu-foot" id="menu-foot">HaspelSync</div>
            </div>
        </div>`;

    const button = document.getElementById("menu-tools-button");
    wirePopupControl(button);
    // Fetched when the panel is first opened rather than with the page: the
    // version check is a request to GitHub, cached by the service, and the
    // foot is read far less often than the bar is loaded.
    button.addEventListener("click", loadToolsFoot, { once: true });

    document.getElementById("menu-logout").onclick = event => {
        event.preventDefault();
        logout();
    };
}

/**
 * Fills the foot of the gear menu: the version, and the release that is
 * available when a newer one exists, linked to its notes.
 */
async function loadToolsFoot() {
    const foot = document.getElementById("menu-foot");
    if (!foot) return;

    try {
        const res = await fetch("./api/update");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const update = await res.json();

        foot.textContent = `HaspelSync v${update.current}`;
        if (!update.updateAvailable || !update.latest) return;

        const line = document.createElement(update.url ? "a" : "span");
        line.className = "menu-foot-update";
        line.textContent = t("menu.updateAvailable", { latest: update.latest });
        if (update.url) {
            line.href = update.url;
            line.target = "_blank";
            line.rel = "noopener";
        }
        foot.appendChild(line);
    } catch {
        // The foot keeps the name alone: the version is on the settings page
        // too, and a menu is not where a failed check gets reported.
    }
}

/** Ends the session and goes to the login page. */
async function logout() {
    try {
        await fetch("./api/auth/logout", { method: "POST" });
    } finally {
        window.location.href = "login.html";
    }
}

/**
 * Opens and closes the two panels and the narrow screen menu.
 *
 * A panel opens on click rather than on hover: hover alone leaves the bar
 * unusable on a touch screen. Opening one closes the other, so two panels are
 * never over each other, and a click outside or Escape closes everything.
 *
 * @param {HTMLElement} root - the container the bar was rendered into
 */
function setupMenuBehaviour(root) {
    const nav = root.querySelector(".menunav");

    // The bar is rebuilt as a whole, so whatever was wired to the old one is
    // gone with it. The picker in the headline adds itself later.
    popupControls = [];
    for (const control of root.querySelectorAll("[aria-haspopup]")) wirePopupControl(control);

    // A pick closes the menu, so it does not stay open over the page that was
    // just navigated to or switched in place.
    nav.addEventListener("click", event => {
        if (event.target.closest("a")) closeMenus();
    });

    document.addEventListener("click", event => {
        // The headline picker is part of the same set even though it sits in
        // the page rather than in the bar.
        if (!event.target.closest("#menu-root, .title-pick-host")) closeMenus();
    });

    document.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        // Only take the focus back when it is inside the menu, so Escape in a
        // dialog is not answered by it.
        const active = document.activeElement;
        const inside = root.contains(active) || !!active?.closest?.(".title-pick-host");
        closeMenus();
        if (!inside) return;

        const back = active.closest(".title-pick-host")?.querySelector("button")
            ?? root.querySelector(".menu-item");
        back?.focus();
    });
}

/**
 * Makes one control open and close its panel.
 *
 * Used for the two in the bar and for the picker in the headline, which is
 * rebuilt whenever the printer list or the pick changes and has to be wired
 * again each time.
 *
 * @param {HTMLElement} control - the button carrying aria-controls
 */
function wirePopupControl(control) {
    popupControls = popupControls.filter(known => known.isConnected);
    popupControls.push(control);

    control.addEventListener("click", event => {
        event.stopPropagation();
        toggle(control, !isOpen(control));
    });

    // Opens the panel and steps into it, the usual behaviour of a menu button
    control.addEventListener("keydown", event => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault();
        toggle(control, true);
        panelOf(control)?.querySelector("a")?.focus();
    });
}

/**
 * The panel a control opens, which is the element its aria-controls names.
 *
 * Only a real panel comes back. The burger names the row of pages, which is a
 * part of the bar that CSS folds away on a narrow screen and shows on a wide
 * one; hiding that one with the `hidden` attribute would take the pages off the
 * bar on every screen, which is exactly what it did once.
 */
function panelOf(control) {
    const target = document.getElementById(control.getAttribute("aria-controls"));
    return target?.classList.contains("menu-panel") ? target : null;
}

function isOpen(control) {
    return control.getAttribute("aria-expanded") === "true";
}

/**
 * Opens or closes one control's panel, closing whatever else was open.
 *
 * The narrow screen menu is the same mechanism: its "panel" is the row of
 * pages, which CSS hides until the nav carries the open class. The log menu
 * sits inside that row, so opening it has to leave the row open, or the list
 * would appear with the menu it belongs to gone.
 */
function toggle(control, open) {
    const insidePages = control.id !== "menu-burger" && !!control.closest(".menu-pages");

    if (open) closeMenus({ keepPages: insidePages });

    control.setAttribute("aria-expanded", String(open));

    if (control.id === "menu-burger") {
        control.closest(".menunav").classList.toggle("pages-open", open);
        return;
    }

    const panel = panelOf(control);
    if (panel) panel.hidden = !open;
}

/**
 * Closes every panel, and the folded pages menu with them.
 *
 * @param {object} [options]
 * @param {boolean} [options.keepPages] - leave the folded pages menu open,
 *   for a panel that lives inside it
 */
function closeMenus({ keepPages = false } = {}) {
    for (const control of popupControls) {
        if (!control.isConnected) continue;
        if (keepPages && control.id === "menu-burger") continue;
        control.setAttribute("aria-expanded", "false");
        const panel = panelOf(control);
        if (panel) panel.hidden = true;
    }

    if (!keepPages) document.querySelector(".menunav")?.classList.remove("pages-open");
}

/** Reloads the printer list and rebuilds everything that depends on it. */
async function refreshMenubarPrinters() {
    try {
        const response = await fetch("./api/printers");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        menuPrinters = await response.json();
    } catch (error) {
        console.error("Could not load the printers for the menu:", error);
        menuPrinters = [];
    }

    renderTitlePicker();
    renderLogEntries();
    menuOptions.onPrinters?.(menuPrinters);
    return menuPrinters;
}

/** An entry of a panel: a link that runs `action` instead of navigating. */
function panelEntry(label, action, { current = false, note = "" } = {}) {
    const entry = document.createElement("a");
    entry.href = "#";
    entry.className = "menu-entry";
    if (current) entry.setAttribute("aria-current", "true");

    const text = document.createElement("span");
    text.textContent = label;
    entry.appendChild(text);

    if (note) {
        const hint = document.createElement("span");
        hint.className = "menu-entry-note";
        hint.textContent = note;
        entry.appendChild(hint);
    }

    entry.addEventListener("click", event => {
        event.preventDefault();
        action();
    });

    return entry;
}

/** A heading inside a panel, for the two groups the log menu has. */
function panelHeading(text) {
    const heading = document.createElement("div");
    heading.className = "menu-panel-head";
    heading.textContent = text;
    return heading;
}

/**
 * The picker over the printers, in the headline of the dashboard and in the
 * toolbar of the log viewer.
 *
 * The dashboard headline reads "Loaded Spools on Bambu P2S", and that name is
 * the control: the name the page already writes is the one thing that changes
 * when you pick, so the pick belongs there rather than in the navigation,
 * where it would say the same thing a second time. The log viewer sets the
 * same control as a plain button in its toolbar, next to the switch between a
 * printer's log and its trace, because there it is one of several choices and
 * has to look like one.
 *
 * Both pages give it a mount point of their own, `#printer-name` and
 * `#headline`, and this fills whichever one is on the page.
 */
function renderTitlePicker() {
    const onLogs = currentPage() === "logs";
    const host = document.getElementById(onLogs ? "headline" : "printer-name");
    if (!host) return;

    const entries = onLogs ? logChoices() : printerChoices();
    const current = entries.find(entry => entry.current) ?? entries[0];
    if (!current) return;

    // A menu holding the one thing already written on its own button is a dead
    // end, so with nothing to choose the name is text and nothing more.
    const openable = entries.length > 1;

    host.textContent = "";
    host.classList.add("title-pick-host");

    const button = document.createElement("button");
    button.type = "button";
    button.className = openable ? "title-pick menu-caret" : "title-pick title-pick-plain";
    button.id = "title-pick";
    button.disabled = !openable;

    const label = document.createElement("span");
    label.textContent = current.label;
    button.appendChild(label);

    host.appendChild(button);

    if (!openable) return;

    const panel = document.createElement("div");
    panel.className = "menu-panel title-panel";
    panel.id = "title-pick-panel";
    panel.hidden = true;

    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", panel.id);

    let heading = null;
    for (const entry of entries) {
        if (entry.heading && entry.heading !== heading) {
            heading = entry.heading;
            panel.appendChild(panelHeading(heading));
        }
        // The serial says which physical machine an entry is, which is what a
        // log gets attached to a bug report for, and it tells two printers of
        // the same name apart
        panel.appendChild(panelEntry(entry.label, entry.action, { current: entry.current, note: entry.note ?? "" }));
    }

    host.appendChild(panel);
    wirePopupControl(button);
}

/** What the dashboard picker offers: the printers, the shown one marked. */
function printerChoices() {
    const current = currentMenuPrinter();
    return menuPrinters.map(printer => ({
        label: printer.name,
        heading: t("menu.showOnDashboard"),
        current: printer.id === current?.id,
        action: () => selectMenuPrinter(printer),
    }));
}

/**
 * What the log viewer's picker offers: the server log and every printer.
 *
 * A printer's raw MQTT trace is not an entry here. It used to be, as a group
 * under the printers, and the one person who needed a trace did not find it
 * there. It is the switch next to this picker now, on the page, where a second
 * file of the same printer reads as what it is. Picking another printer keeps
 * the stream: whoever is reading traces wants the next printer's trace.
 */
function logChoices() {
    const params = new URLSearchParams(window.location.search);
    const openSerial = params.get("serial");
    const openTrace = params.get("stream") === "mqtt";

    const choices = [{
        label: t("menu.server"),
        current: !openSerial,
        action: () => { window.location.href = "logs.html?name=server"; },
    }];

    for (const printer of menuPrinters) {
        choices.push({
            label: printer.name,
            heading: t("menu.printers"),
            note: printer.id,
            current: printer.id === openSerial,
            action: () => openPrinterLog(printer, openTrace),
        });
    }

    // The log of a printer that was removed while its log is open: the page
    // still shows it, so the picker has to be able to name it.
    if (openSerial && !choices.some(choice => choice.current)) {
        choices.push({
            label: params.get("name") || openSerial,
            heading: t("menu.printers"),
            note: openSerial,
            current: true,
            action: () => {},
        });
    }

    return choices;
}

function openPrinterLog(printer, trace = false) {
    const query = `serial=${encodeURIComponent(printer.id)}&name=${encodeURIComponent(printer.name)}`;
    window.location.href = `logs.html?${query}${trace ? "&stream=mqtt" : ""}`;
}

/**
 * Tells the bar which printer the dashboard ended up showing.
 *
 * The dashboard decides that itself on the first load, from what was picked
 * last or from the first printer in the list, so the picker would otherwise
 * name one printer while the page shows another.
 *
 * @param {string} printerId - the serial of the printer being shown
 */
function syncMenuPrinter(printerId) {
    if (!printerId || printerId === sessionStorage.getItem(SELECTED_PRINTER_KEY)) return;
    sessionStorage.setItem(SELECTED_PRINTER_KEY, printerId);
    renderTitlePicker();
}

/**
 * The log menu in the bar: the server log, and one entry per printer by name.
 *
 * Which log is open is marked while the log viewer is the page, so the menu
 * answers "which one am I looking at" as well as "which ones are there".
 */
function renderLogEntries() {
    const panel = document.getElementById("menu-logs-panel");
    if (!panel) return;

    const params = new URLSearchParams(window.location.search);
    const onLogs = currentPage() === "logs";
    const openSerial = onLogs ? params.get("serial") : null;
    const serverOpen = onLogs && !openSerial;

    panel.innerHTML = "";
    panel.appendChild(panelEntry(t("menu.server"), () => {
        window.location.href = "logs.html?name=server";
    }, { current: serverOpen }));

    if (!menuPrinters.length) return;

    panel.appendChild(panelHeading(t("menu.printers")));
    for (const printer of menuPrinters) {
        panel.appendChild(panelEntry(printer.name, () => openPrinterLog(printer), {
            current: printer.id === openSerial,
        }));
    }
}

/**
 * Remembers the pick and hands it to the page. A page that does not handle it
 * itself, the log viewer and the settings page, goes to the dashboard, which
 * then opens the remembered printer.
 */
function selectMenuPrinter(printer) {
    sessionStorage.setItem(SELECTED_PRINTER_KEY, printer.id);

    if (menuOptions.onPrinterSelect?.(printer) === true) {
        // The page switched in place, so the headline has to follow: the name
        // and the mark in the panel both name the printer being shown.
        renderTitlePicker();
        return;
    }

    window.location.href = "index.html";
}

/** The printer the bar refers to: the last picked one, else the first. */
function currentMenuPrinter() {
    const lastId = sessionStorage.getItem(SELECTED_PRINTER_KEY);
    return menuPrinters.find(printer => printer.id === lastId) ?? menuPrinters[0] ?? null;
}

function setupDarkMode() {
    // The inline script in the page head already put the class on <html> before
    // the first paint; here the icon and the toggle only catch up with it.
    const root = document.documentElement;
    const toggleButton = document.getElementById("dark-mode-toggle");
    const icon = document.getElementById("dark-mode-icon");
    if (!toggleButton || !icon) return;

    if (root.classList.contains("dark-mode")) icon.innerHTML = DARK_MODE_ICON;

    // Added late so the theme does not animate in on every page load.
    setTimeout(() => root.classList.add("transition-enabled"), 100);

    toggleButton.addEventListener("click", () => {
        const enabled = root.classList.toggle("dark-mode");
        icon.innerHTML = enabled ? DARK_MODE_ICON : LIGHT_MODE_ICON;
        localStorage.setItem("dark-mode", enabled);
    });
}
