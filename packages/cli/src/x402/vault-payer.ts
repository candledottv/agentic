/**
 * The signer for a per-use payment (spec 10.2): a Solana vault key, unlocked the way every other
 * value-moving vault command unlocks it (`unlockInteractively`, at a terminal, never a passphrase
 * from the environment). The confirmation is the typed `confirm` the vault commands share, naming
 * the price, the product and the pay-to address; `--yes` skips it, never the unlock.
 *
 * Only a `role: "vault"` Solana key pays: a TEE wallet's key signs through Candle's relay and an
 * external key signs only through `candle sign`. `--wallet` names one by label or address; with
 * exactly one such key it is used, and with several the command must name it.
 *
 * Unattended signing (the `candle core` slot) is the BE-1834-held TUI core's, and not offered here.
 */

import { confirmAddress, requireVaultRaw, unlockInteractively, vaultPathFor } from "../commands/vault-support"
import type { CommandContext } from "../deps"
import { terminalText } from "../render"
import { signMessage } from "../solana-lite"
import { VaultError } from "../vault/errors"
import { wipe } from "../vault/hygiene"
import { closeVault, decryptKey } from "../vault/store"
import type { PayerSource, PaymentOffer, PaymentSigner } from "./pay"

export interface VaultPayerOptions {
  /** `--wallet <label|address>`. */
  wallet?: string
  /** `--yes`: skip the typed confirmation. */
  yes: boolean
}

/** `refuseEnvPassphrase`'s rule, thrown: only the variable's presence is read, never its value (T39). */
function assertNoEnvPassphrase(ctx: CommandContext): void {
  if (ctx.deps.env.CANDLE_KEYSTORE_PASSPHRASE === undefined) return
  throw new VaultError(
    "ENV_PASSPHRASE_REFUSED",
    "CANDLE_KEYSTORE_PASSPHRASE is set. No Candle command reads its value, and the vault never takes a passphrase from the environment.",
    { suggestion: "Unset it and run again; the payment prompts for the vault passphrase with input hidden." },
  )
}

function assertTerminal(ctx: CommandContext): void {
  assertNoEnvPassphrase(ctx)
  if (!ctx.deps.isTTY.stdin || !ctx.deps.isTTY.stdout) {
    throw new VaultError(
      "VAULT_UNLOCK_FAILED",
      "This call needs a payment, and paying needs a terminal: the vault key that signs it is unlocked at a hidden prompt and from nowhere else. Nothing was paid.",
      { suggestion: "Run it at a terminal, or raise the free limit the call went past." },
    )
  }
}

export function vaultPayer(ctx: CommandContext, options: VaultPayerOptions): PayerSource {
  return {
    async confirm(offer: PaymentOffer) {
      assertTerminal(ctx)
      if (options.yes) return
      await confirmAddress(
        ctx,
        "pay to",
        offer.payTo,
        `pay ${offer.priceText} USDC for ${terminalText(offer.description)}`,
      )
    },
    async open(offer: PaymentOffer): Promise<PaymentSigner> {
      assertTerminal(ctx)
      const resolved = vaultPathFor(ctx, { positionals: [], values: {}, booleans: new Set() })
      if ("error" in resolved) throw new VaultError("VAULT_MISSING", resolved.error)
      const raw = await requireVaultRaw(ctx, resolved)
      const opened = await unlockInteractively(ctx, resolved.path, raw, {
        reason: `pay ${offer.priceText} USDC`,
        purpose: "x402 payment",
      })
      const vault = opened.vault
      try {
        const keys = vault.index.entries.filter((e) => e.role === "vault" && e.chain === "solana")
        const named = options.wallet
        const matches = named === undefined ? keys : keys.filter((e) => e.label === named || e.address === named)
        if (matches.length === 0) {
          throw new VaultError(
            "VAULT_LABEL_NOT_FOUND",
            named === undefined
              ? "This vault has no Solana vault key to pay with. Nothing was paid."
              : `No Solana vault key matches --wallet ${named}. Nothing was paid.`,
            { suggestion: "List the keys with: candle vault list" },
          )
        }
        if (matches.length > 1) {
          throw new VaultError(
            "VAULT_LABEL_AMBIGUOUS",
            `This vault has ${matches.length} Solana vault keys; name the one that pays with --wallet <label>. Nothing was paid.`,
            { suggestion: `Keys: ${matches.map((e) => e.label).join(", ")}` },
          )
        }
        const entry = matches[0] as (typeof matches)[number]
        const secret = await decryptKey(vault, entry.id)
        return {
          address: entry.address,
          sign: (message) => signMessage(message, secret),
          close: () => {
            wipe(secret)
            closeVault(vault)
          },
        }
      } catch (error) {
        closeVault(vault)
        throw error
      }
    },
  }
}
