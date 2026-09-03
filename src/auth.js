import crypto from "crypto";

import { apiKeyFromRequest, verifyApiKey } from "./apikeys.js";
import { serverLogFilePath } from "./config.js";
import { verifyPassword } from "./passwords.js";
import { settings } from "./settings.js";
import { state } from "./state.js";

/**
 * The Web UI password.
 *
 * A guard against the browser of the user, which is what `security.js` is, does
 * nothing about the person or the device already standing on the network. This
 * asks for a password before anything is shown, and it is off unless one is
 * set, which is how every installation before it behaved.
 *
 * The session is a cookie the service signs rather than a record it keeps. The
 * signing key is derived from the stored password hash, which buys three things
 * a session table would each have had to implement: a restart does not sign
 * everybody out, changing the password invalidates every session that exists,
 * and there is no table to expire or to grow.
 *
 * What it does not buy is signing another device out from this one. A logout
 * clears the cookie of the browser that asked, and everything else stays valid
 * until it expires or the password changes. For a service on a home network
 * that is the right trade.
 *
 * The second way in is an API key, for the callers that have no browser to log
 * in with. It counts as a session of its own here; `apikeys.js` owns what a key
 * is and how it is stored.
 */

/** Name of the session cookie. */
export const SESSION_COOKIE = "ams_session";

/** How long a session stays valid, in milliseconds. */
const SESSION_LIFETIME = 30 * 24 * 60 * 60 * 1000;

/** Separates the two halves of the cookie value. */
const SEPARATOR = ".";

/**
 * What is served before anybody has logged in.
 *
 * The login page, what it needs to render, and the two endpoints it talks to.
 * Everything else, every page and every API route, is behind the password.
 */
const PUBLIC_PATHS = new Set([
    "/login.html",
    "/login.js",
    "/styles.css",
    "/api/auth/state",
    "/api/auth/login",
    "/api/auth/logout",
]);

/** Failed attempts before an address has to wait, and how long it waits. */
const FREE_ATTEMPTS = 5;
const FIRST_LOCKOUT = 60 * 1000;
const MAX_LOCKOUT = 15 * 60 * 1000;

/** Whether a password is configured, and the Web UI therefore asks for one. */
export function authEnabled() {
    return !!settings.AUTH_PASSWORD;
}

/**
 * The key the session cookie is signed with.
 *
 * Derived from the stored hash, never the hash itself, so a signature cannot be
 * turned back into the value that verifies a password.
 */
function signingKey() {
    return crypto.createHmac("sha256", "ams-session-v1").update(String(settings.AUTH_PASSWORD)).digest();
}

/**
 * Signs a session that expires at the given time.
 *
 * @param {number} expiresAt - epoch milliseconds
 * @returns {string} the cookie value
 */
export function signSession(expiresAt) {
    const signature = crypto.createHmac("sha256", signingKey()).update(String(expiresAt)).digest("hex");
    return `${expiresAt}${SEPARATOR}${signature}`;
}

/**
 * Whether a cookie value is a signature this service produced and still valid.
 *
 * @param {string|undefined} value - the raw cookie value
 * @param {number} [now] - epoch milliseconds, injectable for the tests
 */
export function verifySession(value, now = Date.now()) {
    if (typeof value !== "string" || !value.includes(SEPARATOR)) return false;

    const [expiresAt, signature] = value.split(SEPARATOR);
    if (!/^\d+$/.test(expiresAt) || Number(expiresAt) <= now) return false;

    const expected = signSession(Number(expiresAt)).split(SEPARATOR)[1];
    const a = Buffer.from(String(signature));
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Reads one cookie out of a `Cookie` header.
 *
 * Written here rather than pulled in as a dependency: this is the only cookie
 * this service has, and the header is a semicolon separated list.
 *
 * @param {string|undefined} header - the raw header
 * @param {string} name - the cookie to look for
 * @returns {string|undefined} its value, undefined when it is not there
 */
export function readCookie(header, name) {
    if (typeof header !== "string") return undefined;

    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index === -1) continue;
        if (part.slice(0, index).trim() !== name) continue;
        return decodeURIComponent(part.slice(index + 1).trim());
    }

    return undefined;
}

/**
 * How long this address still has to wait before it may try again.
 *
 * A password on a local network is otherwise worked through with a script in
 * the time it takes to read this sentence. The wait starts after a handful of
 * failures and doubles, and any successful login clears it.
 *
 * @param {string} address - the remote address
 * @param {number} [now] - epoch milliseconds
 * @returns {number} milliseconds left, 0 when the address may try
 */
export function lockoutRemaining(address, now = Date.now()) {
    const record = state.loginFailures.get(address);
    if (!record || !record.until) return 0;
    return Math.max(0, record.until - now);
}

/**
 * Records a failed attempt and starts or extends the wait.
 *
 * @param {string} address - the remote address
 * @param {number} [now] - epoch milliseconds
 */
