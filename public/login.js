// The login page. Deliberately standalone: it is one of the few files served
// before anybody is logged in, so it imports nothing from the rest of the UI.
// The translation layer is the exception: the page loads it in its head like
// every other page, and `t` is read off the global scope.

// The moon and the sun of the theme button, the same drawings as in menu.js.
// Copied rather than shared, for the reason above: this page cannot load that
// script.
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
 * The theme button of this page's bar. The inline script in the head already
 * put the class on <html> before the first paint; here the icon and the
 * button only catch up with it, the way menu.js does on every other page.
 */
function setupDarkMode() {
    const root = document.documentElement;
    const button = document.getElementById("dark-mode-toggle");
    const icon = document.getElementById("dark-mode-icon");
    if (!button || !icon) return;

    icon.innerHTML = root.classList.contains("dark-mode") ? DARK_MODE_ICON : LIGHT_MODE_ICON;
    setTimeout(() => root.classList.add("transition-enabled"), 100);

    button.addEventListener("click", () => {
        const enabled = root.classList.toggle("dark-mode");
        icon.innerHTML = enabled ? DARK_MODE_ICON : LIGHT_MODE_ICON;
        try {
            localStorage.setItem("dark-mode", enabled);
        } catch {
            // Storage blocked: the theme lasts for this page only
        }
    });
}

/**
 * The language menu of this page's bar: every language that has a table, the
 * shown one ticked. The settings page, where the language is picked once
 * logged in, is behind the password this page asks for, so the choice has to
 * be offered here as well. A pick reloads the page in that language, see
 * I18N.setLanguage. Left out while there is only one language.
 */
function setupLanguageMenu() {
    const button = document.getElementById("language-button");
    const panel = document.getElementById("language-panel");
    if (!button || !panel) return;

    const languages = I18N.languages();
    if (languages.length < 2) {
        button.closest(".menu-host").hidden = true;
        return;
    }

    const current = I18N.language();
    for (const [code] of languages) {
        const entry = document.createElement("a");
        entry.href = "#";
        entry.className = "menu-entry";
        entry.textContent = I18N.languageLabel(code);
        if (code === current) entry.setAttribute("aria-current", "true");
        entry.addEventListener("click", event => {
            event.preventDefault();
            I18N.setLanguage(code);
        });
        panel.appendChild(entry);
    }

    const setOpen = open => {
        button.setAttribute("aria-expanded", String(open));
        panel.hidden = !open;
    };

    button.addEventListener("click", event => {
        event.stopPropagation();
        setOpen(panel.hidden);
    });
    document.addEventListener("click", event => {
        if (!event.target.closest("#language-panel")) setOpen(false);
    });
    document.addEventListener("keydown", event => {
        if (event.key !== "Escape" || panel.hidden) return;
        setOpen(false);
        button.focus();
    });
}

document.addEventListener("DOMContentLoaded", () => {
    setupDarkMode();
    setupLanguageMenu();
    document.getElementById("login-year").textContent = String(new Date().getFullYear());

    const form = document.getElementById("login-form");
    const password = document.getElementById("login-password");
    const submit = document.getElementById("login-submit");
    const error = document.getElementById("login-error");

    /** Shows a message under the button, or clears it. */
    function showError(message) {
        error.textContent = message || "";
        error.hidden = !message;
    }

    /**
     * Where to go after a successful login.
     *
     * The "next" parameter comes from a redirect this service produced, but it
     * arrives through the address bar and is therefore treated as if it came
     * from anywhere: only a path on this same installation is followed, never
     * an address somewhere else.
     */
    function destination() {
        const next = new URLSearchParams(window.location.search).get("next");
        if (next && next.startsWith("/") && !next.startsWith("//")) return next;
        return "index.html";
    }

    form.addEventListener("submit", async event => {
        event.preventDefault();
        showError("");
        submit.disabled = true;

        try {
            const res = await fetch("./api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password: password.value }),
            });
            const body = await res.json().catch(() => ({}));

            if (!res.ok) {
                showError(I18N.errorText(body, res.status));
                password.select();
                return;
            }

            window.location.href = destination();
        } catch {
            // Only a request that never got an answer lands here, and the
            // browser's own message for that says less than this one
            showError(t("login.noAnswer"));
        } finally {
            submit.disabled = false;
        }
    });
});
