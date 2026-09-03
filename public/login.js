// The login page. Deliberately standalone: it is one of the few files served
// before anybody is logged in, so it imports nothing from the rest of the UI.

document.addEventListener("DOMContentLoaded", () => {
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
                showError(body.error || `HTTP ${res.status}`);
                password.select();
                return;
            }

            window.location.href = destination();
        } catch (err) {
            showError(err.message || "The service did not answer");
        } finally {
            submit.disabled = false;
        }
    });
});
