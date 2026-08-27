// Shared mutable runtime state accessed by multiple modules
export const state = {
    spoolmanStatus: "Disconnected",
    vendorID: null,
    clients: [],       // SSE client connections
    // Last known Spoolman spool list for change detection. null means "not yet
    // seeded" — deliberately not [], which is a legitimate value for an empty
    // Spoolman and must still be comparable against the next fetch.
    lastSpoolData: null,
};
