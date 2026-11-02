/**
 * BE-2519: the launch fee-wallet flags, mirroring the API's own `parseFeeWallet`
 * (apps/api/src/lib/fee-wallet.ts) so a bad value or a bad multisig pair is refused here, before
 * any request. The server stays the authority (FEE_WALLET_MULTISIG_ENABLED and the on-chain
 * multisig account check are its to make); this is the early refusal in the API's own words.
 */
import { decodePubkey, encodePubkey, findProgramAddress, isOnCurve } from "./solana-lite"

export const FEE_WALLET_FLAGS = ["--fee-wallet", "--fee-wallet-multisig", "--fee-wallet-multisig-vault-index"]

const SQUADS_V4_PROGRAM_ID = decodePubkey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf")
const UNSUPPORTED =
  "Fee wallet must be an on-curve Solana wallet or a verified Squads v4 vault when multisig fees are enabled"

type Flags = Partial<Record<string, string | undefined>>

/** The validated selection: what the build request carries, canonical base58. */
export interface FeeWalletSelection {
  feeWallet: string
  feeWalletMultisig?: { address: string; vaultIndex: number }
}

export function feeWalletGiven(flags: Flags): boolean {
  return FEE_WALLET_FLAGS.some((flag) => flags[flag] !== undefined)
}

/** The `feeWallet`/`feeWalletMultisig` request fields; empty when no flag is given. Throws a usage message. */
export function feeWalletSelection(flags: Flags): FeeWalletSelection | undefined {
  if (!feeWalletGiven(flags)) return undefined
  const raw = flags["--fee-wallet"]
  if (raw === undefined) throw new Error("--fee-wallet-multisig needs --fee-wallet <address>, the vault fees earn to")
  const bytes = decodeAddress(raw, "--fee-wallet")
  const feeWallet = encodePubkey(bytes)
  if (isOnCurve(bytes)) {
    if (flags["--fee-wallet-multisig"] !== undefined || flags["--fee-wallet-multisig-vault-index"] !== undefined)
      throw new Error(`--fee-wallet is an on-curve wallet and takes no --fee-wallet-multisig. ${UNSUPPORTED}`)
    return { feeWallet }
  }
  const multisig = flags["--fee-wallet-multisig"]
  const index = flags["--fee-wallet-multisig-vault-index"]
  if (multisig === undefined || index === undefined)
    throw new Error(
      `--fee-wallet is off-curve, a Squads v4 vault, and names its multisig with --fee-wallet-multisig <address> and --fee-wallet-multisig-vault-index <n>. ${UNSUPPORTED}`,
    )
  if (!/^\d+$/.test(index) || Number(index) < 0 || Number(index) > 255)
    throw new Error("--fee-wallet-multisig-vault-index takes a whole number from 0 to 255")
  const multisigBytes = decodeAddress(multisig, "--fee-wallet-multisig")
  const vault = findProgramAddress(
    [utf8("multisig"), multisigBytes, utf8("vault"), Uint8Array.of(Number(index))],
    SQUADS_V4_PROGRAM_ID,
  ).address
  if (encodePubkey(vault) !== feeWallet) throw new Error(UNSUPPORTED)
  return { feeWallet, feeWalletMultisig: { address: encodePubkey(multisigBytes), vaultIndex: Number(index) } }
}

/** The request fields for a launch body; `{}` when no flag was given. Throws the same usage message. */
export function feeWalletRequestFields(flags: Flags): Record<string, unknown> {
  const selection = feeWalletSelection(flags)
  if (!selection) return {}
  return {
    feeWallet: selection.feeWallet,
    ...(selection.feeWalletMultisig ? { feeWalletMultisig: selection.feeWalletMultisig } : {}),
  }
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function decodeAddress(value: string, flag: string): Uint8Array {
  try {
    return decodePubkey(value)
  } catch {
    throw new Error(`${flag} takes a Solana address.`)
  }
}

/**
 * The fee wallet on screen (the preview, the quote and `--check`): what was chosen, clearly
 * labelled, and what the default is. `echo` is the wallet the server's answer names, when it
 * answers one; it is what the default resolved to.
 */
export function feeWalletLines(selection: FeeWalletSelection | undefined, echo?: string): string[] {
  if (selection)
    return [
      `Fee wallet: ${selection.feeWallet} (earns this launch's fees; set by --fee-wallet)`,
      ...(selection.feeWalletMultisig
        ? [
            `Fee wallet multisig: ${selection.feeWalletMultisig.address}, vault ${selection.feeWalletMultisig.vaultIndex} (the Squads v4 multisig behind the fee wallet)`,
          ]
        : []),
    ]
  return [
    echo
      ? `Fee wallet: ${echo} (defaults to the account wallet; pass --fee-wallet <address> to change it)`
      : "Fee wallet: defaults to the account wallet (pass --fee-wallet <address> to change it).",
  ]
}

/** One line for a quote: the selection, or the default said plainly. */
export function feeWalletQuoteLine(selection: FeeWalletSelection | undefined): string {
  if (!selection) return "defaults to the account wallet"
  return `${selection.feeWallet}${selection.feeWalletMultisig ? ` (Squads vault of ${selection.feeWalletMultisig.address}, vault ${selection.feeWalletMultisig.vaultIndex})` : ""}`
}
