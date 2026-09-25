/**
 * Ember Phase 4b (BE-391, spec `2026-09-24-ember-phase-4b-hood-tee-wallets-design.md`, D1): `candle
 * vault promote` for an EVM key, turning a 4a EVM vault key into a Hood TEE wallet.
 *
 * Both Solana modes, with Solana's safeguards (4a section 10, decision 1):
 *
 * - `--in-place <evm vault key> --sweep-to <cold evm vault key>` imports the key at its own address.
 *   The holdings are shown (ETH, USDG, WETH over the Hood RPC), then the controlling account, key and
 *   API read live, the last six, and `confirm`, exactly as a Solana in-place promote. The signer-role
 *   read is Solana's (mint, freeze, upgrade and stake authorities); on Hood there is none to read, so
 *   the sentence takes its "not checked" form.
 * - `--from <cold evm vault key>` derives a fresh key on the EVM TEE branch `m/44'/60'/n'/1'/0'`.
 *
 * The write that creates the vault's first EVM TEE wallet (in either mode) moves the file to version
 * 4 and creates the sealed EVM record's key in that same write (`commitVault`). Every EVM TEE promote
 * then appends its own wallet's `scanStart`: the Hood height read at this promote, before the write,
 * so the sweep's log discovery starts no later than the wallet's first transfer in. When the append
 * cannot run, the promote still succeeds and prints the height and the exact `--from-block`.
 *
 * The import registers the key with `chain: "evm"`; the server attaches the Hood TEE Privy policy
 * (D2) and pins the EVM `vaultDestination` (D3). The relay signer stays on this machine.
 */
