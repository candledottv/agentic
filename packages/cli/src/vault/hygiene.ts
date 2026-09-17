/**
 * Ember Phase 2 (BE-136, CC-04): the memory-hygiene helpers, and the seam T36 asserts through.
 *
 * What these buy is a BOUND on how long a secret this CLI allocated stays readable, not
 * zeroization. CC-04 lists what the runtime does not let us promise (an immutable JavaScript
 * string cannot be zeroed; Argon2's 64 MiB working buffer belongs to the library; BoringSSL frees
 * rather than provably wipes a non-extractable key; a collector may copy a backing store). None of
 * that is fixable from here, so the code does the part it owns and the documentation says the
 * rest, which is the claim the spec asks a reviewer to test.
 *
 * The part it owns: every secret this CLI allocates is a `Uint8Array` it holds, and every one is
 * filled with zero in a `finally` the moment its use ends. `withSecret` and `withSecrets` are the
 * only way that happens, so "did this path zero its buffers?" is a question about call sites
 * rather than about scattered `try`/`finally` blocks.
 *
 * `trackSecrets` is the test seam. Production never calls it, so the registry stays empty and
 * costs nothing; a test switches it on, runs a command, and asserts that every buffer the run
 * allocated through here is zero afterwards. That is an assertion about the real code path rather
 * than about a mock of it.
 */

/** Overwrites `bytes` with zero. Safe on a zero-length array and on a view into a larger buffer. */
export function wipe(...buffers: (Uint8Array | undefined | null)[]): void {
  for (const buffer of buffers) {
    if (buffer) buffer.fill(0)
  }
}

interface SecretRegistry {
  /** Every buffer allocated through `secretBuffer` / `withSecret` while tracking was on. */
  allocated: Uint8Array[]
}

let registry: SecretRegistry | null = null

/**
 * Records every secret buffer allocated until the returned handle is stopped. Test-only (T36).
 * Returns the recorded buffers so a test can assert each is zero once the command has finished.
 */
export function trackSecrets(): { stop: () => Uint8Array[] } {
  const own: SecretRegistry = { allocated: [] }
  const previous = registry
  registry = own
  return {
    stop: () => {
      registry = previous
      return own.allocated
    },
  }
}

/** Allocates a zero-filled secret buffer of `length`, registering it when tracking is on. */
export function secretBuffer(length: number): Uint8Array {
  const buffer = new Uint8Array(length)
  registry?.allocated.push(buffer)
  return buffer
}

/** Takes ownership of `bytes` as a secret: registers it for T36 and returns it unchanged. */
export function ownSecret(bytes: Uint8Array): Uint8Array {
  registry?.allocated.push(bytes)
  return bytes
}

/**
 * Runs `use` with `secret` and zeroes it afterwards, whether `use` returned or threw.
 *
 * The result must not BE the secret (or a view onto it), which is why the callers that need to
 * hand a derived value onwards copy it inside `use` rather than returning the buffer.
 */
export async function withSecret<T>(secret: Uint8Array, use: (secret: Uint8Array) => Promise<T> | T): Promise<T> {
  ownSecret(secret)
  try {
    return await use(secret)
  } finally {
    wipe(secret)
  }
}

/** `withSecret` for several buffers at once; all of them are zeroed, in order, on the way out. */
export async function withSecrets<T>(secrets: Uint8Array[], use: () => Promise<T> | T): Promise<T> {
  for (const secret of secrets) ownSecret(secret)
  try {
    return await use()
  } finally {
    wipe(...secrets)
  }
}
