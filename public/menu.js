// Shared menu bar. Every page renders the same bar into #menu-root, this file
// included the dark mode button, so navigation and the theme behave the same on
// the dashboard, the log viewer and the settings page.
//
// The bar carries two things and no more: where you can go, and your session.
// The three pages sit in it with the current one marked, and the dark mode
// button and, once a password is set, the log out sit at the other end.
//
// What the page is showing does not belong in the bar, it belongs in the page.
// The dashboard headline already names the printer and the log viewer already
// names the log, so those names are the picker: click "Loaded Spools on AMS
// from Bambu P2S" and the printers drop down. That is also what took the
// download button out of the bar; it acts on the log and now sits with it.
//
// Before this, one "Menu" button hid all of it two levels deep, and the log
// entry opened the log of whichever printer had been picked last, which is a
// rule nothing on the screen ever stated.

const LIGHT_MODE_ICON = "https://img.icons8.com/ios-glyphs/30/moon-symbol.png";
const DARK_MODE_ICON = "https://img.icons8.com/color/48/sun--v1.png";

/**
 * The door with the arrow out of it, drawn here rather than fetched.
 *
 * It takes its colour from the entry it sits in, so it follows the theme
 * without a second file, and it is on screen at the same moment as the label
 * rather than whenever an icon host answers.
 */
const LOGOUT_ICON = `
    <svg class="menu-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <path d="M6.5 2.4H3.6c-.7 0-1.2.5-1.2 1.2v8.8c0 .7.5 1.2 1.2 1.2h2.9"
              fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        <path d="M10.4 5.2 13.2 8l-2.8 2.8M13.2 8H6.2"
              fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
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

/** Which of the three pages this is, for the mark in the bar. */
function currentPage() {
    const file = (window.location.pathname.split("/").pop() || "index.html").toLowerCase();
    if (file.startsWith("settings")) return "settings";
    if (file.startsWith("logs")) return "logs";
    return "dashboard";
}

function renderMenubar() {
    const root = document.getElementById("menu-root");
    if (!root) return;

    const page = currentPage();

    root.innerHTML = `
        <nav class="menunav" aria-label="Main">
            <button class="menu-item menu-burger" type="button" id="menu-burger"
                    aria-haspopup="true" aria-expanded="false" aria-controls="menu-pages">
                <span aria-hidden="true">☰</span> Menu
            </button>

            <div class="menu-pages" id="menu-pages">
                <a class="menu-item" href="index.html"${page === "dashboard" ? ' aria-current="page"' : ""}>Dashboard</a>
                <a class="menu-item" href="settings.html"${page === "settings" ? ' aria-current="page"' : ""}>Settings</a>
                <div class="menu-host">
                    <button class="menu-item menu-caret" type="button" id="menu-logs"
                            aria-haspopup="true" aria-expanded="false" aria-controls="menu-logs-panel"
                            ${page === "logs" ? 'aria-current="page"' : ""}>Logs</button>
                    <div class="menu-panel" id="menu-logs-panel" hidden></div>
                </div>
            </div>

            <div class="menu-end">
                <button id="dark-mode-toggle" type="button" title="Light and dark mode">
                    <img id="dark-mode-icon" src="${LIGHT_MODE_ICON}" alt="Toggle dark mode">
                </button>
                <a class="menu-item menu-logout" href="#" id="menu-logout" hidden>${LOGOUT_ICON}Log out</a>
            </div>
        </nav>`;

    setupMenuBehaviour(root);

    document.getElementById("menu-logout").onclick = event => {
        event.preventDefault();
        logout();
    };

    showLogoutWhenLoggedIn();
}

/**
 * Shows the log out entry only where there is a session to end.
 *
 * The entry would otherwise sit in the bar of every installation that never set
 * a password, promising something that does nothing.
 */
async function showLogoutWhenLoggedIn() {
    try {
        const res = await fetch("./api/auth/state");
        if (!res.ok) return;
        const state = await res.json();
        const entry = document.getElementById("menu-logout");
        if (entry) entry.hidden = !state.required;
    } catch {
        // Nothing is shown when the service cannot be asked, which is the same
        // as before this entry existed.
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
 * The picker that lives in the headline of the page.
 *
 * The dashboard headline reads "Loaded Spools on AMS from Bambu P2S" and the
 * log viewer "Backend Logs for: Bambu P2S". Those names are the control: the
 * name a page already writes is the one thing that changes when you pick, so
 * the pick belongs there rather than in the navigation, where it would say the
 * same thing a second time.
 *
 * Both pages give it a mount point of their own, `#printer-name` and
 * `#headline`, and this fills whichever one is on the page.
 */
function renderTitlePicker() {
    const host = document.getElementById(currentPage() === "logs" ? "headline" : "printer-name");
    if (!host) return;

    const onLogs = currentPage() === "logs";
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

    // The serial says which physical machine this is, which is what a log gets
    // attached to a bug report for. Next to the name rather than inside the
    // control, so the thing you click is the name alone.
    if (onLogs && current.note) {
        const note = document.createElement("span");
        note.className = "title-note";
        note.textContent = current.note;
        host.appendChild(note);
    }

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
        panel.appendChild(panelEntry(entry.label, entry.action, { current: entry.current }));
    }

    host.appendChild(panel);
    wirePopupControl(button);
}

/** What the dashboard picker offers: the printers, the shown one marked. */
function printerChoices() {
    const current = currentMenuPrinter();
    return menuPrinters.map(printer => ({
        label: printer.name,
        heading: "Show on the dashboard",
        current: printer.id === current?.id,
        action: () => selectMenuPrinter(printer),
    }));
}

/** What the log viewer's picker offers: the server log and every printer log. */
function logChoices() {
    const params = new URLSearchParams(window.location.search);
    const openSerial = params.get("serial");

    const choices = [{
        label: "Server log",
        current: !openSerial,
        action: () => { window.location.href = "logs.html?name=server"; },
    }];

    for (const printer of menuPrinters) {
        choices.push({
            label: printer.name,
            heading: "Printers",
            note: printer.id,
            current: printer.id === openSerial,
            action: () => openPrinterLog(printer),
        });
    }

    // The log of a printer that was removed while its log is open: the page
    // still shows it, so the picker has to be able to name it.
    if (openSerial && !choices.some(choice => choice.current)) {
        choices.push({
            label: params.get("name") || openSerial,
            heading: "Printers",
            note: openSerial,
            current: true,
            action: () => {},
        });
    }

    return choices;
}

function openPrinterLog(printer) {
    window.location.href = `logs.html?serial=${encodeURIComponent(printer.id)}&name=${encodeURIComponent(printer.name)}`;
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
    const openSerial = currentPage() === "logs" ? params.get("serial") : null;
    const serverOpen = currentPage() === "logs" && !openSerial;

    panel.innerHTML = "";
    panel.appendChild(panelEntry("Server log", () => {
        window.location.href = "logs.html?name=server";
    }, { current: serverOpen }));

    if (!menuPrinters.length) return;

    panel.appendChild(panelHeading("Printers"));
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

    if (root.classList.contains("dark-mode")) icon.src = DARK_MODE_ICON;

    // Added late so the theme does not animate in on every page load.
    setTimeout(() => root.classList.add("transition-enabled"), 100);

    toggleButton.addEventListener("click", () => {
        const enabled = root.classList.toggle("dark-mode");
        icon.src = enabled ? DARK_MODE_ICON : LIGHT_MODE_ICON;
        localStorage.setItem("dark-mode", enabled);
    });
}
