/**
 * English, the language every key is written in first and the fallback for a
 * key another table does not have. See public/i18n.js.
 *
 * Keys are grouped by the page or the part of a page they belong to. A plural
 * is an object of Intl.PluralRules categories, `{ one, other }` for English.
 */
I18N.register("en", "English", {
    // Menu bar, on every page
    "menu.main": "Main",
    "menu.menu": "Menu",
    "menu.dashboard": "Dashboard",
    "menu.settings": "Settings",
    "menu.logs": "Logs",
    "menu.theme": "Light and dark mode",
    "menu.themeToggle": "Toggle dark mode",
    "menu.language": "Language",
    "menu.logout": "Log out",
    "menu.server": "Server",
    "menu.printers": "Printers",
    "menu.showOnDashboard": "Show on the dashboard",
});
