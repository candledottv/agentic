/**
 * The `SIGN-IN-WITH-X` proof that spends a wallet credit (spec 3.7 and 3.9): a call made without an
 * API key whose payment the server later credited leaves the credit with the paying wallet, and
 * only that wallet's own proof spends it. A per-use 402 carries a `sign-in-with-x` extension with a
 * server-issued nonce; this module answers it with a Sign-In With Solana message whose statement is
 * `Candle x402 spend_credit <address>`, signed by the vault key.
 *
 * The challenge is answered only for the API host this CLI is talking to, so a 402 relayed from
 * elsewhere cannot collect a proof for another domain. The message is built line for line as the
 * server's `siwsMessage` (`apps/api/src/services/x402/siwx.ts`), which is upstream's format.
 */
import { base58 } from "@scure/base"
import { encodeHeader } from "./codec"

export const SIWX_EXTENSION = "sign-in-with-x"

export interface SpendChallenge {
  domain: string
  uri: string
  version: string
  nonce: string
  issuedAt: string
  expirationTime?: string
  chainId: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The `spend_credit` challenge a 402 carries, when it is one this CLI will sign: for `apiHost`, on
 * `network`, with a nonce of the server's shape. Null otherwise.
 */
export function spendChallengeOf(
  extensions: Record<string, unknown> | undefined,
  apiHost: string,
  network: string,
): SpendChallenge | null {
  const extension = extensions?.[SIWX_EXTENSION]
  if (!isObject(extension) || !isObject(extension.info)) return null
  const info = extension.info
  const chains = Array.isArray(extension.supportedChains) ? extension.supportedChains : []
  const chain = chains.find((c) => isObject(c) && c.chainId === network && c.type === "ed25519")
  if (!chain) return null
  const { domain, uri, version, nonce, issuedAt, expirationTime } = info
  if (typeof domain !== "string" || domain !== apiHost) return null
  if (typeof uri !== "string" || typeof version !== "string" || typeof issuedAt !== "string") return null
  if (typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) return null
  if (expirationTime !== undefined && typeof expirationTime !== "string") return null
  try {
    if (new URL(uri).host !== apiHost) return null
  } catch {
    return null
  }
  return {
    domain,
    uri,
    version,
    nonce,
    issuedAt,
    ...(expirationTime !== undefined ? { expirationTime } : {}),
    chainId: network,
  }
}

export function spendStatement(address: string): string {
  return `Candle x402 spend_credit ${address}`
}

/** The SIWS message, as upstream's `formatSIWSMessage` and the server's `siwsMessage` build it. */
export function siwsMessage(challenge: SpendChallenge, address: string): string {
  const lines = [
    `${challenge.domain} wants you to sign in with your Solana account:`,
    address,
    "",
    spendStatement(address),
    "",
    `URI: ${challenge.uri}`,
    `Version: ${challenge.version}`,
    `Chain ID: ${challenge.chainId.split(":")[1] ?? ""}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${challenge.issuedAt}`,
  ]
  if (challenge.expirationTime) lines.push(`Expiration Time: ${challenge.expirationTime}`)
  return lines.join("\n")
}

/** The `SIGN-IN-WITH-X` header value: the proof's fields and a base58 ed25519 signature. */
export function spendProofHeader(
  challenge: SpendChallenge,
  address: string,
  sign: (message: Uint8Array) => Uint8Array,
): string {
  const signature = sign(new TextEncoder().encode(siwsMessage(challenge, address)))
  return encodeHeader({
    domain: challenge.domain,
    address,
    statement: spendStatement(address),
    uri: challenge.uri,
    version: challenge.version,
    chainId: challenge.chainId,
    type: "ed25519",
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    ...(challenge.expirationTime ? { expirationTime: challenge.expirationTime } : {}),
    signature: base58.encode(signature),
  })
}
