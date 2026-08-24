/**
 * secret-store: pluggable storage for an agent's P-256 signer private key (Agent Pilot Phase 3).
 *
 * Phase 3 lets a headless agent sign for its own linked wallets by holding the P-256 signer key
 * (`generateSignerKeypair`'s `privateKeyPem`, wallet-import.ts) client-side, not on Candle's
 * servers. Candle never sees this key; the SDK is where it has to live instead, so this module
 * defines where and how. A later task (one-shot trade / selfLaunch) loads the key from a
 * `SecretStore` by `walletRef` to compute the signature at call time.
 *
 * Two implementations ship here:
 *   - `InMemorySecretStore`: a plain `Map`, universal (browser or Node), for tests and ephemeral
 *     agent runs that re-import or re-generate the key each process start.
 *   - `EncryptedFileSecretStore`: AES-GCM-at-rest via WebCrypto, keyed from a passphrase through
 *     PBKDF2, Node-only (it touches the filesystem via `node:fs/promises`).
 *
 * An OS-keychain-backed store (macOS Keychain / libsecret / Windows Credential Manager) is
 * deliberately NOT included here -- it is Node/CLI-specific and belongs to a later phase (Phase
 * 4). Implement `SecretStore` for it then.
 */
/**
 * Storage for an agent's signer private-key PEM, keyed by `walletRef` (the caller's stable
 * handle for a linked wallet: its `linkedWalletId` or its address). Implementations decide the
 * medium (memory, an encrypted file, later an OS keychain) but must agree on this shape.
 *
 * Deliberately excluded from this module: an OS-keychain implementation. That store is
 * Node/CLI-specific (macOS Keychain, libsecret, Windows Credential Manager) and is planned for
 * Phase 4, not Phase 3 -- implement this interface against it there rather than here.
 */
export interface SecretStore {
    /** Returns the stored PEM for `walletRef`, or `null` if nothing is stored under that ref. */
    get(walletRef: string): Promise<string | null>;
    /** Stores `privateKeyPem` under `walletRef`, replacing any previous value for that ref. */
    set(walletRef: string, privateKeyPem: string): Promise<void>;
    /** Removes any stored value for `walletRef`. A no-op if nothing was stored under it. */
    delete(walletRef: string): Promise<void>;
}
/**
 * A plain in-memory `SecretStore`. Works identically in a browser or Node (no filesystem, no
 * platform APIs), which makes it the right default for tests and for ephemeral agent runs that
 * are fine re-deriving or re-importing the key on every process start. Nothing here survives
 * process exit.
 */
export declare class InMemorySecretStore implements SecretStore {
    private readonly entries;
    get(walletRef: string): Promise<string | null>;
    set(walletRef: string, privateKeyPem: string): Promise<void>;
    delete(walletRef: string): Promise<void>;
}
/**
 * A `SecretStore` backed by a single encrypted JSON file, keyed from a passphrase. Node-only (it
 * reads and writes the filesystem via `node:fs/promises`, imported lazily inside each method so
 * that importing `InMemorySecretStore` from this module never drags a `node:fs` dependency into
 * a browser bundle).
 *
 * Crypto construction (WebCrypto, matching wallet-import.ts's use of `crypto.subtle`):
 *   - Key derivation: PBKDF2-HMAC-SHA256, {@link PBKDF2_ITERATIONS} iterations at the time of
 *     writing, a random {@link SALT_LENGTH_BYTES}-byte salt generated fresh for every `set` call.
 *     Both the salt and the iteration count actually used are stored alongside that entry's
 *     ciphertext (not read back from the module constant), so a correct passphrase can always
 *     re-derive the key even after {@link PBKDF2_ITERATIONS} is raised for new entries later.
 *   - Encryption: AES-GCM-256, a random {@link IV_LENGTH_BYTES}-byte IV generated fresh for every
 *     `set` call (never reused across entries or across overwrites of the same entry).
 *   - At rest: one JSON object per file, one salt/iv/iterations/ciphertext record per `walletRef`.
 *     The ciphertext is AES-GCM's own output (ciphertext + auth tag), so a wrong passphrase
 *     derives the wrong key and `crypto.subtle.decrypt` throws on the auth-tag check -- it can
 *     never silently return garbage plaintext instead of the real PEM.
 *
 * Not safe for concurrent writers against the same file: `set` and `delete` both do a
 * read-modify-write of the whole file, so two concurrent calls (same process or different
 * processes) against the same `path` can race and lose one write.
 */
export declare class EncryptedFileSecretStore implements SecretStore {
    private readonly path;
    private readonly passphrase;
    constructor(path: string, passphrase: string);
    get(walletRef: string): Promise<string | null>;
    set(walletRef: string, privateKeyPem: string): Promise<void>;
    delete(walletRef: string): Promise<void>;
    private readFile;
    private writeFile;
}
//# sourceMappingURL=secret-store.d.ts.map