import type { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { bytesToHex, EVM_DERIVATION_SCHEME, evmAddressFromSecret, sameEvmAddress } from "../evm-lite"
import { writeLocalFailure } from "../render"
import { RESTORED_SENTENCE, restoreRefusedFailure, restoresPreImportEntry } from "../vault/account-room"
import { assertRecoverableFactorExists } from "../vault/domains"
import { VaultError } from "../vault/errors"
import {
  appendScanStart,
  assertHoodChain,
  type HoodClient,
  holdingsLines,
  hoodHostLine,
  readEvmHoldings,
  resolveHoodClient,
} from "../vault/evm-tee"
import { exposedIndexesOf, type KeyEntry, nextIndexOf } from "../vault/format"
import { deriveEvmTeeKeyFromRoot, evmTeePath } from "../vault/hd"
import { wipe } from "../vault/hygiene"
import {
  applyPromotion,
  assertColdVaultDestination,
  assertEvmInPlacePreconditions,
  assertNotPinnedDestination,
  confirmPromotion,
  controlledByJson,
  printPromoteSentence,
  promoteSentence,
  readControlledBy,
  renderControlledBy,
  withToKey,
} from "../vault/promote-support"
import { targetWarnings } from "../vault/promote-to-key"
import { commitVault, decryptKey, decryptRoot, freshKeyId, sealKeyBlob, type UnlockedVault } from "../vault/store"
import { nextAllocatableIndex } from "./vault-new-key"
import {
  callingKeyPrefixFor,
  type ReturnedFailure,
  rebindAfterImport,
  refuseWithoutRoom,
  reopenFromDisk,
  runTeeImport,
  type ToKeyContext,
} from "./vault-promote"
import { confirmLastSix, type OpenedVault, type ResolvedVaultPath, usage, writeJson } from "./vault-support"

type Parsed = Exclude<ReturnType<typeof parseArgs>, { error: string }>

interface EvmPromoteContext {
  ctx: CommandContext
  parsed: Parsed
  opened: OpenedVault
  hold: (vault: UnlockedVault) => UnlockedVault
  resolvedVault: ResolvedVaultPath
  toKey: ToKeyContext | undefined
}

/** The Hood client for a promote, or a usage exit. Resolved from `--rpc-url` / `CANDLE_EVM_RPC_URL`. */
function hoodClientFor(ctx: CommandContext, parsed: Parsed): HoodClient | { exit: number } {
  const client = resolveHoodClient(ctx, parsed.values["--rpc-url"])
  if ("error" in client) return { exit: usage(ctx, client.error) }
  return client
}

/**
 * The Hood height this promote records as the wallet's `scanStart`, read before the vault write, and
 * the chain check every Hood TEE command makes (TEE wallets are Hood, 4663, only).
 */
async function promoteHeight(ctx: CommandContext, client: HoodClient): Promise<bigint> {
  ctx.deps.stderr.write(`${hoodHostLine(client, "the chain id and the current Hood height")}\n`)
  await assertHoodChain(client)
  return client.rpc.blockNumber()
}

/** The private key the import seals, `0x` + 64 hex characters. The caller never logs it. */
function importKeyHex(secret: Uint8Array): string {
  return bytesToHex(secret)
}

/**
 * `vault promote --from <cold evm vault key>`: a fresh key on `m/44'/60'/n'/1'/0'`. Refused in a
 * vault built by `restore --phrase` (CC-11), exactly as the Solana fresh promote.
 */
export async function promoteEvmFresh(input: EvmPromoteContext, fromLabel: string): Promise<number> {
  const { ctx, parsed, opened, hold, resolvedVault, toKey } = input
  let vault = hold(opened.vault)
  assertRecoverableFactorExists(vault.file.envelopes)
  if (vault.index.hd.discovery !== undefined) {
    throw new VaultError(
      "VAULT_ALLOCATION_BOUNDARY_UNKNOWN",
      "This vault was built by `vault restore --phrase`, so deriving a fresh TEE key is refused.",
      {
        suggestion:
          "Create a second vault with a fresh root (`candle vault init`) and move funds with `candle vault transfer`.",
      },
    )
  }
  const acceptUnknown = parsed.booleans.has("--accept-unknown-exposure")
  const destination = assertColdVaultDestination(vault.index, fromLabel, {
    acceptUnknownExposure: acceptUnknown,
    chain: "evm",
  })
  const client = hoodClientFor(ctx, parsed)
  if ("exit" in client) return client.exit

  // The room first (BE-288, D8): a refusal here consumes no derivation index.
  await refuseWithoutRoom(ctx)
  const height = await promoteHeight(ctx, client)

  const teeIndex = nextAllocatableIndex(
    nextIndexOf(vault.index.hd, "evmTee"),
    exposedIndexesOf(vault.index.hd, "evmTee"),
  )
  const derivationPath = evmTeePath(teeIndex)
  const root = await decryptRoot(vault)
  let address: string
  let keyId: string
  let blob: Awaited<ReturnType<typeof sealKeyBlob>>
  let secret: Uint8Array | undefined
  let privateKey: string
  let entry: KeyEntry
  let scanStart: Awaited<ReturnType<typeof appendScanStart>>
  try {
    const derived = await deriveEvmTeeKeyFromRoot(root, teeIndex)
    try {
      address = derived.address
      keyId = freshKeyId()
      secret = Uint8Array.from(derived.secret)
      blob = await sealKeyBlob(vault, keyId, derived.secret)
    } finally {
      wipe(derived.secret)
    }
    wipe(root)

    const now = new Date(ctx.deps.now()).toISOString()
    entry = {
      id: keyId,
      chain: "evm",
      curve: "secp256k1",
      address,
      label: parsed.values["--label"] ?? `evm-tee-${teeIndex}`,
      createdAt: now,
      role: "tee-wallet",
      origin: "derived",
      derivation: { scheme: EVM_DERIVATION_SCHEME, path: derivationPath },
      exposure: { everRemoteExposed: true, everExported: false },
      tee: {
        network: "hood-mainnet",
        lifecycle: "import-pending",
        vaultDestination: destination.address,
        ...(acceptUnknown && destination.exposure?.exposureUnknown ? { destinationExposureAccepted: true } : {}),
      },
    }
    const exposedTee = [...exposedIndexesOf(vault.index.hd, "evmTee")]
    if (!exposedTee.includes(teeIndex)) exposedTee.push(teeIndex)
    exposedTee.sort((a, b) => a - b)

    // The first EVM TEE wallet's write: version 4 and the record key, in this one write.
    vault = hold(
      await commitVault(
        vault,
        {
          index: {
            ...vault.index,
            hd: {
              ...vault.index.hd,
              nextIndex: { ...vault.index.hd.nextIndex, evmTee: teeIndex + 1 },
              exposedIndexes: { ...vault.index.hd.exposedIndexes, evmTee: exposedTee },
            },
            entries: [...vault.index.entries, entry],
          },
          addKeys: [blob],
        },
        ctx.deps,
      ),
    )
    // D1: after the write that created the record key. A fresh key's only height is this one.
    scanStart = await appendScanStart(ctx, vault.path, address, height)

    await confirmLastSix(ctx, destination.address, "the sweep vault destination")
    if (toKey !== undefined) {
      const name = toKey.target.label !== null ? `  (${toKey.target.label})` : ""
      ctx.deps.stderr.write(
        `${[
          `This wallet will be bound to key ${toKey.target.keyPrefix}${name} by a rebind after the import.`,
          ...targetWarnings(toKey.target),
        ].join("\n")}\n`,
      )
    }

    if (secret === undefined) throw new Error("EVM TEE key was not derived")
    privateKey = importKeyHex(secret)
  } finally {
    wipe(root)
    if (secret !== undefined) wipe(secret)
  }
  const importCount = { n: 0 }
  const { exit: code, submitted } = await runTeeImport(ctx, {
    address,
    privateKey,
    label: entry.label,
    vaultDestination: destination.address,
    reopenForWrite: opened.reopen,
    resolvedVault,
    chain: "evm",
    onImport: () => {
      importCount.n += 1
    },
  })
  if (code !== 0 && code !== 3) return code

  vault = hold(await reopenFromDisk(vault.path, opened.reopen, vault))
  const target = vault.index.entries.find((candidate) => candidate.id === keyId)
  if (target === undefined) throw new VaultError("VAULT_INDEX_INVALID", `Entry ${keyId} missing after import.`)
  let rebound: Awaited<ReturnType<typeof rebindAfterImport>> | undefined
  if (toKey !== undefined) {
    rebound = await rebindAfterImport(
      ctx,
      toKey,
      {
        linkedWalletId: target.linkedWalletId ?? null,
        address,
        label: entry.label,
        remoteAuthority: target.tee?.remoteAuthority ?? submitted?.remoteAuthority ?? null,
        importedTo: submitted?.boundKeyPrefix ?? null,
      },
      await callingKeyPrefixFor(ctx),
    )
  }
  const exit = Math.max(code, rebound?.exit ?? 0)
  if (ctx.json) {
    writeJson(ctx.deps, {
      ok: rebound === undefined || rebound.exit === 0,
      mode: "fresh",
      chain: "evm",
      address,
      label: entry.label,
      path: derivationPath,
      vaultDestination: destination.address,
      lifecycle: target.tee?.lifecycle,
      linkedWalletId: target.linkedWalletId ?? null,
      importCalls: importCount.n,
      scanStart: { block: scanStart.block, recorded: scanStart.recorded },
      vaultVersion: vault.file.version,
      ...(rebound?.json ?? {}),
    })
  } else {
    ctx.deps.stdout.write(
      `Promoted fresh Hood TEE wallet ${address} at ${derivationPath} (sweep to ${destination.address}). Scan start: Hood block ${scanStart.block}.\n`,
    )
  }
  return exit
}

/**
 * `vault promote --in-place <evm vault key> --sweep-to <cold evm vault key>`. The resume of an
 * import-pending EVM entry is the shared `resumePromote`, reached before this is called.
 */
export async function promoteEvmInPlace(
  input: EvmPromoteContext,
  subjectLabel: string,
  sweepTo: string,
): Promise<number> {
  const { ctx, parsed, opened, hold, resolvedVault, toKey } = input
  let vault = hold(opened.vault)
  const acceptUnknown = parsed.booleans.has("--accept-unknown-exposure")
  const client = hoodClientFor(ctx, parsed)
  if ("exit" in client) return client.exit

  const first = assertEvmInPlacePreconditions(vault.index, subjectLabel, sweepTo, {
    acceptUnknownExposure: acceptUnknown,
  })
  if (first.resume) return usage(ctx, "A resume of promote takes no --sweep-to (exit 2).")

  // The room, then who controls the key, then the holdings, then the sentence and both typed
  // confirmations: Solana's order (BE-288, BE-296), unchanged.
  await refuseWithoutRoom(ctx)
  const live = await readControlledBy(ctx)
  const controlledBy =
    toKey === undefined
      ? live
      : withToKey(live, {
          keyPrefix: toKey.target.keyPrefix,
          label: toKey.target.label,
          warnings: targetWarnings(toKey.target),
        })

  const height = await promoteHeight(ctx, client)
  const holdings = await readEvmHoldings(client.rpc, first.subject.address)
  for (const line of holdingsLines(first.subject.address, holdings, new Date(ctx.deps.now()).toISOString())) {
    ctx.deps.stdout.write(`${line}\n`)
  }
  ctx.deps.stdout.write(
    "Authorities: the signer-role read (mint, freeze, upgrade and stake authorities) is Solana's; nothing is read on Hood, so any contract this key controls is not checked.\n",
  )
  printPromoteSentence(ctx, promoteSentence({ n: 1, form: "U", where: "above" }))
  await confirmLastSix(ctx, first.subject.address, "the address being promoted")
  ctx.deps.stderr.write(`${renderControlledBy(controlledBy, 1)}\n`)
  await confirmPromotion(ctx, 1)

  // Re-open under the lock and re-run steps 1-3 before the write.
  vault = hold(await reopenFromDisk(vault.path, opened.reopen, vault))
  const second = assertEvmInPlacePreconditions(vault.index, subjectLabel, sweepTo, {
    acceptUnknownExposure: acceptUnknown,
  })
  if (second.resume) {
    throw new VaultError("PROMOTE_ALREADY_TEE_WALLET", "The entry changed under the lock; nothing was written.", {
      suggestion: "Run: candle vault status --unlock to see where the entry is now, then re-run promote to resume.",
    })
  }
  assertNotPinnedDestination(vault.index, second.subject.address)
  const subject = second.subject
  const destination = second.destination
  const preImportIndex = vault.index
  // The first EVM TEE wallet's write: version 4 and the record key, in this one write.
  vault = hold(
    await commitVault(
      vault,
      {
        index: applyPromotion(vault.index, subject, destination, {
          label: parsed.values["--label"],
          now: new Date(ctx.deps.now()).toISOString(),
          acceptUnknownExposure: acceptUnknown,
        }),
      },
      ctx.deps,
    ),
  )
  // D1: an in-place promote's scan start is the promote height only; there is no creation height.
  const scanStart = await appendScanStart(ctx, vault.path, subject.address, height)

  const secret = await decryptKey(vault, subject.id)
  let privateKey: string
  try {
    if (!sameEvmAddress(evmAddressFromSecret(secret), subject.address)) {
      throw new VaultError("VAULT_VERIFY_FAILED", "Stored secret does not match the subject address.")
    }
    privateKey = importKeyHex(secret)
  } finally {
    wipe(secret)
  }

  const imported = await runTeeImport(ctx, {
    address: subject.address,
    privateKey,
    label: parsed.values["--label"] ?? subject.label,
    vaultDestination: destination.address,
    reopenForWrite: opened.reopen,
    report: "return",
    resolvedVault,
    chain: "evm",
  })
  const code = imported.exit
  if (imported.failure !== undefined) {
    let failure: ReturnedFailure = {
      code: imported.failure.code,
      message: imported.failure.message,
      ...(imported.failure.suggestion !== undefined ? { suggestion: imported.failure.suggestion } : {}),
    }
    if (restoresPreImportEntry(imported.failure)) {
      try {
        vault = hold(await commitVault(vault, { index: preImportIndex }, ctx.deps))
        failure = { ...failure, message: `${failure.message} ${RESTORED_SENTENCE}` }
      } catch (error) {
        failure = restoreRefusedFailure(failure, error)
      }
    }
    writeLocalFailure(ctx.deps, failure, ctx.json)
    return code
  }
  let rebound: Awaited<ReturnType<typeof rebindAfterImport>> | undefined
  if (toKey !== undefined && imported.submitted !== undefined) {
    rebound = await rebindAfterImport(
      ctx,
      toKey,
      {
        linkedWalletId: imported.submitted.id ?? null,
        address: subject.address,
        label: parsed.values["--label"] ?? subject.label,
        remoteAuthority: imported.submitted.remoteAuthority ?? null,
        importedTo: imported.submitted.boundKeyPrefix ?? null,
      },
      controlledBy.keyPrefix,
    )
  }
  const exit = Math.max(code, rebound?.exit ?? 0)
  if (ctx.json) {
    const reopened = hold(await reopenFromDisk(vault.path, opened.reopen, vault))
    const updated = reopened.index.entries.find((candidate) => candidate.id === subject.id)
    writeJson(ctx.deps, {
      ok: (code === 0 || code === 3) && (rebound === undefined || rebound.exit === 0),
      mode: "in-place",
      chain: "evm",
      address: subject.address,
      vaultDestination: destination.address,
      lifecycle: updated?.tee?.lifecycle ?? null,
      linkedWalletId: updated?.linkedWalletId ?? null,
      controlledBy: controlledByJson(controlledBy),
      holdings: { eth: holdings.eth.toString(), usdg: holdings.usdg.toString(), weth: holdings.weth.toString() },
      scanStart: { block: scanStart.block, recorded: scanStart.recorded },
      vaultVersion: reopened.file.version,
      ...(rebound?.json ?? {}),
    })
  } else if (code === 0 || code === 3) {
    ctx.deps.stdout.write(
      `Promoted ${subject.address} in place on Hood (sweep to ${destination.address}). This address never returns to cold. Scan start: Hood block ${scanStart.block}.\n`,
    )
  }
  return exit
}
