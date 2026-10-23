/**
 * Hyperliquid withdrawals (Candle spec 2026-10-17-hyperliquid-withdrawals-design.md, "Client checks
 * before each signature"): the client half of a withdrawal from the key's HyperCore balance,
 * through Relay, to the same key's own Solana or Hood TEE wallet.
 *
 * Candle's server builds both signatures; this machine checks each one before it asks the relay to
 * sign, and refuses with no relay call when anything differs from what it asked for:
 *
 *   - Before the NonceMapping: the domain and type list are Relay's, `wallet` and `depositor` are
 *     this key's own EVM TEE address, `id` is the build's Relay order id (not the step request
 *     id), and the destination the build names is one of this key's own wallets on the chain asked
 *     for. That `to` is the recipient check: it comes from Candle's quote record, which the server
 *     checked against Relay's quote echo of the recipient. Relay's own record of the request is not
 *     read: it needs a Relay key, and none ships in this client (BE-1777).
 *   - Before the SendAsset: the nonce is the mapping's, the amount parses exactly to the micros
 *     asked for (no float, no string compare), `fromSubAccount` and `sourceDex` are empty, `token`
 *     and `destinationDex` are the pinned values, `destination` is on the pinned depository
 *     allow-list, and the primary type, domain and action all match.
 *
 * The pins (`token`, `destinationDex`, the depository allow-list and the amount's string form) are
 * the values three live `/quote/v2` reads recorded on 2026-10-18 (V-A part 2). With no pins every
 * check refuses: nothing is guessed.
 *
 * `packages/cli/src/hyperliquid-withdraw.ts` is a byte-identical copy of this file (a drift test
 * enforces it). Self-contained on purpose: it imports nothing.
 */

export type WithdrawAmountForm = "canonical" | "fixed6"

export interface PerpsWithdrawPins {
  token: string
  destinationDex: string
  /** Lowercase depository addresses. */
  depositories: readonly string[]
  amountForm: WithdrawAmountForm
}

/**
 * V-A part 2 (three live `/quote/v2` reads, 2026-10-18). One depository only, by the owner's D10
 * decision: if Relay rotates it, every withdrawal check refuses until a release records the new one.
 * Relay's guide example depository (0x865eb9ba...7081) is not on it.
 */
export const CANDLE_PERPS_WITHDRAW_PINS: PerpsWithdrawPins | null = {
  token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
  destinationDex: "",
  depositories: ["0x66cf0aace1b4e562593bec10ec7868fba9932224"],
  amountForm: "fixed6",
}

const ZERO = "0x0000000000000000000000000000000000000000"
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/

export const RELAY_NONCE_MAPPING_TYPES = {
  NonceMapping: [
    { name: "chainId", type: "string" },
    { name: "wallet", type: "address" },
    { name: "depositor", type: "address" },
    { name: "id", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
} as const

export const HYPERLIQUID_SEND_ASSET_TYPES = {
  "HyperliquidTransaction:SendAsset": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "sourceDex", type: "string" },
    { name: "destinationDex", type: "string" },
    { name: "token", type: "string" },
    { name: "amount", type: "string" },
    { name: "fromSubAccount", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
} as const

const SEND_ASSET_KEYS = HYPERLIQUID_SEND_ASSET_TYPES["HyperliquidTransaction:SendAsset"].map((field) => field.name)

// ── Amounts: integers only ────────────────────────────────────────────────────────────────────

const REQUEST_AMOUNT_RE = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/
const CANONICAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]{0,5}[1-9])?$/
const FIXED6_RE = /^(0|[1-9][0-9]*)\.[0-9]{6}$/

/** A withdrawal amount in USDC, at most 6 dp, as micros. Null when it is not one, or zero. */
export function parseWithdrawAmount(value: string): bigint | null {
  if (!REQUEST_AMOUNT_RE.test(value)) return null
  const [whole = "0", frac = ""] = value.split(".")
  const micros = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"))
  return micros > 0n ? micros : null
}

/** Micros as the canonical decimal: `5`, `5.5`, `0.000001`. */
export function formatWithdrawAmount(micros: bigint): string {
  const frac = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "")
  return frac ? `${micros / 1_000_000n}.${frac}` : `${micros / 1_000_000n}`
}

