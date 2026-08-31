/**
 * The decision the supervisor in `entrypoint.js` makes when the service ends.
 *
 * Kept here, and free of any import, so it can be unit tested without spawning
 * a process. The supervisor itself only forks, forwards signals and logs.
 */

/**
 * Exit code the service uses to ask for a restart.
 *
 * 75 is EX_TEMPFAIL from sysexits, which reads as "temporary failure, try
 * again" and is far enough from the codes Node produces on its own that it
 * cannot be confused with a crash. It is deliberately not 0: a container with
 * `restart: on-failure` restarts on a non zero code, so a requested restart
 * still works for someone running without the supervisor.
 */
export const RESTART_EXIT_CODE = 75;

/** How many restarts are allowed inside RESTART_WINDOW_MS before giving up. */
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 60000;

/**
 * Whether the service should be started again after it ended.
 *
 * Only a requested restart is handled here. Every other exit is passed on to
 * whatever runs the container, so a crash keeps meaning what it means today and
 * the Docker restart policy stays in charge of it. Having both layers restart
 * on a crash would nest two loops inside each other.
 *
 * @param {number|null} code - exit code of the service, null when it was signalled
 * @param {number[]} recentRestarts - timestamps of the restarts so far
 * @param {number} [now] - current time, injected by the test
 * @returns {{restart: boolean, reason: string}}
 */
export function shouldRestart(code, recentRestarts = [], now = Date.now()) {
    if (code !== RESTART_EXIT_CODE) {
        return { restart: false, reason: "not a restart request" };
    }

    const recent = recentRestarts.filter(at => now - at < RESTART_WINDOW_MS);
    if (recent.length >= MAX_RESTARTS) {
        return {
            restart: false,
            reason: `${recent.length} restarts within ${RESTART_WINDOW_MS / 1000} seconds, giving up`,
        };
    }

    return { restart: true, reason: "restart requested" };
}
