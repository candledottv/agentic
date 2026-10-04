/**
 * A cross-process exclusive lock, for the read-modify-write cycles that share one file.
 *
 * credentials.enc and wallets.enc are each a SINGLE json document holding every entry, so a write
 * is read-whole, modify-one, write-whole. Two of those interleaving is not a torn file (the write
 * itself is atomic via rename) but a LOST ENTRY: both readers see the same starting state, both
 * add their own ref, and whichever renames second silently drops the other's. Running `candle keys
 * create` in one terminal while `candle auth login` finishes in another is enough.
 *
 * O_EXCL is the primitive because the guarantee has to hold across PROCESSES, which an in-memory
 * mutex cannot do. A lock older than STALE_MS is broken rather than waited on, so a process killed
 * while holding one does not wedge the CLI for the next operator; the window is long enough that
 * no honest holder is mistaken for a corpse.
 *
 * node:fs is imported lazily inside the function, matching secret-store.ts: importing this module
 * must not drag a filesystem dependency into a bundle that only wanted InMemorySecretStore.
 */
export declare function withFileLock<T>(target: string, fn: () => Promise<T>): Promise<T>;
//# sourceMappingURL=file-lock.d.ts.map