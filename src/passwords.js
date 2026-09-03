import crypto from "crypto";

/**
 * Hashing and verification of the Web UI password.
 *
 * Its own module rather than part of `auth.js`, because `settings.js` needs it
 * too: a password arrives in clear text, from the settings page or from the
 * environment variable that seeds it, and what is stored and compared is never
 * anything but the hash. `settings.js` must not import `logger.js`, so nothing
 * here may import anything at all beyond node's own crypto.
 *
 * scrypt is what node offers without a dependency, and it is memory hard, which
 * is the property that matters against somebody working through a word list
 * with a copy of `settings.json`.
 */

// Cost parameters, written into every hash so that raising them later still
// leaves the passwords already stored verifiable.
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELISATION = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** Marks the stored format, so a stored hash is never mistaken for a password. */
const PREFIX = "scrypt";

/**
 * Hashes a password for storage.
 *
 * @param {string} plain - the password as it was typed
 * @returns {string} `scrypt$cost$blockSize$parallelisation$salt$key`, all hex
 */
export function hashPassword(plain) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = crypto.scryptSync(String(plain), salt, KEY_LENGTH, {
        N: COST,
        r: BLOCK_SIZE,
        p: PARALLELISATION,
        // Node refuses the default memory limit at this cost, so it is raised to
        // what these parameters actually need, about 32 MB.
        maxmem: 64 * 1024 * 1024,
    });

    return [PREFIX, COST, BLOCK_SIZE, PARALLELISATION, salt.toString("hex"), key.toString("hex")].join("$");
}

/**
 * Whether a value is already a stored hash rather than a password.
 *
 * This is what keeps a settings file from being hashed a second time every time
 * it is read back, and it is why the format carries a prefix.
 *
 * @param {*} value - a stored or incoming value
 */
export function isPasswordHash(value) {
    return typeof value === "string" && /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/.test(value);
}

/**
 * Checks a typed password against a stored hash.
 *
 * The comparison is time constant, so the answer does not say how much of the
 * password was right.
 *
 * @param {string} plain - the password as it was typed
 * @param {string} stored - the value from the settings
 * @returns {boolean} false for anything malformed, never an exception
 */
export function verifyPassword(plain, stored) {
    if (!isPasswordHash(stored) || typeof plain !== "string" || plain === "") return false;

    const [, cost, blockSize, parallelisation, saltHex, keyHex] = stored.split("$");
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(keyHex, "hex");

    let actual;
    try {
        actual = crypto.scryptSync(plain, salt, expected.length, {
            N: Number(cost),
            r: Number(blockSize),
            p: Number(parallelisation),
            maxmem: 64 * 1024 * 1024,
        });
    } catch {
        return false;
    }

    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
