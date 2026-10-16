/**
 * Test support for SEC-003 (`solana-verify.ts`): real, decodable Solana transactions for the
 * transfer and swap rails, and a fake RPC that answers their lookups and simulation from a fixed
 * pre and post state. Built with `solana-lite`'s own compiler, so no Solana runtime is imported.
 * Used by `solana-verify.test.ts`, `commands/transfer.test.ts` and `commands/swap.test.ts`.
 */
import {
  type AccountView,
  associatedTokenAddress,
  compileLegacyMessage,
  createAssociatedTokenAccountIdempotent,
  decodePubkey,
  encodePubkey,
  type Instruction,
  SYSTEM_PROGRAM_ID,
  serializeSignedTransaction,
  systemTransfer,
  TOKEN_PROGRAM_ID,
  tokenTransferChecked,
} from "./solana-lite"

export const FIXTURE_BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"
/** A stand-in swap venue (any program a swap may call). */
export const FIXTURE_VENUE = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
/** The pool account the venue trades against: it gives the output and takes the input. */
export const FIXTURE_POOL = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"
export const RENT = 2_039_280n
export const NETWORK_FEE = 5_000n

export type AccountState = Record<string, AccountView | null>

export interface SolanaScenario {
  /** The unsigned transaction, base64, as Candle's build returns it. */
  transaction: string
  pre: AccountState
  post: AccountState
}

export function systemAccount(lamports: bigint): AccountView {
  return { owner: SYSTEM_PROGRAM_ID, lamports, data: new Uint8Array(0) }
}

export function tokenAccount(mint: string, owner: string, amount: bigint, lamports = RENT): AccountView {
  const data = new Uint8Array(165)
  data.set(decodePubkey(mint), 0)
  data.set(decodePubkey(owner), 32)
  new DataView(data.buffer).setBigUint64(64, amount, true)
  data[108] = 1
  return { owner: TOKEN_PROGRAM_ID, lamports, data }
}

export function ataOf(owner: string, mint: string): string {
  return encodePubkey(associatedTokenAddress(decodePubkey(owner), decodePubkey(mint)))
}

/** One unsigned legacy transaction: one zeroed signature slot for the fee payer, then the message. */
export function unsignedTransaction(feePayer: string, instructions: Instruction[]): string {
  const message = compileLegacyMessage({
    feePayer: decodePubkey(feePayer),
    recentBlockhash: FIXTURE_BLOCKHASH,
    instructions,
  })
  return Buffer.from(serializeSignedTransaction(message, new Uint8Array(64))).toString("base64")
}

/** Token `Approve` (4): the owner lets `delegate` move up to `amount` from `source`. */
export function tokenApprove(source: string, delegate: string, owner: string, amount: bigint): Instruction {
  const data = new Uint8Array(9)
  data[0] = 4
  new DataView(data.buffer).setBigUint64(1, amount, true)
  return {
    programId: decodePubkey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: decodePubkey(source), isSigner: false, isWritable: true },
      { pubkey: decodePubkey(delegate), isSigner: false, isWritable: false },
      { pubkey: decodePubkey(owner), isSigner: true, isWritable: false },
    ],
    data,
  }
}

/** Token `SetAuthority` (6), AccountOwner (2): `account` is handed to `next`. */
export function tokenSetOwner(account: string, owner: string, next: string): Instruction {
  const data = new Uint8Array(35)
  data[0] = 6
  data[1] = 2
  data[2] = 1
  data.set(decodePubkey(next), 3)
  return {
    programId: decodePubkey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: decodePubkey(account), isSigner: false, isWritable: true },
      { pubkey: decodePubkey(owner), isSigner: true, isWritable: false },
    ],
    data,
  }
}

/**
 * The honest transfer: SOL as one System transfer; a mint as an idempotent create of the
 * recipient's token account (paid by the wallet) and a `TransferChecked` into it.
 */
