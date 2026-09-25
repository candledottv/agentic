/**
 * T31 (CC-01, ED-1), T50 (ED-8) and T51 (CC-01 EVM): the format's fail-closed rules.
 *
 * Almost every assertion here is about a file that was edited OUTSIDE this CLI, because that is
 * what the rules are for. `tamper` produces one honestly -- parse, mutate, write back -- rather
 * than hand-assembling bytes, so what is refused is a file something else could really have
 * written.
 *
 * The heart of it is ED-1's construction, and the two cases that broke Draft 1 are the ones to
 * read: a file assembled from the CURRENT header and an EARLIER write's index blob, and the
 * reverse. Both are internally plausible and both must fail the index's AEAD tag before a single
 * key blob is decrypted, whatever the sidecar says, because `generation` is inside the header and
 * the header IS the index's associated data.
 */
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { copyFile, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { readKeystore } from "../wallet-keystore"
import { freshArgon2Params } from "./crypto"
import { VaultError } from "./errors"
import type { Envelope, KeyEntry, VaultFile } from "./format"
import { branchOfPath, parseIndexPlaintext, parseVaultFile } from "./format"
import { commitVault, decryptKey } from "./store"
import { flipByte, makeVault, readVaultJson, reopen, tamper, tempDir, testClock, useCheapKdf } from "./test-vault"

/**
 * These tests run REAL Argon2id, which is the point of them: a vault suite that stubbed the KDF
 * would not be testing the format anyone actually opens. Even at ED-3's bounds floor (see
 * `useCheapKdf`) a single derivation is a few hundred milliseconds, several tests here do five or
 * six of them, and a CI runner sharing a box with every other workspace's suite is slower again.
 * Bun's default per-test budget is 5 s, which one of these exceeded on CI while passing locally --
 * so the budget is stated here rather than discovered once per runner.
 */
setDefaultTimeout(30_000)

useCheapKdf()

/** Runs `body` and returns the `VaultError` it threw, failing the test if it threw anything else. */
/** The first envelope's mutable view, for the tamper cases that edit a KDF field. */
function kdfOf(file: VaultFile): Record<string, unknown> {
  const envelope = file.envelopes[0]
  if (envelope === undefined) throw new Error("the fixture vault has no envelope to tamper with")
  const kdf = (envelope as unknown as Record<string, unknown>).kdf
  if (kdf === undefined || typeof kdf !== "object") throw new Error("the fixture vault's envelope has no kdf record")
  return kdf as Record<string, unknown>
}

async function refusal(body: () => Promise<unknown>): Promise<VaultError> {
  try {
    await body()
  } catch (error) {
    if (error instanceof VaultError) return error
    throw error
  }
  throw new Error("expected a refusal, but the call succeeded")
}

describe("T31: the strict reader refuses everything CC-01 lists, in order, and writes nothing", () => {
  let made: Awaited<ReturnType<typeof makeVault>>
  let original: string

  beforeAll(async () => {
    made = await makeVault()
    original = await readFile(made.path, "utf8")
  })

  test("a file that is not JSON, and one that is not an object", async () => {
    await writeFile(made.path, "not json at all\n", "utf8")
    expect((await refusal(() => reopen(made.path))).code).toBe("VAULT_UNREADABLE")
    await writeFile(made.path, "[]\n", "utf8")
    expect((await refusal(() => reopen(made.path))).code).toBe("VAULT_UNREADABLE")
    await writeFile(made.path, original, "utf8")
  })

  test("an unknown format, and a version other than 2, 3 or 4, each with their own code", async () => {
    await tamper(made.path, (file) => {
      ;(file as unknown as Record<string, unknown>).format = "candle-keystore"
    })
    expect((await refusal(() => reopen(made.path))).code).toBe("VAULT_FORMAT_UNKNOWN")

    await writeFile(made.path, original, "utf8")
    await tamper(made.path, (file) => {
      // Phase 4b made 4 a version this CLI reads; 5 is the next one it does not.
      ;(file as unknown as Record<string, unknown>).version = 5
    })
    expect((await refusal(() => reopen(made.path))).code).toBe("VAULT_VERSION_UNSUPPORTED")

    // R6: version 3 is a version this reader opens, so the number alone is not refused; but the
    // version is inside the canonical header, so a version 2 file EDITED to say 3 fails the index
    // tag rather than being read under the other version's rules. The reverse edit is the same.
    await writeFile(made.path, original, "utf8")
    await tamper(made.path, (file) => {
      ;(file as unknown as Record<string, unknown>).version = 3
    })
    expect((await refusal(() => reopen(made.path))).code).toBe("VAULT_BLOB_TAMPERED")
    await writeFile(made.path, original, "utf8")
  })

  test("a cipher other than AES-256-GCM", async () => {
    await tamper(made.path, (file) => {
      ;(file as unknown as Record<string, unknown>).cipher = "ChaCha20-Poly1305"
    })
    expect((await refusal(() => reopen(made.path))).code).toBe("VAULT_UNREADABLE")
    await writeFile(made.path, original, "utf8")
  })

  test("an unknown top-level field is refused rather than dropped", async () => {
    await tamper(made.path, (file) => {
      ;(file as unknown as Record<string, unknown>).recoveryHint = "the dog's name"
    })
    const error = await refusal(() => reopen(made.path))
    expect(error.code).toBe("VAULT_FIELD_UNKNOWN")
    expect(error.message).toContain("recoveryHint")
    await writeFile(made.path, original, "utf8")
  })

  test("KDF parameters outside ED-3's bounds are refused BEFORE any derivation runs", async () => {
    for (const [field, value] of [
      ["m", 1024],
      ["m", 2_097_152],
      ["t", 1],
      ["t", 32],
      ["p", 8],
      ["version", 16],
    ] as const) {
      await writeFile(made.path, original, "utf8")
      await tamper(made.path, (file) => {
        kdfOf(file)[field] = value
      })
      const started = performance.now()
      const error = await refusal(() => reopen(made.path))
      expect(`${field}=${value} -> ${error.code}`).toBe(`${field}=${value} -> VAULT_KDF_OUT_OF_BOUNDS`)
      // The refusal is what makes a hostile file cheap: asking for 2 GiB must cost nothing. An
      // Argon2 pass at even the floor takes hundreds of milliseconds, so this bound is generous
      // and still proves nothing was derived.
      expect(performance.now() - started).toBeLessThan(150)
    }
    await writeFile(made.path, original, "utf8")
  })

  test("stripping an envelope, adding a foreign one, or editing a KDF parameter fails the index tag", async () => {
    // Each of these changes the canonical header, which IS the index's associated data (ED-1), so
    // each fails the same tag check with the same code: the three causes are indistinguishable by
    // design and CC-01 names all three in one sentence.
    const other = await makeVault({ passphrase: "another vault entirely, sixteen plus" })

    await tamper(made.path, (file) => {
      file.envelopes.push(other.vault.file.envelopes[0] as Envelope)
    })
    expect((await refusal(() => reopen(made.path))).code).toBe("VAULT_BLOB_TAMPERED")

    await writeFile(made.path, original, "utf8")
    await tamper(made.path, (file) => {
      // A salt change keeps the parameters in bounds, so it reaches the index rather than the
      // bounds check -- and it derives a DIFFERENT KEK, so it is caught as an unlock failure first.
      kdfOf(file).salt = freshArgon2Params().salt
    })
    expect((await refusal(() => reopen(made.path))).code).toBe("VAULT_UNLOCK_FAILED")

    await writeFile(made.path, original, "utf8")
    await tamper(made.path, (file) => {
      file.generation = file.generation + 5
    })
    expect((await refusal(() => reopen(made.path))).code).toBe("VAULT_BLOB_TAMPERED")

    await writeFile(made.path, original, "utf8")
    await tamper(made.path, (file) => {
      file.updatedAt = "2020-01-01T00:00:00.000Z"
    })
    expect((await refusal(() => reopen(made.path))).code).toBe("VAULT_BLOB_TAMPERED")
    await writeFile(made.path, original, "utf8")
  })

  test("ED-1's own case: the current header with another write's index blob, and the reverse", async () => {
    // The case that broke Draft 1's header-MAC design. Both files below are assembled from real
    // writes of the SAME vault, so nothing about them is malformed; what fails is that `generation`
    // is inside the header and the header is the index's associated data.
    const before = await readVaultJson(made.path)
    const opened = await reopen(made.path)
    await commitVault(opened, { index: { ...opened.index, hd: { ...opened.index.hd, rootExported: true } } }, testClock)
    const after = await readVaultJson(made.path)
    expect(after.generation).toBe(before.generation + 1)

    const mixedOne: VaultFile = { ...after, index: before.index }
    await writeFile(made.path, `${JSON.stringify(mixedOne, null, 2)}\n`, "utf8")
    const first = await refusal(() => reopen(made.path))
    expect(first.code).toBe("VAULT_BLOB_TAMPERED")
    // And the stale value the older index carried is never observable, which is the whole point:
    // `rootExported` was false in that index and true in the current one.
    expect(first.message).not.toContain("rootExported")

    const mixedTwo: VaultFile = { ...before, index: after.index }
    await writeFile(made.path, `${JSON.stringify(mixedTwo, null, 2)}\n`, "utf8")
    expect((await refusal(() => reopen(made.path))).code).toBe("VAULT_BLOB_TAMPERED")

    await writeFile(made.path, `${JSON.stringify(after, null, 2)}\n`, "utf8")
    original = await readFile(made.path, "utf8")
  })

  test("a key blob or the root blob moved between two vaults fails its own tag", async () => {
    // Each blob's associated data carries the vault id, so a blob is bound to ITS vault even
    // though nothing about its bytes says which one.
    const other = await makeVault({ passphrase: "a second vault, also sixteen plus" })
    const otherFile = await readVaultJson(other.path)

    await tamper(made.path, (file) => {
      file.root = otherFile.root
    })
    const vault = await reopen(made.path)
    // The root is not touched by an ordinary open (ED-5), so this passes every check an open makes
    // -- which is exactly the gap CC-07's verifier exists to close (T43).
    const { decryptRoot } = await import("./store")
    expect((await refusal(() => decryptRoot(vault))).code).toBe("VAULT_BLOB_TAMPERED")

    await writeFile(made.path, original, "utf8")
  })

  test("a flipped byte in a key blob fails that blob's tag, and only when it is read", async () => {
    const withKey = await makeVaultWithKey()
    await tamper(withKey.path, (file) => {
      const blob = file.keys[0] as { ciphertext: string }
      blob.ciphertext = flipByte(blob.ciphertext)
    })
    const vault = await reopen(withKey.path)
    const keyId = vault.index.entries[0]?.id as string
    expect((await refusal(() => decryptKey(vault, keyId))).code).toBe("VAULT_BLOB_TAMPERED")
  })

  test("keyIds and keys[] disagreeing is VAULT_INDEX_INVALID", async () => {
    const withKey = await makeVaultWithKey()
    const kept = await readFile(withKey.path, "utf8")

    await tamper(withKey.path, (file) => {
      file.keyIds = []
    })
    expect((await refusal(() => reopen(withKey.path))).code).toBe("VAULT_BLOB_TAMPERED")

    // Removing the id from BOTH the header and the blob list keeps the header consistent with
    // itself, so the index opens and the disagreement with the index's entries is what refuses.
    await writeFile(withKey.path, kept, "utf8")
    await tamper(withKey.path, (file) => {
      file.keys = []
      file.keyIds = []
    })
    expect((await refusal(() => reopen(withKey.path))).code).toBe("VAULT_BLOB_TAMPERED")
  })

  test("a missing root blob is refused at every open, because the field is required", async () => {
    await tamper(made.path, (file) => {
      ;(file as unknown as Record<string, unknown>).root = undefined
    })
    expect((await refusal(() => reopen(made.path))).code).toBe("VAULT_INDEX_INVALID")
    await writeFile(made.path, original, "utf8")
  })

  test("ED-7: an envelope whose factor this build does not know is KEPT, and the index still opens", async () => {
    await tamper(made.path, (file) => {
      file.envelopes.push({
        id: "AAAAAAAAAAA",
        factor: "quantum-anchor",
        transport: "not-a-thing",
        domain: "hardware-token",
        label: "from a newer CLI",
        createdAt: "2026-09-17T12:00:00.000Z",
        wrap: { alg: "AES-256-GCM", iv: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      } as unknown as Envelope)
    })
    // It changed the header, so the index must be RE-SEALED for the file to open -- which is what
    // adding a factor through this CLI does. Here the point is narrower: the reader does not refuse
    // the unknown factor at parse time, which is what would make PRs E, F and G need a format bump.
    const file = parseVaultFile(await readFile(made.path, "utf8"))
    expect(file.envelopes).toHaveLength(2)
    expect(file.envelopes[1]?.factor).toBe("quantum-anchor")
    // Its `domain` is still read, because CC-03's counting and AD-2's backup rule depend on it.
    expect(file.envelopes[1]?.domain).toBe("hardware-token")
    await writeFile(made.path, original, "utf8")
  })
})

describe("T31: the index schema, which is where most of CC-01's refusals live", () => {
  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))
  const baseHd = {
    scheme: "bip39-24/slip10",
    nextIndex: { solanaVault: 1, solanaTee: 0, evm: 0 },
    rootExported: false,
    exposedIndexes: { solanaVault: [], solanaTee: [], evm: [] },
  }
  const derivedEntry: KeyEntry = {
    id: "k1",
    chain: "solana",
    curve: "ed25519",
    address: "5Pobwp6d9ihN9Nz38f87gVCEBFMgipFiSM2VtUhVit6w",
    label: "one",
    createdAt: "2026-09-17T12:00:00.000Z",
    role: "vault",
    origin: "derived",
    derivation: { scheme: "slip10-ed25519", path: "m/44'/501'/0'/0'" },
    exposure: { everRemoteExposed: false, everExported: false },
  }

  test("a well-formed index parses, which keeps every refusal below meaningful", () => {
    const parsed = parseIndexPlaintext(encode({ hd: baseHd, entries: [derivedEntry] }))
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.hd.nextIndex.solanaVault).toBe(1)
  })

  test("a derived entry without a derivation, and a migrated-tee entry with one", () => {
    const { derivation: _dropped, ...withoutDerivation } = derivedEntry
    expect(() => parseIndexPlaintext(encode({ hd: baseHd, entries: [withoutDerivation] }))).toThrow(
      /derived but records no derivation/,
    )
    const migratedWithDerivation = { ...derivedEntry, origin: "migrated-tee", role: "tee-wallet" }
    expect(() => parseIndexPlaintext(encode({ hd: baseHd, entries: [migratedWithDerivation] }))).toThrow(
      /must not record a derivation/,
    )
  })

  test("a nextIndex at or below a recorded derivation index", () => {
    const hd = { ...baseHd, nextIndex: { ...baseHd.nextIndex, solanaVault: 0 } }
    expect(() => parseIndexPlaintext(encode({ hd, entries: [derivedEntry] }))).toThrow(/at or below the index 0/)
  })

  test("a vault key carrying tee metadata or a linkedWalletId (N3)", () => {
    expect(() =>
      parseIndexPlaintext(
        encode({
          hd: baseHd,
          entries: [{ ...derivedEntry, tee: { network: "solana-mainnet", lifecycle: "enabled" } }],
        }),
      ),
    ).toThrow(/vault key carrying tee metadata/)
    expect(() =>
      parseIndexPlaintext(encode({ hd: baseHd, entries: [{ ...derivedEntry, linkedWalletId: "w1" }] })),
    ).toThrow(/vault key carrying a linkedWalletId/)
  })

  test("a tee-wallet entry with no tee.lifecycle, and a lifecycle outside the five values", () => {
    const tee = { ...derivedEntry, role: "tee-wallet", origin: "migrated-tee", derivation: undefined }
    expect(() => parseIndexPlaintext(encode({ hd: baseHd, entries: [tee] }))).toThrow(/no tee metadata/)
    expect(() =>
      parseIndexPlaintext(
        encode({ hd: baseHd, entries: [{ ...tee, tee: { network: "solana-mainnet", lifecycle: "parked" } }] }),
      ),
    ).toThrow(/not one of the five values/)
  })

  test("a remoteState word used as a lifecycle says WHICH mistake was made", () => {
    const tee = { ...derivedEntry, role: "tee-wallet", origin: "migrated-tee", derivation: undefined }
    expect(() =>
      parseIndexPlaintext(
        encode({ hd: baseHd, entries: [{ ...tee, tee: { network: "solana-mainnet", lifecycle: "quarantined" } }] }),
      ),
    ).toThrow(/remoteState observation and never a lifecycle/)
  })

  test("CC-01's per-value table: each value's required and forbidden fields", () => {
    const tee = { ...derivedEntry, role: "tee-wallet", origin: "migrated-tee", derivation: undefined }
    const grant = { account: "A", apiBaseUrl: "https://api.test", source: "recorded-at-operation" }

    // `enabled` needs all four.
    expect(() =>
      parseIndexPlaintext(
        encode({
          hd: baseHd,
          entries: [
            {
              ...tee,
              tee: { network: "solana-mainnet", lifecycle: "enabled", grantIdentity: grant, vaultDestination: "V" },
            },
          ],
        }),
      ),
    ).toThrow(/must record linkedWalletId/)
    expect(() =>
      parseIndexPlaintext(
        encode({
          hd: baseHd,
          entries: [
            {
              ...tee,
              linkedWalletId: "w1",
              tee: { network: "solana-mainnet", lifecycle: "enabled", grantIdentity: grant },
            },
          ],
        }),
      ),
    ).toThrow(/must record tee.vaultDestination/)

    // `stranded` and `local-candidate` forbid `linkedWalletId` by definition.
    expect(() =>
      parseIndexPlaintext(
        encode({
          hd: baseHd,
          entries: [
            {
              ...tee,
              linkedWalletId: "w1",
              tee: { network: "solana-mainnet", lifecycle: "stranded", grantIdentity: grant },
            },
          ],
        }),
      ),
    ).toThrow(/must not carry linkedWalletId/)

    // And the shapes that are legal: a destination-less stranded entry, and a bare candidate.
    const stranded = parseIndexPlaintext(
      encode({
        hd: baseHd,
        entries: [{ ...tee, tee: { network: "solana-mainnet", lifecycle: "stranded", grantIdentity: grant } }],
      }),
    )
    expect(stranded.entries[0]?.tee?.lifecycle).toBe("stranded")
    const candidate = parseIndexPlaintext(
      encode({ hd: baseHd, entries: [{ ...tee, tee: { network: "solana-mainnet", lifecycle: "local-candidate" } }] }),
    )
    expect(candidate.entries[0]?.tee?.lifecycle).toBe("local-candidate")
  })

  test("an entry or an hd record carrying a field this format does not define", () => {
    expect(() =>
      parseIndexPlaintext(encode({ hd: baseHd, entries: [{ ...derivedEntry, nickname: "piggy bank" }] })),
    ).toThrow(/does not define: nickname/)
    expect(() => parseIndexPlaintext(encode({ hd: { ...baseHd, reserve: 20 }, entries: [] }))).toThrow(
      /hd carries an unknown field: reserve/,
    )
  })

  test("hd.discovery.complete of true is refused: no command ever writes it", () => {
    const hd = {
      ...baseHd,
      discovery: {
        restoredAt: "2026-09-17T12:00:00.000Z",
        account: "A",
        requestedCounts: { solanaVault: 1, solanaTee: 1 },
        highestMatched: { solanaVault: 0, solanaTee: -1 },
        complete: true,
      },
    }
    expect(() => parseIndexPlaintext(encode({ hd, entries: [] }))).toThrow(/no command ever writes it true/)
  })
})

