import { serverLogFilePath } from "./config.js";
import { settings } from "./settings.js";
import { state } from "./state.js";

/**
 * Request guard for everything this service serves.
 *
 * The Web UI has no authentication and is meant for a trusted local network,
 * but "trusted local network" does not include every page the user happens to
 * have open in the same browser. Two attacks reach a LAN service from outside
 * without the port being exposed at all, and this module closes both.
 *
 * The first is a plain cross origin request. It used to succeed because the app
 * answered with `Access-Control-Allow-Origin: *`, which is the explicit
 * instruction to the browser to hand the response to any page that asks. The
 * fix for that one is not here, it is the removed `cors()` in backend.js: the
 * Web UI is served by the same Express app under the same origin and never
 * needed it.
 *
 * The second is DNS rebinding, which the same origin policy cannot see. The
 * attacker points a name they own at their own server, the browser loads a page
 * from it, the name is then re-resolved to the address of this service and the
 * page keeps calling what the browser still considers its own origin. Nothing
 * in the browser separates that from a legitimate request, and a session cookie
 * would travel with it. What does separate it is the `Host` header, which
 * carries the name the request was addressed to rather than the address it
 * arrived at, so a rebound request announces the attacker's name.
 *
 * Hence the rule below: a host that cannot be rebound is allowed, anything else
 * has to be named in the ALLOWED_HOSTS setting.
 */

/** Methods that change something and therefore need the origin check as well. */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Splits the comma separated ALLOWED_HOSTS value into host names.
 *
 * Entries are lowercased and may carry a port, which is dropped: the port a
 * request arrives on is decided by the container mapping and says nothing about
 * who addressed it.
 *
 * @param {string|undefined} raw - Raw setting value.
 * @returns {string[]} Host names, without ports, empty when nothing is set.
 */
export function parseAllowedHosts(raw) {
    if (!raw) return [];
    return raw
        .split(",")
        .map(entry => hostname(entry.trim().toLowerCase()))
        .filter(Boolean);
}

/**
 * Strips the port and the IPv6 brackets off a host value.
 *
 * Handles the three shapes a `Host` header can carry: `name`, `name:port` and
 * the bracketed `[::1]:port` an IPv6 address needs so that its colons cannot be
 * read as a port separator.
 *
 * @param {string} value - Host header or a single entry of the setting.
 * @returns {string} Bare host name or address, lowercased.
 */
function hostname(value) {
    if (!value) return "";
    const lower = value.toLowerCase();
    if (lower.startsWith("[")) {
        const end = lower.indexOf("]");
        return end === -1 ? "" : lower.slice(1, end);
    }
    return lower.split(":")[0];
}

/**
 * Whether a host is a literal IP address rather than a name.
 *
 * This is the whole point of the check: an address cannot be rebound, because
 * there is no DNS lookup in front of it that an attacker could answer. Anything
 * reaching this service under an IP was addressed to this service.
 *
 * @param {string} host - Bare host, already lowercased.
 */
function isIpLiteral(host) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        return host.split(".").every(part => Number(part) <= 255);
    }
    // Bracketed IPv6 arrives here without its brackets, so a colon is enough to
    // tell it apart from a name. The zone id a link local address carries after
    // a percent sign is an interface name and not part of the address, so it is
    // cut off before the groups are checked.
    const address = host.split("%")[0];
    return address.includes(":") && /^[0-9a-f:.]+$/.test(address);
}

/**
 * Whether a request addressed to this host is accepted.
 *
 * Allowed without configuration:
 *
 * - Literal IP addresses, see `isIpLiteral()`.
 * - `localhost` and anything under `.localhost`, which resolve to the loopback
 *   address by definition and are what a container maps its port onto.
 * - `.local` names. They are mDNS, answered on the local link rather than by a
 *   DNS server somewhere, so the attacker in the rebinding scenario cannot
 *   answer for one. This is how most installations are actually reached
 *   (`homeassistant.local`, `raspberrypi.local`) and blocking it by default
 *   would lock those users out of their own Web UI.
 *
 * Everything else is a name resolved through ordinary DNS and has to be listed
 * in the ALLOWED_HOSTS setting, which is what an installation behind a reverse
 * proxy or under a real domain sets.
 *
 * @param {string|undefined} hostHeader - Raw `Host` header of the request.
 * @param {string[]} allowList - Result of `parseAllowedHosts()`.
 */
