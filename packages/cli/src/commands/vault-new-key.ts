/**
 * Ember Phase 2 (BE-136, CC-11, AD-5): `candle vault new-key`.
 *
 * This is the one command in PR A that ALLOCATES, and CC-11's central distinction is what shapes
 * it. Recovery derives an index to reproduce an address that already exists, and is always safe.
 * Allocation claims an index as new and unused, and that claim is only true if the highest
 * previously allocated index is known. A restored vault cannot know it -- the phrase is the whole
 * input to derivation, and the same phrase may have been restored under another account, under
 * another deployment, or into a wallet that never touched Candle -- so allocation FAILS CLOSED
 * there, with no override flag, because there is no fact an operator could assert that would make
 * an unknown boundary known. The exit is a fresh root, and the refusal names it.
 *
 * `hd.exposedIndexes` is the second guard and it applies even when the boundary IS known: an index
 * positively known to have been exposed is never allocated, in any vault built from this root.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { assertRecoverableFactorExists, countRecoverableFactors } from "../vault/domains"
import { addressFromSecret64 } from "../vault/ed25519"
import { VaultError } from "../vault/errors"
import type { KeyEntry } from "../vault/format"
import { DERIVATION_SCHEME, deriveSolanaKey, solanaVaultPath } from "../vault/hd"
import { wipe } from "../vault/hygiene"
import { readSidecar, sidecarPath } from "../vault/sidecar"
import {
  commitVault,
  decryptKey,
  decryptRoot,
  freshKeyId,
  readVaultRaw,
  sealKeyBlob,
  unlockWithPassphrase,
} from "../vault/store"
import {
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

export async function vaultNewKey(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore", "--chain", "--label"],
    booleanFlags: ["--accept-older-copy"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)

  const chain = parsed.values["--chain"]
  if (chain === undefined) return usage(ctx, "--chain solana is required.")
  if (chain === "evm") {
    // Exit 2 rather than 1: the format accepts a secp256k1 entry and the path is already fixed
    // (`m/44'/60'/n'/0/0`), so this is a command that does not exist yet, not an operation refused.
    return usage(ctx, "CHAIN_NOT_OFFERED: EVM keys arrive in Phase 4. This release derives Solana keys only.")
  }
  if (chain !== "solana") return usage(ctx, `Unknown chain: ${chain}. This release derives Solana keys only.`)
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault new-key")) return 1

  const { deps } = ctx
  const path = vaultPathFor(ctx, parsed)

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(path)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    const vault = hold(opened.vault)

    // Invariant 1, checked against the OPENED vault: a key created in a vault with no recoverable
    // factor is a key nobody can recover.
    assertRecoverableFactorExists(vault.file.envelopes)
    await assertHighValueSatisfied(path, vault.file.envelopes)

    // CC-11: a restored vault is a recovery vault. It opens, lists, signs, backs up and exports by
    // ceremony; it does not mint new addresses from a root whose history it cannot bound.
    if (vault.index.hd.discovery !== undefined) {
      throw new VaultError(
        "VAULT_ALLOCATION_BOUNDARY_UNKNOWN",
        "This vault was built by `vault restore --phrase`, so the highest index its root ever allocated was never established and claiming a new one could re-derive an address that is already in use elsewhere.",
        {
          suggestion:
            "Create a second vault with a fresh root (`candle vault init`) and move the funds across with `candle vault transfer`. There is no flag for this: no fact you could assert would make the old boundary known.",
        },
      )
    }

    const index = nextAllocatableIndex(vault.index.hd.nextIndex.solanaVault, vault.index.hd.exposedIndexes.solanaVault)
    const derivationPath = solanaVaultPath(index)

    const root = await decryptRoot(vault)
    let address: string
    let keyId: string
    let blob: Awaited<ReturnType<typeof sealKeyBlob>>
    try {
      const derived = await deriveSolanaKey(root, derivationPath)
      try {
        address = derived.address
        keyId = freshKeyId()
        blob = await sealKeyBlob(vault, keyId, derived.secret64)
      } finally {
        wipe(derived.secret64)
      }
    } finally {
      wipe(root)
    }

    const entry: KeyEntry = {
      id: keyId,
      chain: "solana",
      curve: "ed25519",
      address,
      label: parsed.values["--label"] ?? `key-${index}`,
      createdAt: new Date(deps.now()).toISOString(),
      role: "vault",
      origin: "derived",
      derivation: { scheme: DERIVATION_SCHEME, path: derivationPath },
      exposure: { everRemoteExposed: false, everExported: false },
    }

    await commitVault(
      vault,
      {
        index: {
          hd: { ...vault.index.hd, nextIndex: { ...vault.index.hd.nextIndex, solanaVault: index + 1 } },
          entries: [...vault.index.entries, entry],
        },
        addKeys: [blob],
      },
      deps,
    )

    // Re-open and verify the address derives from what was actually WRITTEN, for the same reason
    // `init` re-reads itself: the guarantee is about the bytes on disk, not about the object this
    // process just built.
    await verifyWritten(path, address, keyId, opened.passphrase, ctx)

    if (ctx.json) {
      writeJson(deps, { ok: true, address, label: entry.label, path: derivationPath, index, keyId })
      return 0
    }
    deps.stdout.write(`${address}\n`)
    deps.stdout.write(`  label       ${entry.label}\n`)
    deps.stdout.write(`  derivation  ${derivationPath}\n`)
    deps.stdout.write(`  verified    re-read from the vault and re-derived from its root\n`)
    return 0
  })
}

/**
 * The next index this vault may CLAIM: the counter, advanced past anything in `exposedIndexes`.
 * The list only ever grows and survives every later restore that rediscovers it, so this skip is
 * permanent rather than a one-time correction.
 */
