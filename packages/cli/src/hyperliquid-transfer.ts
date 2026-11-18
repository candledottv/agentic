/** BE-3765: local trust anchors and plaintext/type/action equality before signing a same-wallet move.
 * Copied byte for byte to SDK and MCP; never trust an exchange URL or token supplied by a build.
 */
export interface OwnTransferBuild {
  id: string
  status: string
  mode: "toDex" | "fromDex" | "toSpot" | "fromSpot"
  dex?: string
  nonce?: number
  typedData?: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    primary_type: string
    message: Record<string, unknown>
  }
  action?: Record<string, unknown>
}
export function transferAmountMicros(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(value)) return null
  const [whole = "0", fraction = ""] = value.split(".")
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"))
  return amount > 0n ? amount : null
}
export function verifyOwnTransferBuild(
  build: OwnTransferBuild,
  expect: {
    id: string
    account: string
    mode: OwnTransferBuild["mode"]
    dex?: string
    amountMicros: bigint | null
  },
): string | null {
  if (build.id !== expect.id || build.mode !== expect.mode || build.dex !== expect.dex)
    return "transfer identity differs"
  if (!Number.isSafeInteger(build.nonce) || Number(build.nonce) <= 0) return "invalid nonce"
  const typed = build.typedData
  const record = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value)
  if (
    !typed ||
    !build.action ||
    !record(build.action) ||
    !record(typed.domain) ||
    !record(typed.types) ||
    !record(typed.message)
  )
    return "missing or malformed typed data or action"
  const d = typed.domain
  if (
    Object.keys(d).sort().join() !== "chainId,name,verifyingContract,version" ||
    d.name !== "HyperliquidSignTransaction" ||
    d.version !== "1" ||
    Number(d.chainId) !== 42161 ||
    d.verifyingContract !== `0x${"0".repeat(40)}`
  )
    return "untrusted domain"
  const dex = expect.mode === "toDex" || expect.mode === "fromDex"
  const primary = dex ? "HyperliquidTransaction:SendAsset" : "HyperliquidTransaction:UsdClassTransfer"
  const fields = dex
    ? [
        ["hyperliquidChain", "string"],
        ["destination", "string"],
        ["sourceDex", "string"],
        ["destinationDex", "string"],
        ["token", "string"],
        ["amount", "string"],
        ["fromSubAccount", "string"],
        ["nonce", "uint64"],
      ]
    : [
        ["hyperliquidChain", "string"],
        ["amount", "string"],
        ["toPerp", "bool"],
        ["nonce", "uint64"],
      ]
  if (
    typed.primary_type !== primary ||
    Object.keys(typed.types).join() !== primary ||
    JSON.stringify(typed.types[primary]) !== JSON.stringify(fields.map(([name, type]) => ({ name, type })))
  )
    return "untrusted type"
  const m = typed.message
  if (
    Object.keys(m).sort().join() !==
      fields
        .map(([name]) => name)
        .sort()
        .join() ||
    m.hyperliquidChain !== "Mainnet" ||
    m.nonce !== build.nonce
  )
    return "message shape or nonce differs"
  const amount = transferAmountMicros(m.amount)
  if (amount === null || (expect.amountMicros !== null && amount !== expect.amountMicros)) return "amount differs"
  if (dex) {
    if (String(m.destination).toLowerCase() !== expect.account.toLowerCase()) return "destination is not this wallet"
    if (
      m.token !== "USDC:0x6d1e7cde53ba9467b783cb7c530ce054" ||
      m.fromSubAccount !== "" ||
      m.sourceDex !== (expect.mode === "toDex" ? "" : expect.dex) ||
      m.destinationDex !== (expect.mode === "toDex" ? expect.dex : "")
    )
      return "token, subaccount or dex differs"
  } else if (m.toPerp !== (expect.mode === "fromSpot")) return "direction differs"
  const action = { type: dex ? "sendAsset" : "usdClassTransfer", signatureChainId: "0xa4b1", ...m }
  const sorted = (value: Record<string, unknown>) =>
    JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
  if (sorted(build.action) !== sorted(action)) return "action differs from signed message"
  return null
}