function recordFailure(address, now = Date.now()) {
    const record = state.loginFailures.get(address) ?? { count: 0, until: 0, lockout: 0 };
    record.count += 1;

    if (record.count > FREE_ATTEMPTS) {
        record.lockout = record.lockout ? Math.min(record.lockout * 2, MAX_LOCKOUT) : FIRST_LOCKOUT;
        record.until = now + record.lockout;
    }

    state.loginFailures.set(address, record);
}

/**
 * Checks a password and, when it fits, produces the session cookie value.
 *
 * @param {string} password - what was typed
 * @param {string} address - the remote address, for the lockout
 * @param {number} [now] - epoch milliseconds
 * @returns {{ok: true, cookie: string, expiresAt: number}|{ok: false, retryAfter: number}}
 *   `retryAfter` is in seconds and 0 when the attempt was simply wrong
 */
export function attemptLogin(password, address, now = Date.now()) {
    const waiting = lockoutRemaining(address, now);
    if (waiting > 0) return { ok: false, retryAfter: Math.ceil(waiting / 1000) };

    if (!verifyPassword(password, settings.AUTH_PASSWORD)) {
        recordFailure(address, now);
        const started = lockoutRemaining(address, now);
        console.log("Server", serverLogFilePath, `[Auth] Failed login from ${address}${started ? `, locked out for ${Math.ceil(started / 1000)} seconds` : ""}`);
        return { ok: false, retryAfter: Math.ceil(started / 1000) };
    }

    state.loginFailures.delete(address);
    const expiresAt = now + SESSION_LIFETIME;
    return { ok: true, cookie: signSession(expiresAt), expiresAt };
}

/**
 * The Set-Cookie attributes of the session cookie.
 *
 * `Secure` is set only on a request that really arrived over HTTPS, because a
 * service reached over plain HTTP on a home network would otherwise hand out a
 * cookie the browser refuses to send back, and nobody could log in at all.
 *
 * @param {object} req - Express request
 * @param {number} maxAgeSeconds - 0 clears the cookie
 */
function cookieOptions(req, maxAgeSeconds) {
    return {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: req.protocol === "https",
        maxAge: maxAgeSeconds * 1000,
    };
}

/** Writes the session cookie onto a response. */
export function setSessionCookie(req, res, value, expiresAt) {
    res.cookie(SESSION_COOKIE, value, cookieOptions(req, Math.floor((expiresAt - Date.now()) / 1000)));
}

/**
 * Hands the caller a session signed with the password that is stored now.
 *
 * Used after the password was changed. The signing key is derived from the
 * hash, so every session that existed a moment ago is void, this one included:
 * without this, setting a password would throw the person who just set it
 * straight back to the login page. They passed whatever stood in front of that
 * change, so giving them a session back is not a hole, it is the same session
 * they already had.
 */
export function issueSession(req, res) {
    const expiresAt = Date.now() + SESSION_LIFETIME;
    setSessionCookie(req, res, signSession(expiresAt), expiresAt);
}

/** Clears the session cookie. */
export function clearSessionCookie(req, res) {
    res.clearCookie(SESSION_COOKIE, cookieOptions(req, 0));
}

/** Whether the request carries a valid session. */
export function isAuthenticated(req) {
    return verifySession(readCookie(req.headers.cookie, SESSION_COOKIE));
}

/**
 * Whether the request carries a valid API key, and notes its use when it does.
 *
 * Checked even while no password is set, where nothing is behind a login
 * anyway: the "last used" column of the key list is what tells the user which
 * key can be revoked, and it would stay empty forever on an installation that
 * has not turned the password on.
 *
 * @param {object} req - Express request
 */
export function authenticatedByApiKey(req) {
    return !!verifyApiKey(apiKeyFromRequest(req));
}

/**
 * The middleware that puts everything behind the password.
 *
 * Registered in front of the static files as well as the API, so a page is not
 * served to somebody who cannot use it. A browser asking for a page is sent to
 * the login page; anything under `/api/` is answered with 401 and the shape the
 * frontend's `fetchJson()` reads, which is what lets an open tab notice that
 * its session ended.
 *
 * An API key is accepted in place of the session. It travels in a header, which
 * a page on another site cannot set on a cross site request without a preflight
 * that `security.js` refuses, so accepting one here does not reopen what the
 * request guard closed.
 *
 * @returns {function} Express middleware
 */
export function requireAuth() {
    return (req, res, next) => {
        // Before the switch below, so a key is noted as used on an installation
        // that has no password set. See authenticatedByApiKey().
        const keyed = authenticatedByApiKey(req);

        if (!authEnabled()) return next();
        if (keyed) return next();
        if (PUBLIC_PATHS.has(req.path)) return next();
        if (isAuthenticated(req)) return next();

        if (req.path.startsWith("/api/")) {
            return res.status(401).json({ ok: false, error: "Not logged in", authRequired: true });
        }

        // Carries where they were going, so the login page can put them back
        // there rather than always on the dashboard.
        res.redirect(302, `/login.html?next=${encodeURIComponent(req.originalUrl)}`);
    };
}