describe("T51: the format accepts a secp256k1 entry, and Phase 2 derives none", () => {
  test("a fixture with an EVM entry opens and lists", () => {
    const entry = {
      id: "e1",
      chain: "evm",
      curve: "secp256k1",
      address: "0x0000000000000000000000000000000000000001",
      label: "phase 4",
      createdAt: "2026-09-17T12:00:00.000Z",
      role: "vault",
      origin: "derived",
      derivation: { scheme: "bip32-secp256k1", path: "m/44'/60'/0'/0/0" },
      exposure: { everRemoteExposed: false, everExported: false },
    }
    const hd = {
      scheme: "bip39-24/slip10",
      nextIndex: { solanaVault: 0, solanaTee: 0, evm: 1 },
      rootExported: false,
      exposedIndexes: { solanaVault: [], solanaTee: [], evm: [] },
    }
    const parsed = parseIndexPlaintext(new TextEncoder().encode(JSON.stringify({ hd, entries: [entry] })))
    expect(parsed.entries[0]?.curve).toBe("secp256k1")
    // And the path is located on the EVM branch, so the counter check applies to it too.
    expect(branchOfPath("m/44'/60'/0'/0/0")).toEqual({ branch: "evm", index: 0 })
  })
})

describe("R6: the version 3 index rules, and the version 2 index that stays version 2", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  const externalEntry = {
    id: "x1",
    chain: "solana",
    curve: "ed25519",
    address: "ExternalAddress111111111111111111111111111",
    label: "trader",
    createdAt: "2026-09-19T12:00:00.000Z",
    role: "external",
    origin: "derived",
    derivation: { scheme: "slip10-ed25519", path: "m/44'/501'/0'/2'" },
    exposure: { everRemoteExposed: false, everExported: false },
  }
  const v3Hd = {
    scheme: "bip39-24/slip10",
    nextIndex: { solanaVault: 0, solanaTee: 0, solanaExternal: 1, evm: 0 },
    rootExported: false,
    exposedIndexes: { solanaVault: [], solanaTee: [], solanaExternal: [], evm: [] },
  }
  const v2Hd = {
    scheme: "bip39-24/slip10",
    nextIndex: { solanaVault: 0, solanaTee: 0, evm: 0 },
    rootExported: false,
    exposedIndexes: { solanaVault: [], solanaTee: [], evm: [] },
  }
  const refusal = (body: () => unknown): string => {
    try {
      body()
    } catch (error) {
      if (error instanceof VaultError) return `${error.code}: ${error.message}`
      throw error
    }
    throw new Error("expected a refusal")
  }

  test("a version 3 index carries the external branch and an external entry; a version 2 index reads as the same shape in memory", () => {
    const v3 = parseIndexPlaintext(encode({ hd: v3Hd, entries: [externalEntry] }), 3)
    expect(v3.entries[0]?.role).toBe("external")
    expect(v3.hd.nextIndex.solanaExternal).toBe(1)
    expect(branchOfPath("m/44'/501'/0'/2'")).toEqual({ branch: "solanaExternal", index: 0 })
    const v2 = parseIndexPlaintext(encode({ hd: v2Hd, entries: [] }), 2)
    expect(v2.hd.nextIndex).toEqual({ solanaVault: 0, solanaTee: 0, solanaExternal: 0, evm: 0 })
    expect(v2.hd.exposedIndexes.solanaExternal).toEqual([])
  })

  test("a version 2 index must not carry the branch or an external entry; a version 3 index must carry the branch", () => {
    expect(refusal(() => parseIndexPlaintext(encode({ hd: v3Hd, entries: [] }), 2))).toContain(
      "hd.nextIndex.solanaExternal is not a branch a version 2 vault carries",
    )
    expect(refusal(() => parseIndexPlaintext(encode({ hd: v2Hd, entries: [externalEntry] }), 2))).toContain(
      "role:external, which a version 2 vault cannot carry",
    )
    expect(refusal(() => parseIndexPlaintext(encode({ hd: v2Hd, entries: [] }), 3))).toContain(
      "hd.nextIndex.solanaExternal is missing",
    )
  })

  test("an external entry carrying tee or linkedWalletId, or not derived, is VAULT_INDEX_INVALID", () => {
    const withTee = { ...externalEntry, tee: { network: "solana-mainnet", lifecycle: "local-candidate" } }
    expect(refusal(() => parseIndexPlaintext(encode({ hd: v3Hd, entries: [withTee] }), 3))).toContain(
      "VAULT_INDEX_INVALID: Entry x1 is an external key carrying tee metadata",
    )
    const withLink = { ...externalEntry, linkedWalletId: "lw_1" }
    expect(refusal(() => parseIndexPlaintext(encode({ hd: v3Hd, entries: [withLink] }), 3))).toContain(
      "an external key carrying a linkedWalletId",
    )
    const migrated = { ...externalEntry, origin: "migrated-tee", derivation: undefined }
    expect(refusal(() => parseIndexPlaintext(encode({ hd: v3Hd, entries: [migrated] }), 3))).toContain(
      "VAULT_INDEX_INVALID",
    )
  })

  test("hd.nextIndex.solanaExternal at or below a recorded external derivation index is VAULT_INDEX_INVALID", () => {
    const hd = { ...v3Hd, nextIndex: { ...v3Hd.nextIndex, solanaExternal: 0 } }
    expect(refusal(() => parseIndexPlaintext(encode({ hd, entries: [externalEntry] }), 3))).toContain(
      "hd.nextIndex.solanaExternal is 0, at or below the index 0",
    )
  })

  test("a version 2 write narrows the branch away, and refuses to narrow anything that carries information", () => {
    const { serializeIndexPlaintext, indexRequiresVersion3 } = require("./format") as typeof import("./format")
    const empty = parseIndexPlaintext(encode({ hd: v2Hd, entries: [] }), 2)
    expect(indexRequiresVersion3(empty)).toBe(false)
    expect(serializeIndexPlaintext(empty, 2)).toEqual({ hd: v2Hd, entries: [] })
    expect(serializeIndexPlaintext(empty, 3)).toBe(empty)
    const allocated = parseIndexPlaintext(encode({ hd: v3Hd, entries: [externalEntry] }), 3)
    expect(indexRequiresVersion3(allocated)).toBe(true)
    expect(refusal(() => serializeIndexPlaintext(allocated, 2))).toContain("cannot be written as a version 2 vault")
    // A counter that moved, an exposed index, or a discovery count on the branch is information too.
    const counter = { ...empty, hd: { ...empty.hd, nextIndex: { ...empty.hd.nextIndex, solanaExternal: 1 } } }
    expect(indexRequiresVersion3(counter)).toBe(true)
    const exposed = {
      ...empty,
      hd: { ...empty.hd, exposedIndexes: { ...empty.hd.exposedIndexes, solanaExternal: [0] } },
    }
    expect(indexRequiresVersion3(exposed)).toBe(true)
  })

  test("the discovery record carries the branch in version 3 and not in version 2", () => {
    const discovery = {
      restoredAt: "2026-09-19T12:00:00.000Z",
      account: "",
      requestedCounts: { solanaVault: 1, solanaTee: 1, solanaExternal: 2 },
      highestMatched: { solanaVault: -1, solanaTee: -1, solanaExternal: -1 },
      complete: false,
    }
    const v3 = parseIndexPlaintext(encode({ hd: { ...v3Hd, discovery }, entries: [] }), 3)
    expect(v3.hd.discovery?.requestedCounts.solanaExternal).toBe(2)
    const { solanaExternal: _r, ...requestedCounts } = discovery.requestedCounts
    const { solanaExternal: _m, ...highestMatched } = discovery.highestMatched
    const v2 = parseIndexPlaintext(
      encode({ hd: { ...v2Hd, discovery: { ...discovery, requestedCounts, highestMatched } }, entries: [] }),
      2,
    )
    expect(v2.hd.discovery?.requestedCounts).toEqual({ solanaVault: 1, solanaTee: 1, solanaExternal: 0 })
    expect(v2.hd.discovery?.highestMatched.solanaExternal).toBe(-1)
    expect(refusal(() => parseIndexPlaintext(encode({ hd: { ...v2Hd, discovery }, entries: [] }), 2))).toContain(
      "not a field a version 2 vault carries",
    )
  })
})

