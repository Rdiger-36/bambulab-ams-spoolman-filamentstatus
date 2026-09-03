// Shared mutable runtime state accessed by multiple modules
export const state = {
    spoolmanStatus: "Disconnected",
    vendorID: null,
    clients: [],       // SSE client connections
    // Last known Spoolman spool list for change detection. null means "not yet
    // seeded". Deliberately not [], which is a legitimate value for an empty
    // Spoolman and must still be comparable against the next fetch.
    lastSpoolData: null,
    // Startup bookkeeping. The monitor loops must be started exactly once, and
    // the Spoolman bootstrap must not run twice in parallel when the endpoint is
    // changed repeatedly in the Web UI.
    monitorsRunning: false,
    spoolmanBootstrapRunning: false,
    // The SpoolmanDB catalogue, kept for the create-spool dialog. It is around
    // seven thousand entries and a few megabytes, the dialog queries it while
    // the user types, and it changes about as often as Spoolman ships a
    // release, so it is fetched once and reused rather than pulled per request.
    externalFilamentCache: { fetchedAt: 0, entries: [] },
    // Request refusals already written to the server log, see security.js. A
    // Web UI left open on a refused host retries forever, so each distinct
    // reason is logged once instead of on every attempt.
    refusedRequestsLogged: new Set(),
};
