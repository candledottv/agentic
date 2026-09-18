/**
 * Ember Phase 2 PR C (CC-06, CC-10, AD-8): shared preconditions and the normative AD-8 warning
 * for both promote modes and `tee enable --vault-key`.
 */
import type { CommandContext } from "../deps"
import { VaultError } from "./errors"
import type { IndexPlaintext, KeyEntry } from "./format"

/**
 * CC-10's normative AD-8 warning. Printed in full on every in-place promotion, for every
 * address, unconditionally, before both typed confirmations. Never a gate.
 */
export const AD8_WARNING = `This key may sign for a multisig, for a program upgrade authority, or for a token mint or freeze authority. The CLI does not know which, and does not check.
Promoting leaves a copy of this key inside Privy's TEE for good.
The key itself, its multisig membership and its authorities are unchanged: the operator keeps the key and can keep signing with it, and whatever it signs for keeps working exactly as before.
If Privy's TEE or its signing policy were compromised, whatever this key controls is at risk, and how much depends on the setup: a multisig's threshold, or whether this key is a sole authority, decides what an attacker could actually do.
Demoting does not remove that copy. The only way to end this exposure is to replace this key in the multisig, or to move the authority to another key.`

export const AD8_ACK_WORD = "EXPOSE"

/** The recovery destination rule (CC-10), shared by both promote modes and `tee enable --vault-key`. */
export function assertColdVaultDestination(
  index: IndexPlaintext,
  destinationLabelOrAddress: string,
  opts: {
    subjectAddress?: string
    acceptUnknownExposure?: boolean
  } = {},
): KeyEntry {
  const destination = findVaultRoleEntry(index, destinationLabelOrAddress)
  if (destination === undefined) {
    throw new VaultError("PROMOTE_DESTINATION_NOT_COLD", `No vault key matches ${destinationLabelOrAddress}.`, {
      suggestion:
        "Create a cold vault key with `candle vault new-key --chain solana`, or name an existing one that has never been remotely exposed or exported.",
    })
  }
  if (destination.role !== "vault") {
    throw new VaultError(
      "PROMOTE_DESTINATION_NOT_COLD",
      `${destination.label ?? destination.address} is not a role:vault key.`,
    )
  }
  if (opts.subjectAddress !== undefined && destination.address === opts.subjectAddress) {
    throw new VaultError(
      "PROMOTE_SAME_KEY_DESTINATION",
      "The sweep destination must be a different vault key from the one being promoted.",
    )
  }
  const exposed = destination.exposure?.everRemoteExposed === true
  const exported = destination.exposure?.everExported === true
  const unknown = destination.exposure?.exposureUnknown === true
  if (exposed || exported) {
    throw new VaultError(
      "PROMOTE_DESTINATION_NOT_COLD",
      `${destination.label ?? destination.address} is not cold: everRemoteExposed=${exposed}, everExported=${exported}.`,
      {
        suggestion: "Pin a vault key that has never been remotely exposed or exported (`candle vault new-key`).",
      },
    )
  }
  if (unknown && !opts.acceptUnknownExposure) {
    throw new VaultError(
      "PROMOTE_DESTINATION_NOT_COLD",
      `${destination.label ?? destination.address} carries exposureUnknown and is refused as a recovery destination.`,
      {
        suggestion:
          "Pass --accept-unknown-exposure to admit only this case (never an everRemoteExposed or everExported key), or create a fresh cold key.",
      },
    )
  }
  return destination
}

export function findVaultRoleEntry(index: IndexPlaintext, labelOrAddress: string): KeyEntry | undefined {
  const byLabel = index.entries.find(
    (entry) => entry.role === "vault" && entry.label !== undefined && entry.label === labelOrAddress,
  )
  if (byLabel !== undefined) return byLabel
  return index.entries.find((entry) => entry.address === labelOrAddress)
}

export function findEntryByLabelOrAddress(index: IndexPlaintext, labelOrAddress: string): KeyEntry | undefined {
  const byLabel = index.entries.find((entry) => entry.label !== undefined && entry.label === labelOrAddress)
  if (byLabel !== undefined) return byLabel
  return index.entries.find((entry) => entry.address === labelOrAddress)
}

/** Refuse when any TEE entry already pins this address as its sweep destination. */
export function assertNotPinnedDestination(index: IndexPlaintext, subjectAddress: string): void {
  const pinners = index.entries.filter((entry) => entry.tee?.vaultDestination === subjectAddress)
  if (pinners.length === 0) return
  throw new VaultError(
    "PROMOTE_KEY_IS_PINNED_DESTINATION",
    `${subjectAddress} is the pinned sweep destination for: ${pinners.map((e) => e.label ?? e.address).join(", ")}.`,
    {
      suggestion:
        "Demote those TEE wallets to this key first, then promote fresh ones against a different cold destination.",
    },
  )
}

/** Re-check CC-10 steps 1-3 under the vault lock immediately before the write. */
export function assertInPlacePreconditions(
  index: IndexPlaintext,
  subjectLabel: string,
  sweepToLabel: string,
  opts: { acceptUnknownExposure?: boolean },
): { subject: KeyEntry; destination: KeyEntry; resume: boolean } {
  const subject = findEntryByLabelOrAddress(index, subjectLabel)
  if (subject === undefined) {
    throw new VaultError("PROMOTE_NOT_VAULT_KEY", `No entry matches ${subjectLabel}.`)
  }
  if (subject.role === "tee-wallet") {
    const lifecycle = subject.tee?.lifecycle
    if (lifecycle === "local-candidate" || lifecycle === "import-pending") {
      return {
        subject,
        destination: assertColdVaultDestination(index, sweepToLabel, {
          subjectAddress: subject.address,
          acceptUnknownExposure: opts.acceptUnknownExposure,
        }),
        resume: true,
      }
    }
    throw new VaultError(
      "PROMOTE_ALREADY_TEE_WALLET",
      `${subject.label ?? subject.address} is already a TEE wallet (${lifecycle ?? "unknown"}).`,
    )
  }
  if (subject.role !== "vault" || subject.tee !== undefined) {
    throw new VaultError("PROMOTE_NOT_VAULT_KEY", `${subjectLabel} is not a role:vault key without tee metadata.`)
  }
  if (subject.exposure?.exposureUnknown === true) {
    throw new VaultError(
      "PROMOTE_SUBJECT_EXPOSURE_UNKNOWN",
      `${subject.label ?? subject.address} carries exposureUnknown and cannot be promoted in place.`,
    )
  }
  assertNotPinnedDestination(index, subject.address)
  const destination = assertColdVaultDestination(index, sweepToLabel, {
    subjectAddress: subject.address,
    acceptUnknownExposure: opts.acceptUnknownExposure,
  })
  return { subject, destination, resume: false }
}

export function printAd8Warning(ctx: CommandContext): void {
  ctx.deps.stdout.write(`\n${AD8_WARNING}\n\n`)
}

export async function confirmAd8Acknowledgement(ctx: CommandContext): Promise<void> {
  const typed = (
    await ctx.deps.promptLine(
      `Type ${AD8_ACK_WORD} to acknowledge: I have read the warning above, this address never returns to cold, and I accept what it may control: `,
    )
  ).trim()
  if (typed !== AD8_ACK_WORD) {
    throw new VaultError("PROMOTE_NOT_ACKNOWLEDGED", "The acknowledgement word did not match; nothing was promoted.")
  }
}
