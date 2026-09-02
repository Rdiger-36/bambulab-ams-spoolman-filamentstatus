/**
 * Prints the filament profile table in `public/materials.js` from a local
 * Bambu Studio installation.
 *
 * The AMS reports a slot's profile as `tray_info_idx`, a Bambu Studio filament
 * id such as "GFA05". The id says which filament the spool is, the tag does not
 * carry the material on its own, and Bambu Studio is where the two are tied
 * together: every system filament profile carries `filament_id` and, somewhere
 * up its `inherits` chain, `filament_type`.
 *
 * Run it against a Bambu Studio installation and paste the output into
 * `public/materials.js` when Bambu ships new filaments:
 *
 *   node scripts/extract-bambu-profiles.js "/Applications/BambuStudio.app/Contents/Resources/profiles/BBL/filament"
 *
 * This script is outside the service, so the plain console is correct here.
 */

import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2]
    || "/Applications/BambuStudio.app/Contents/Resources/profiles/BBL/filament";

/** Every JSON below the profile directory, by its declared profile name. */
function readProfiles(root) {
    const byName = new Map();

    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith(".json")) continue;

            try {
                const profile = JSON.parse(fs.readFileSync(full, "utf-8"));
                byName.set(profile.name ?? entry.name.replace(/\.json$/, ""), profile);
            } catch {
                // A profile this version cannot parse is one profile missing
                // from the table, not a reason to abandon the other 1900.
            }
        }
    };

    walk(root);
    return byName;
}

/**
 * Reads a field off a profile or, where it does not set one itself, off the
 * profile it inherits from. `filament_type` usually sits on the shared base
 * ("fdm_filament_pla"), several levels above the profile carrying the id.
 */
function inherited(profile, key, byName, depth = 0) {
    let current = profile;
    while (current && depth < 10) {
        if (key in current) return current[key];
        current = byName.get(current.inherits);
        depth += 1;
    }
    return null;
}

const byName = readProfiles(dir);
const table = new Map();

for (const profile of byName.values()) {
    const id = profile.filament_id;
    if (!id || table.has(id)) continue;

    const type = inherited(profile, "filament_type", byName);
    table.set(id, {
        name: (profile.name ?? "").replace(/ @base$/, ""),
        material: Array.isArray(type) ? type[0] : type,
    });
}

const rows = [...table.entries()]
    .filter(([, entry]) => entry.material)
    .sort(([a], [b]) => a.localeCompare(b));

console.log(`// ${rows.length} profiles read from ${dir}`);
for (const [id, entry] of rows) {
    console.log(`    ${id}: { material: "${entry.material}", name: "${entry.name}" },`);
}