/** `sendAsset.amount` parsed exactly to micros, in the pinned form only. Null otherwise. */
export function parseSendAssetAmount(value: unknown, form: WithdrawAmountForm): bigint | null {
  if (typeof value !== "string" || !(form === "canonical" ? CANONICAL_RE : FIXED6_RE).test(value)) return null
  const [whole = "0", frac = ""] = value.split(".")
  if (frac.length > 6) return null
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"))
}

// ── The checks ───────────────────────────────────────────────────────────────────────────────

export type WithdrawCheck = { ok: true } | { ok: false; reason: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function sameEvm(a: unknown, b: string): boolean {
  return typeof a === "string" && EVM_ADDRESS_RE.test(a) && a.toLowerCase() === b.toLowerCase()
}

function typesMatch(types: unknown, expected: Record<string, readonly { name: string; type: string }[]>): boolean {
  if (!isObject(types) || !exactKeys(types, Object.keys(expected))) return false
  return Object.entries(expected).every(([key, want]) => {
    const fields = types[key]
    return (
      Array.isArray(fields) &&
      fields.length === want.length &&
      fields.every(
        (field, i) =>
          isObject(field) &&
          exactKeys(field, ["name", "type"]) &&
          field.name === want[i]?.name &&
          field.type === want[i]?.type,
      )
    )
  })
}

function domainMatches(domain: unknown, expected: { name: string; version: string; chainId: number }): boolean {
  return (
    isObject(domain) &&
    exactKeys(domain, ["name", "version", "chainId", "verifyingContract"]) &&
    domain.name === expected.name &&
    domain.version === expected.version &&
    domain.chainId === expected.chainId &&
    typeof domain.verifyingContract === "string" &&
    domain.verifyingContract.toLowerCase() === ZERO
  )
}

/** What `POST /agent/perps/withdraw` answers for a quoted withdrawal. */
export interface PerpsWithdrawBuild {
  id: string
  status: string
  from: { walletId: string; address: string; network: string }
  to: { chain: "solana" | "hood"; walletId: string; address: string }
  amountUsdc: string
  feesUsdc: string
  netUsdc: string
  minimumOutUsdc: string
  /** Relay's step tracking id, for status reads. It is not the NonceMapping id. */
  relayRequestId: string
  /**
   * Relay `protocol.v2.orderId`. The NonceMapping `id` must equal this bytes32. Absent on a build
   * the server could not check; signing refuses, with no fallback to `relayRequestId`.
   */
  relayOrderId?: string
  nonce: number
  expiresAt: number
  typedData?: { domain: unknown; types: unknown; primary_type: string; message: Record<string, unknown> }
}

/** What `POST /agent/perps/withdraw/authorize` answers once Relay accepted the mapping. */
export interface PerpsWithdrawAuthorization {
  id: string
  status: string
  nonce: number
  typedData: { domain: unknown; types: unknown; primary_type: string; message: Record<string, unknown> }
  action: Record<string, unknown>
}

/**
 * Before the NonceMapping is signed. `account` is this key's EVM TEE address; `ownDestinations`
 * holds this key's own wallet addresses on the chain asked for (the Solana TEE wallet, or the EVM
 * TEE wallet itself for Hood).
 */
export function verifyWithdrawMapping(
  build: PerpsWithdrawBuild,
  expect: {
    id: string
    account: string
    to: "solana" | "hood"
    amountMicros: bigint
    ownDestinations: readonly string[]
    pins: PerpsWithdrawPins | null
  },
): WithdrawCheck {
  const refuse = (reason: string): WithdrawCheck => ({ ok: false, reason })
  if (expect.pins === null) return refuse("no withdrawal pins are set")
  if (build.id !== expect.id) return refuse("the build names another withdrawal id")
  if (!sameEvm(build.from?.address, expect.account)) return refuse("the build withdraws from another account")
  if (build.to?.chain !== expect.to) return refuse(`the build lands on ${String(build.to?.chain)}, not ${expect.to}`)
  const destination = build.to.address
  const own = expect.ownDestinations.some((address) =>
    address.startsWith("0x") ? sameEvm(destination, address) : destination === address,
  )
  if (!own) return refuse("the build lands on a wallet that is not this key's own")
  if (parseWithdrawAmount(build.amountUsdc) !== expect.amountMicros) return refuse("the build is for another amount")
  const typed = build.typedData
  if (!isObject(typed) || typed.primary_type !== "NonceMapping") return refuse("the typed data is not a NonceMapping")
  if (!domainMatches(typed.domain, { name: "RelayNonceMapping", version: "2", chainId: 1 }))
    return refuse("the NonceMapping domain is not Relay's")
  if (!typesMatch(typed.types, RELAY_NONCE_MAPPING_TYPES)) return refuse("the NonceMapping type list differs")
  const message = typed.message
  if (!isObject(message) || !exactKeys(message, ["chainId", "wallet", "depositor", "id", "nonce"]))
    return refuse("the NonceMapping message has other fields")
  if (message.chainId !== "hyperliquid") return refuse("the NonceMapping names another chain")
  if (!sameEvm(message.wallet, expect.account)) return refuse("the NonceMapping wallet is not this key's account")
  if (!sameEvm(message.depositor, expect.account)) return refuse("the NonceMapping depositor is not this key's account")
  if (typeof build.relayOrderId !== "string" || !BYTES32_RE.test(build.relayOrderId))
    return refuse("the build has no Relay order id")
  if (typeof message.id !== "string" || !BYTES32_RE.test(message.id) || message.id !== build.relayOrderId)
    return refuse("the NonceMapping names another Relay order")
  if (message.nonce !== build.nonce || !Number.isSafeInteger(build.nonce) || build.nonce <= 0)
    return refuse("the NonceMapping nonce is not the build's")
  return { ok: true }
}

/** Before the SendAsset is signed: everything pinned, the nonce the mapping's, the amount exact. */
export function verifyWithdrawSendAsset(
  authorization: PerpsWithdrawAuthorization,
  expect: { mappingNonce: number; amountMicros: bigint; pins: PerpsWithdrawPins | null },
): WithdrawCheck {
  const refuse = (reason: string): WithdrawCheck => ({ ok: false, reason })
  const pins = expect.pins
  if (pins === null) return refuse("no withdrawal pins are set")
  const typed = authorization.typedData
  if (!isObject(typed) || typed.primary_type !== "HyperliquidTransaction:SendAsset")
    return refuse("the typed data is not a SendAsset")
  if (!domainMatches(typed.domain, { name: "HyperliquidSignTransaction", version: "1", chainId: 42161 }))
    return refuse("the SendAsset domain is not Hyperliquid's user-signed domain")
  if (!typesMatch(typed.types, HYPERLIQUID_SEND_ASSET_TYPES)) return refuse("the SendAsset type list differs")
  const m = typed.message
  if (!isObject(m) || !exactKeys(m, SEND_ASSET_KEYS)) return refuse("the SendAsset message has other fields")
  if (m.hyperliquidChain !== "Mainnet") return refuse("the SendAsset is not on Mainnet")
  if (m.nonce !== expect.mappingNonce || authorization.nonce !== expect.mappingNonce)
    return refuse("the SendAsset nonce is not the NonceMapping's")
  if (parseSendAssetAmount(m.amount, pins.amountForm) !== expect.amountMicros)
    return refuse("the SendAsset amount is not the amount asked for")
  if (m.fromSubAccount !== "") return refuse("the SendAsset moves from a sub-account")
  if (m.sourceDex !== "") return refuse("the SendAsset moves from another dex")
  if (m.token !== pins.token) return refuse("the SendAsset moves another token")
  if (m.destinationDex !== pins.destinationDex) return refuse("the SendAsset names another destination dex")
  if (typeof m.destination !== "string" || !pins.depositories.includes(m.destination.toLowerCase()))
    return refuse("the SendAsset destination is not a Relay depository on the allow-list")
  // The action posted to Hyperliquid must be exactly what is signed.
  const action = authorization.action
  if (!isObject(action) || !exactKeys(action, ["type", "signatureChainId", ...SEND_ASSET_KEYS]))
    return refuse("the action has other fields")
  if (action.type !== "sendAsset" || action.signatureChainId !== "0xa4b1")
    return refuse("the action is not a sendAsset")
  for (const key of SEND_ASSET_KEYS) {
    if (action[key] !== m[key]) return refuse(`the action's ${key} differs from what is signed`)
  }
  return { ok: true }
}