export function nextAllocatableIndex(counter: number, exposed: readonly number[]): number {
  let index = counter
  while (exposed.includes(index)) index++
  return index
}

/**
 * CC-03's `--high-value` rule. The flag has no authenticated home in CC-01's schema, so it is read
 * from the sidecar; a lost sidecar therefore loses the constraint, which is recorded in the PR
 * rather than hidden here.
 */
async function assertHighValueSatisfied(
  path: string,
  envelopes: Parameters<typeof countRecoverableFactors>[0],
): Promise<void> {
  const sidecar = (await readSidecar(sidecarPath(path))) as { highValue?: boolean } | null
  if (sidecar?.highValue !== true) return
  const generated = envelopes.some(
    (envelope) => envelope.factor === "passphrase" && envelope.strength === "generated-103",
  )
  if (generated) return
  if (countRecoverableFactors(envelopes) >= 2) return
  throw new VaultError(
    "VAULT_NO_RECOVERABLE_FACTOR",
    "This vault was created with --high-value, which needs either a generated passphrase or two recoverable factors in different domains before a key is created in it.",
    { suggestion: "Add a second recoverable factor: candle vault factor add passphrase" },
  )
}

/** Re-opens the written file and checks the new blob decrypts to the address just reported. */
async function verifyWritten(
  path: string,
  address: string,
  keyId: string,
  passphrase: string,
  ctx: CommandContext,
): Promise<void> {
  const raw = await readVaultRaw(path)
  if (raw === null)
    throw new VaultError("VAULT_WRITE_FAILED", `The vault at ${path} could not be read back after the write.`)
  const reopened = await unlockWithPassphrase(path, raw, passphrase, { notice: (line) => ctx.deps.stderr.write(line) })
  try {
    const secret = await decryptKey(reopened, keyId)
    try {
      if (addressFromSecret64(secret) !== address) {
        throw new VaultError(
          "VAULT_VERIFY_FAILED",
          "The key written to the vault does not produce the address just derived.",
        )
      }
    } finally {
      wipe(secret)
    }
  } finally {
    const { closeVault } = await import("../vault/store")
    closeVault(reopened)
  }
}