export function transferScenario(input: {
  wallet: string
  recipient: string
  asset: "SOL" | string
  amountRaw: bigint
  decimals?: number
}): SolanaScenario {
  const { wallet, recipient, asset, amountRaw } = input
  if (asset === "SOL") {
    return {
      transaction: unsignedTransaction(wallet, [
        systemTransfer(decodePubkey(wallet), decodePubkey(recipient), amountRaw),
      ]),
      pre: { [wallet]: systemAccount(amountRaw + 1_000_000_000n), [recipient]: systemAccount(1_000_000n) },
      post: {
        [wallet]: systemAccount(1_000_000_000n - NETWORK_FEE),
        [recipient]: systemAccount(1_000_000n + amountRaw),
      },
    }
  }
  const source = ataOf(wallet, asset)
  const destination = ataOf(recipient, asset)
  return {
    transaction: unsignedTransaction(wallet, [
      createAssociatedTokenAccountIdempotent({
        payer: decodePubkey(wallet),
        owner: decodePubkey(recipient),
        mint: decodePubkey(asset),
      }),
      tokenTransferChecked({
        source: decodePubkey(source),
        mint: decodePubkey(asset),
        destination: decodePubkey(destination),
        owner: decodePubkey(wallet),
        amount: amountRaw,
        decimals: input.decimals ?? 6,
      }),
    ]),
    pre: {
      [wallet]: systemAccount(1_000_000_000n),
      [source]: tokenAccount(asset, wallet, amountRaw + 7n),
      [destination]: null,
    },
    post: {
      [wallet]: systemAccount(1_000_000_000n - RENT - NETWORK_FEE),
      [source]: tokenAccount(asset, wallet, 7n),
      [destination]: tokenAccount(asset, recipient, amountRaw),
    },
  }
}

/**
 * The honest swap: one venue instruction over the wallet, its token accounts for each side and
 * the pool. The wallet pays `spendRaw` of `spend` into the pool and receives `receiveRaw` of
 * `receive` from it. `extra` instructions ride after it, for the tests that add one.
 */
export function swapScenario(input: {
  wallet: string
  spend: "SOL" | string
  spendRaw: bigint
  receive: "SOL" | string
  receiveRaw: bigint
  extra?: Instruction[]
}): SolanaScenario {
  const { wallet, spend, spendRaw, receive, receiveRaw } = input
  const pre: AccountState = { [wallet]: systemAccount(5_000_000_000n), [FIXTURE_POOL]: systemAccount(9_000_000_000n) }
  const post: AccountState = {}
  let walletLamports = 5_000_000_000n - NETWORK_FEE
  let poolLamports = 9_000_000_000n
  const keys = [decodePubkey(wallet)]
  for (const [mint, delta] of [
    [spend, -spendRaw],
    [receive, receiveRaw],
  ] as const) {
    if (mint === "SOL") {
      walletLamports += delta
      poolLamports -= delta
      continue
    }
    const own = ataOf(wallet, mint)
    const pool = ataOf(FIXTURE_POOL, mint)
    pre[own] = tokenAccount(mint, wallet, 10_000_000_000n)
    pre[pool] = tokenAccount(mint, FIXTURE_POOL, 10_000_000_000n)
    post[own] = tokenAccount(mint, wallet, 10_000_000_000n + delta)
    post[pool] = tokenAccount(mint, FIXTURE_POOL, 10_000_000_000n - delta)
    keys.push(decodePubkey(own), decodePubkey(pool))
  }
  post[wallet] = systemAccount(walletLamports)
  post[FIXTURE_POOL] = systemAccount(poolLamports)
  keys.push(decodePubkey(FIXTURE_POOL))
  const venue: Instruction = {
    programId: decodePubkey(FIXTURE_VENUE),
    keys: keys.map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: true })),
    data: new Uint8Array([1, 2, 3]),
  }
  return { transaction: unsignedTransaction(wallet, [venue, ...(input.extra ?? [])]), pre, post }
}

function wireAccount(view: AccountView | null | undefined): unknown {
  if (!view) return null
  return {
    owner: view.owner,
    lamports: Number(view.lamports),
    data: [Buffer.from(view.data).toString("base64"), "base64"],
    executable: false,
    rentEpoch: 0,
  }
}

/**
 * The JSON-RPC `result` for the two reads the verifier makes, or undefined for any other method.
 * An account the post state does not name is unchanged by the simulation.
 */
export function scenarioRpcResult(
  scenario: Pick<SolanaScenario, "pre" | "post">,
  method: string,
  params: unknown[],
  err: unknown = null,
): unknown {
  if (method === "getMultipleAccounts") {
    const addresses = params[0] as string[]
    return { context: { slot: 1 }, value: addresses.map((address) => wireAccount(scenario.pre[address])) }
  }
  if (method === "simulateTransaction") {
    const addresses = ((params[1] as { accounts?: { addresses?: string[] } })?.accounts?.addresses ?? []) as string[]
    return {
      context: { slot: 1 },
      value: {
        err,
        logs: [],
        accounts: addresses.map((address) =>
          wireAccount(address in scenario.post ? scenario.post[address] : scenario.pre[address]),
        ),
        unitsConsumed: 1000,
      },
    }
  }
  return undefined
}
