/**
 * keychain-secret-store: the OS-keychain `SecretStore` secret-store.ts's module doc deferred to
 * "Phase 4", closing the loop with the Candle CLI's wallet import.
 *
 * `candle wallets import` stores each imported wallet's signer private key in the OS keychain:
 * service `tv.candle.cli`, account `wallet_signer_<linkedWalletId>`, value = the PEM's base64
 * body on a single line (the CLI's `pemToStoredSigner` form; a raw PEM contains newlines, which
 * the CLI's macOS write path refuses by design). This store reads that exact contract, so an SDK
 * agent on the same machine picks up CLI-imported wallets with zero manual key handling:
 *
 *   const store = KeychainSecretStore.detect()
 *   const candle = new CandleClient({ apiKey, privyAppId, secretStore: store ?? undefined })
 *   await candle.trade({ ..., from: { linkedWalletId, privyWalletId } })
 *
 * `get()` re-armors the stored single-line value into standard PEM, which is what the signing
 * path (`buildPrivyAuthorizationSignature`) consumes. `set()` accepts a PEM and stores the
 * single-line form, so writes from either side stay format-compatible. Node-only (spawns
 * `security` on macOS, `secret-tool` on Linux), like `EncryptedFileSecretStore`; browser and
 * ephemeral runs keep using `InMemorySecretStore`.
 *
 * Secrets travel exclusively via the child's STDIN or its stdout, never argv, mirroring the
 * CLI's own stores: macOS `security` only takes secrets as a `-w` argv flag in its normal form,
 * so writes go through `security -i` (command-on-stdin mode) instead. BOTH interpolated halves of
 * that command line are checked rather than assumed: `assertStorable` for the `-w "<value>"` token
 * and `assertSafeRef` for the `-a "<ref>"` one. The value check alone is not enough, and saying so
 * here is the point: this doc previously reasoned only about the value, and the unchecked ref was
 * a command-injection path through `security -i` for anything that could influence a wallet id.
 */
import type { SecretStore } from "./secret-store";
export interface ExecResult {
    status: number;
    stdout: string;
}
export type ExecFn = (binary: string, args: string[], stdin?: string) => Promise<ExecResult>;
export declare class KeychainSecretStore implements SecretStore {
    private readonly backend;
    private readonly exec;
    constructor(opts?: {
        backend?: "security" | "secret-tool";
        exec?: ExecFn;
    });
    /**
     * The store for this machine, or `null` when no OS keychain tool is on `PATH` (fall back to
     * `EncryptedFileSecretStore` or `InMemorySecretStore` then). Presence-only: a resolvable
     * binary whose daemon is down surfaces later as `get() === null`, which every caller already
     * handles as "no signer stored".
     */
    static detect(): KeychainSecretStore | null;
    get(walletRef: string): Promise<string | null>;
    set(walletRef: string, privateKeyPem: string): Promise<void>;
    delete(walletRef: string): Promise<void>;
}
//# sourceMappingURL=keychain-secret-store.d.ts.map