export function isAllowedHost(hostHeader, allowList) {
    const host = hostname(hostHeader);
    // HTTP/1.1 requires the header. Something that omits it is not a browser
    // and not the Web UI.
    if (!host) return false;
    if (isIpLiteral(host)) return true;
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (host.endsWith(".local")) return true;
    return allowList.includes(host);
}

/**
 * Whether a writing request comes from the Web UI of this same installation.
 *
 * A missing `Origin` is accepted: a browser sends it on every request that
 * could be cross site, so its absence means the caller is not a browser. Those
 * are curl, a shell script and a home automation calling the API on purpose,
 * and they are not the attack this guards against.
 *
 * The scheme is deliberately not compared. Behind a TLS terminating reverse
 * proxy the browser sends `https://name` while the request reaches this service
 * as plain HTTP, and the host is the part that carries the identity.
 *
 * A name from the allow list is accepted as well, not only a literal match on
 * the `Host` header. A reverse proxy that rewrites the header, which is what
 * nginx does unless it is told to pass `$host` through, leaves the browser's
 * name in `Origin` and its own in `Host`, and the two would never agree. That
 * makes the setting the single place such an installation is configured.
 *
 * @param {string|undefined} originHeader - Raw `Origin` header.
 * @param {string|undefined} hostHeader - Raw `Host` header.
 * @param {string[]} [allowList] - Result of `parseAllowedHosts()`.
 */
export function isSameOrigin(originHeader, hostHeader, allowList = []) {
    if (!originHeader) return true;
    // A sandboxed iframe and a few redirect cases send the literal string
    // "null", which is not an origin this service can recognise.
    if (originHeader === "null") return false;
    let origin;
    try {
        origin = new URL(originHeader);
    } catch {
        return false;
    }
    if (origin.host.toLowerCase() === String(hostHeader || "").toLowerCase()) return true;
    return allowList.includes(origin.hostname.toLowerCase());
}

/**
 * Builds the guard middleware.
 *
 * Registered in front of everything, the static files included: a user whose
 * host is refused should be told so when they open the page, rather than
 * getting a Web UI in which every call fails for a reason the browser does not
 * explain.
 *
 * The allow list is read per request rather than captured here, because the
 * setting is edited in the Web UI and a captured copy would keep the value the
 * process started with. That the setting sits behind the guard it configures is
 * deliberate: a request that could change it has to pass the guard first, and
 * an installation that locks itself out of a name is still reachable under the
 * IP address of its host, which is never refused.
 *
 * @returns {function} Express middleware.
 */
export function hostGuard() {
    return (req, res, next) => {
        const allowList = parseAllowedHosts(settings.ALLOWED_HOSTS);

        if (!isAllowedHost(req.headers.host, allowList)) {
            return refuse(req, res,
                `Host "${req.headers.host || "(none)"}" is not allowed. Reach this service under its IP address, or add the name to "Allowed host names" on the settings page.`,
                `[Security] Refused a request for host "${req.headers.host || "(none)"}". Add it to ALLOWED_HOSTS to allow it.`);
        }

        if (WRITE_METHODS.has(req.method) && !isSameOrigin(req.headers.origin, req.headers.host, allowList)) {
            return refuse(req, res,
                "The request came from another site.",
                `[Security] Refused a ${req.method} from origin "${req.headers.origin}" for host "${req.headers.host}".`);
        }

        next();
    };
}

/**
 * Answers a refused request and logs it once per distinct reason.
 *
 * The log line is what turns a locked out installation into a one line answer
 * in a bug report, but a Web UI left open retries its event stream forever, so
 * repeating it would bury the log. The set of what has already been said lives
 * in `state.js` because nothing else may hold mutable state.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @param {string} message - What the caller is told.
 * @param {string} logLine - What the server log gets, once.
 */
function refuse(req, res, message, logLine) {
    if (!state.refusedRequestsLogged.has(logLine)) {
        state.refusedRequestsLogged.add(logLine);
        console.log("Server", serverLogFilePath, logLine);
    }

    // The frontend's fetchJson() expects { ok, error }; a browser that was sent
    // to the wrong address by a bookmark gets a sentence it can read.
    if (req.path.startsWith("/api/")) {
        return res.status(403).json({ ok: false, error: message });
    }
    res.status(403).type("text/plain").send(`${message}\n`);
}