describe("T50: a 0.9.x reader refuses vault.enc and writes nothing", () => {
  test("readKeystore, the v1 reader this release still ships, refuses version 2", async () => {
    const made = await makeVault()
    const raw = await readFile(made.path, "utf8")
    // `readKeystore` is the exact function a 0.9.x binary uses (`wallet-keystore.ts`), unchanged by
    // this PR, so this is the real reader and not a model of one.
    await expect(readKeystore(raw, "any passphrase")).rejects.toThrow("Unsupported keystore version 2")

    // And it wrote nothing: the bytes are identical afterwards.
    expect(await readFile(made.path, "utf8")).toBe(raw)
  })

  test("the vault never opens a wallets.enc, even when one is sitting beside it", async () => {
    const dir = await tempDir()
    const legacy = join(dir, "wallets.enc")
    await writeFile(legacy, `${JSON.stringify({ version: 1, ciphertext: "not ours" })}\n`, "utf8")
    const before = await readFile(legacy, "utf8")

    const made = await makeVault()
    await copyFile(made.path, join(dir, "vault.enc"))
    const vault = await reopen(join(dir, "vault.enc"))
    expect(vault.index.entries).toHaveLength(0)
    expect(await readFile(legacy, "utf8")).toBe(before)
  })
})

/** A vault with one derived key, for the assertions that need a key blob to corrupt. */
async function makeVaultWithKey() {
  const made = await makeVault()
  const { DERIVATION_SCHEME, deriveSolanaKey, solanaVaultPath } = await import("./hd")
  const { freshKeyId, sealKeyBlob } = await import("./store")
  const { FIXTURE_ENTROPY } = await import("./test-vault")
  const path = solanaVaultPath(0)
  const derived = await deriveSolanaKey(Uint8Array.from(FIXTURE_ENTROPY), path)
  const keyId = freshKeyId()
  const blob = await sealKeyBlob(made.vault, keyId, derived.secret64)
  await commitVault(
    made.vault,
    {
      index: {
        hd: { ...made.vault.index.hd, nextIndex: { ...made.vault.index.hd.nextIndex, solanaVault: 1 } },
        entries: [
          {
            id: keyId,
            chain: "solana",
            curve: "ed25519",
            address: derived.address,
            label: "one",
            createdAt: "2026-09-17T12:00:00.000Z",
            role: "vault",
            origin: "derived",
            derivation: { scheme: DERIVATION_SCHEME, path },
            exposure: { everRemoteExposed: false, everExported: false },
          },
        ],
      },
      addKeys: [blob],
    },
    testClock,
  )
  return made
}
