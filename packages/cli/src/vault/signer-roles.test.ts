/**
 * BE-296 (spec `2026-09-23-cli-vault-promote-confirm-design.md`, §6): the signer-role read at unit
 * level. T9 pins every filter's bytes and offsets; T11, T11a, T12, T12a and T13 run the scheduler
 * at 1 and 2 in flight against a scripted fake RPC with an injected clock, so no test waits on a
 * real timer; the last describe pins the words the two commands print from.
 */
import { describe, expect, test } from "bun:test"
import { base58, base64 } from "@scure/base"
import { Keypair } from "@solana/web3.js"
import {
  createSolanaRpc,
  PROGRAM_ACCOUNTS_V2_LIMIT,
  type ProgramAccountFilter,
  type SolanaRpc,
  SolanaRpcError,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../solana-lite"
import { createFakeClock, createRoutedFetch, jsonResponse } from "../test-support"
import {
  authoritiesBlock,
  authoritiesCountLine,
  authorityCell,
  BPF_UPGRADEABLE_LOADER_ID,
  checkDoneLine,
  checkOpeningLine,
  findingLine,
  formatDuration,
  keysWithFindings,
  MAX_V2_PAGES,
  NOT_CHECKED_LINE,
  programIdFilters,
  programUpgradeFilters,
  progressLine,
  REQUESTS_PER_KEY,
  ROLE_GROUP_IDS,
  ROLE_GROUPS,
  type RoleGroupId,
  type RoleProgress,
  readSignerRoles,
  readSummaryLine,
  type SignerRolesResult,
  STAKE_PROGRAM_ID,
  sentenceForm,
  stakeStakerFilters,
  stakeWithdrawerFilters,
  token2022FreezeFilters,
  token2022MintFilters,
  tokenFreezeFilters,
  tokenMintFilters,
} from "./signer-roles"

const KEY = Keypair.generate().publicKey
const KEY_BYTES = KEY.toBytes()
const OTHER = Keypair.generate().publicKey.toBase58()
const b64 = (bytes: number[] | Uint8Array) => base64.encode(Uint8Array.from(bytes))
const memcmp = (offset: number, bytes: number[] | Uint8Array): ProgramAccountFilter => ({
  memcmp: { offset, bytes: b64(bytes), encoding: "base64" },
})

describe("T9: the filter builders produce the D6 bytes and offsets", () => {
  test("SPL Token mint and freeze: dataSize 82, COption tag 01 00 00 00 then the key, at 0 and 46", () => {
    expect(tokenMintFilters(KEY_BYTES)).toEqual([{ dataSize: 82 }, memcmp(0, [1, 0, 0, 0, ...KEY_BYTES])])
    expect(tokenFreezeFilters(KEY_BYTES)).toEqual([{ dataSize: 82 }, memcmp(46, [1, 0, 0, 0, ...KEY_BYTES])])
  })

  test("Token-2022: two shapes each, the 82-byte mint and the offset-165 account-type byte", () => {
    expect(token2022MintFilters(KEY_BYTES)).toEqual([
      [{ dataSize: 82 }, memcmp(0, [1, 0, 0, 0, ...KEY_BYTES])],
      [memcmp(165, [1]), memcmp(0, [1, 0, 0, 0, ...KEY_BYTES])],
    ])
    expect(token2022FreezeFilters(KEY_BYTES)).toEqual([
      [{ dataSize: 82 }, memcmp(46, [1, 0, 0, 0, ...KEY_BYTES])],
      [memcmp(165, [1]), memcmp(46, [1, 0, 0, 0, ...KEY_BYTES])],
    ])
  })

  test("program upgrade: ProgramData tag 03 00 00 00 at 0 and the u8 COption tag then the key at 12; the resolve is tag 02 at 0 and the ProgramData at 4", () => {
    expect(programUpgradeFilters(KEY_BYTES)).toEqual([memcmp(0, [3, 0, 0, 0]), memcmp(12, [1, ...KEY_BYTES])])
    expect(programIdFilters(KEY_BYTES)).toEqual([memcmp(0, [2, 0, 0, 0]), memcmp(4, KEY_BYTES)])
  })

  test("stake: dataSize 200, the bare key at 12 (staker) and 44 (withdrawer), no tag filter", () => {
    expect(stakeStakerFilters(KEY_BYTES)).toEqual([{ dataSize: 200 }, memcmp(12, KEY_BYTES)])
    expect(stakeWithdrawerFilters(KEY_BYTES)).toEqual([{ dataSize: 200 }, memcmp(44, KEY_BYTES)])
    // Nothing in either shape says which enum tag the account carries.
    for (const filter of [...stakeStakerFilters(KEY_BYTES), ...stakeWithdrawerFilters(KEY_BYTES)]) {
      if ("memcmp" in filter) expect(filter.memcmp.offset).not.toBe(0)
    }
  })

  test("seven groups in D6 order, the right programs, nine requests per key", () => {
    expect(ROLE_GROUPS.map((group) => group.id)).toEqual([...ROLE_GROUP_IDS])
    expect(ROLE_GROUPS.map((group) => group.programId)).toEqual([
      TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      BPF_UPGRADEABLE_LOADER_ID,
      STAKE_PROGRAM_ID,
      STAKE_PROGRAM_ID,
    ])
    const perKey = ROLE_GROUPS.reduce((n, group) => n + group.shapes(KEY_BYTES).length, 0)
    expect(perKey).toBe(REQUESTS_PER_KEY)
    expect(perKey).toBe(9)
  })
})

// ── The scheduler ───────────────────────────────────────────────────────────────────────────

interface Seen {
  method: string
  programId: string
  filters: ProgramAccountFilter[]
  /** Present only on a `getProgramAccountsV2` page after the first. */
  paginationKey?: string
  limit?: number
  dataSlice?: { offset: number; length: number }
  withContext?: boolean
  signal: AbortSignal | undefined
  n: number
  /** Requests in flight the moment this one was issued, itself included. */
  activeAtIssue: number
}

type ScriptedPage = { pubkeys: string[]; paginationKey: string | null }
type Scripted = Response | string[] | ScriptedPage

/** A fake RPC over a routed fetch, so the methods under test are the real client methods. */
function fakeRpc(answer: (seen: Seen) => Scripted | Promise<Scripted>): {
  rpc: SolanaRpc
  seen: Seen[]
  inFlight: () => number
  maxInFlight: () => number
} {
  const seen: Seen[] = []
  let active = 0
  let max = 0
  const { fetch } = createRoutedFetch({
    "/rpc": async (req) => {
      const body = JSON.parse(req.init.body as string) as {
        id: unknown
        method: string
        params: [
          string,
          {
            filters: ProgramAccountFilter[]
            paginationKey?: string
            limit?: number
            dataSlice?: { offset: number; length: number }
            withContext?: boolean
          },
        ]
      }
      active += 1
      max = Math.max(max, active)
      const config = body.params[1]
      const call: Seen = {
        method: body.method,
        programId: body.params[0],
        filters: config.filters,
        ...(config.paginationKey !== undefined ? { paginationKey: config.paginationKey } : {}),
        ...(config.limit !== undefined ? { limit: config.limit } : {}),
        ...(config.dataSlice !== undefined ? { dataSlice: config.dataSlice } : {}),
        ...(config.withContext !== undefined ? { withContext: config.withContext } : {}),
        signal: req.init.signal ?? undefined,
        n: seen.length,
        activeAtIssue: active,
      }
      seen.push(call)
      try {
        const out = await answer(call)
        if (out instanceof Response) return out
        const pubkeys = Array.isArray(out) ? out : out.pubkeys
        const accounts = pubkeys.map((pubkey) => ({ pubkey, account: { data: ["", "base64"] } }))
        // V2's documented shape with `withContext` omitted: accounts and paginationKey on `result`.
        if (body.method === "getProgramAccountsV2") {
          const paginationKey = Array.isArray(out) ? null : out.paginationKey
          return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: { accounts, paginationKey } })
        }
        return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: accounts })
      } finally {
        active -= 1
      }
    },
  })
  return { rpc: createSolanaRpc("https://rpc.test/rpc", fetch), seen, inFlight: () => active, maxInFlight: () => max }
}

/** The refusal Helius returned for the SPL Token and Token-2022 programs on 2026-09-23. */
const HELIUS_PAGINATION_REFUSAL =
  "Too many accounts requested (Large number of pubkeys), Please use getProgramAccountsV2 with pagination to handle large datasets. See: https://www.helius.dev/docs/api-reference/rpc/http/getprogramaccountsv2"
const HELIUS_PAGINATION_REASON = `RPC error -32600 ${HELIUS_PAGINATION_REFUSAL}`

const groupOf = (seen: Seen): RoleGroupId => {
  const dataSize = seen.filters.find((f): f is { dataSize: number } => "dataSize" in f)?.dataSize
  const offsets = seen.filters
    .filter((f): f is Extract<ProgramAccountFilter, { memcmp: unknown }> => "memcmp" in f)
    .map((f) => f.memcmp.offset)
  if (seen.programId === TOKEN_PROGRAM_ID) return offsets.includes(46) ? "token-freeze" : "token-mint"
  if (seen.programId === TOKEN_2022_PROGRAM_ID) return offsets.includes(46) ? "token2022-freeze" : "token2022-mint"
  if (seen.programId === BPF_UPGRADEABLE_LOADER_ID) return "program-upgrade"
  if (dataSize === 200) return offsets.includes(44) ? "stake-withdrawer" : "stake-staker"
  throw new Error(`unrecognised request ${JSON.stringify(seen.filters)}`)
}

const rpcError = (code: number, message: string) =>
  jsonResponse(200, { jsonrpc: "2.0", id: 1, error: { code, message } })

describe("readSignerRoles: the scheduler (D7)", () => {
  const addresses = [KEY.toBase58(), OTHER]

  test("every group read for two keys: 18 requests, group-major, all seven checked, nothing found", async () => {
    const clock = createFakeClock()
    const { rpc, seen } = fakeRpc(() => [])
    const result = await readSignerRoles(rpc, addresses, { ...clock, inFlight: 8 })
    expect(result.requests).toBe(18)
    expect(result.planned).toBe(18)
    expect(result.checked).toEqual([...ROLE_GROUP_IDS])
    expect(result.notChecked).toEqual([])
    expect(result.found).toEqual([])
    // Group-major: the first two are both SPL mint, one per key, then both SPL freeze, and so on.
    expect(seen.slice(0, 4).map(groupOf)).toEqual(["token-mint", "token-mint", "token-freeze", "token-freeze"])
    expect(seen.map(groupOf)).toEqual(
      [...seen.map(groupOf)].sort((a, b) => ROLE_GROUP_IDS.indexOf(a) - ROLE_GROUP_IDS.indexOf(b)),
    )
    expect(sentenceForm(result)).toBe("N")
  })

  test("T11: at 1 in flight, a 403 on the first SPL-mint request makes exactly one request in that group; the run continues", async () => {
    const clock = createFakeClock()
    const { rpc, seen } = fakeRpc((call) =>
      groupOf(call) === "token-mint" ? jsonResponse(403, { error: "Your IP or provider is blocked" }) : [],
    )
    const result = await readSignerRoles(rpc, addresses, { ...clock, inFlight: 1 })
    expect(seen.filter((call) => groupOf(call) === "token-mint")).toHaveLength(1)
    expect(result.requests).toBe(17)
    expect(result.notChecked).toEqual([{ group: "token-mint", reason: "HTTP 403" }])
    expect(result.checked).toEqual(ROLE_GROUP_IDS.filter((id) => id !== "token-mint"))
    expect(sentenceForm(result)).toBe("U")
    expect(authorityCell(KEY.toBase58(), result)).toBe("?")
  })

  test("T11a: at 2 in flight, at most two requests are made in the failed group, and none after", async () => {
    const clock = createFakeClock()
    const { rpc, seen } = fakeRpc((call) =>
      groupOf(call) === "token2022-mint" ? rpcError(-32602, "INVALID_PARAMS") : [],
    )
    const result = await readSignerRoles(rpc, addresses, { ...clock, inFlight: 2 })
    const inGroup = seen.filter((call) => groupOf(call) === "token2022-mint")
    expect(inGroup.length).toBeLessThanOrEqual(2)
    expect(inGroup.length).toBeGreaterThanOrEqual(1)
    expect(result.notChecked).toEqual([{ group: "token2022-mint", reason: "RPC error -32602 INVALID_PARAMS" }])
    // The other Token-2022 group is untouched by its sibling's failure.
    expect(result.checked).toContain("token2022-freeze")
  })

  test("T12: a request that outlives the timeout stops its group like a 403, and its signal is aborted", async () => {
    const clock = createFakeClock()
    const { rpc, seen } = fakeRpc(
      (call) =>
        new Promise((resolve, reject) => {
          if (groupOf(call) !== "stake-staker") {
            resolve([])
            return
          }
          // Never answers on its own; the scheduler's timer aborts it, and like a real fetch the
          // request then rejects with an AbortError.
          call.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })),
          )
        }),
    )
    const result = await readSignerRoles(rpc, addresses, { ...clock, inFlight: 1, timeoutMs: 20 })
    expect(seen.filter((call) => groupOf(call) === "stake-staker")).toHaveLength(1)
    expect(result.notChecked).toEqual([{ group: "stake-staker", reason: "timed out after 0 s" }])
    expect(result.checked).toContain("stake-withdrawer")
  })

  test("T12a: a 429 with Retry-After is retried after that wait through the injected sleep, and the run stays at one in flight", async () => {
    const clock = createFakeClock()
    let limited = false
    const { rpc, seen, maxInFlight } = fakeRpc(async (call) => {
      // The very first request is throttled once; everything after answers, slowly enough that
      // concurrency would show.
      if (call.n === 0 && !limited) {
        limited = true
        return jsonResponse(429, {}, { "retry-after": "1" })
      }
      await new Promise((resolve) => setTimeout(resolve, 2))
      return []
    })
    const result = await readSignerRoles(rpc, addresses, { ...clock, inFlight: 1 })
    expect(clock.calls).toEqual([1000])
    expect(result.rateLimited).toBe(1)
    expect(result.requests).toBe(19)
    expect(result.notChecked).toEqual([])
    expect(seen).toHaveLength(19)

    // Now at 8 in flight: the first answer is a 429. The other seven of the opening burst were
    // already in flight and finish on their own, and the throttled request is retried at once;
    // every request the scheduler ISSUES after that is issued alone, for the rest of the run.
    const clock8 = createFakeClock()
    let seenLimit = false
    const eight = fakeRpc(async (call) => {
      if (!seenLimit) {
        seenLimit = true
        return jsonResponse(429, {})
      }
      await new Promise((resolve) => setTimeout(resolve, 2))
      void call
      return []
    })
    const r8 = await readSignerRoles(eight.rpc, addresses, { ...clock8, inFlight: 8 })
    expect(clock8.calls).toEqual([2000])
    expect(r8.rateLimited).toBe(1)
    expect(r8.requests).toBe(19)
    expect(eight.maxInFlight()).toBe(8)
    // Request 8 is the retry of request 0 (same group, same filters), issued while the burst is
    // still in flight; requests 9 onwards each start with nothing else in flight.
    expect(eight.seen[8]?.filters).toEqual(eight.seen[0]?.filters)
    expect(eight.seen.slice(9).map((call) => call.activeAtIssue)).toEqual(Array(10).fill(1))
  })

  test("T12a: a 429 that fails five retries is a group failure, and the sleeps are the 2 s default", async () => {
    const clock = createFakeClock()
    const { rpc, seen } = fakeRpc((call) => (groupOf(call) === "token-freeze" ? jsonResponse(429, {}) : []))
    const result = await readSignerRoles(rpc, addresses, { ...clock, inFlight: 1 })
    expect(result.notChecked).toEqual([{ group: "token-freeze", reason: "HTTP 429 after 5 retries" }])
    expect(seen.filter((call) => groupOf(call) === "token-freeze")).toHaveLength(6)
    expect(clock.calls).toEqual([2000, 2000, 2000, 2000, 2000])
  })

  test("T13: an upgrade hit resolves its program id with one more request; one that does not resolve names the ProgramData and says so", async () => {
    const programData = Keypair.generate().publicKey.toBase58()
    const programId = Keypair.generate().publicKey.toBase58()
    const orphanData = Keypair.generate().publicKey.toBase58()
    const clock = createFakeClock()
    const { rpc, seen } = fakeRpc((call) => {
      if (call.programId !== BPF_UPGRADEABLE_LOADER_ID) return []
      const first = call.filters[0]
      const tag = first && "memcmp" in first ? first.memcmp.bytes : ""
      if (tag === b64([3, 0, 0, 0])) {
        // The ProgramData scan: key 1 holds two upgrade authorities, key 2 none.
        const second = call.filters[1]
        const who = second && "memcmp" in second ? second.memcmp.bytes : ""
        return who === b64([1, ...KEY_BYTES]) ? [programData, orphanData] : []
      }
      // The resolve: only `programData` has a Program account.
      const second = call.filters[1]
      const which = second && "memcmp" in second ? second.memcmp.bytes : ""
      return which === b64(base58.decode(programData)) ? [programId] : []
    })
    const result = await readSignerRoles(rpc, addresses, { ...clock, inFlight: 1 })
    const loaderCalls = seen.filter((call) => call.programId === BPF_UPGRADEABLE_LOADER_ID)
    // Two scans (one per key) plus two resolves (one per hit).
    expect(loaderCalls).toHaveLength(4)
    expect(result.requests).toBe(20)
    expect(result.found).toEqual([
      { address: KEY.toBase58(), role: "upgrade", program: "bpf-upgradeable-loader", target: programId },
      {
        address: KEY.toBase58(),
        role: "upgrade",
        program: "bpf-upgradeable-loader",
        target: orphanData,
        unresolvedProgram: true,
      },
    ])
    expect(findingLine(result.found[0] as (typeof result.found)[number])).toBe(
      `upgrade authority of ${programId} (BPF Upgradeable Loader)`,
    )
    expect(findingLine(result.found[1] as (typeof result.found)[number])).toBe(
      `upgrade authority of ${orphanData} (ProgramData account; the program id could not be resolved) (BPF Upgradeable Loader)`,
    )
    expect(sentenceForm(result)).toBe("F")
    // `k` counts keys, not findings.
    expect(keysWithFindings(result)).toBe(1)
  })

  test("a malformed answer (null result) is a group failure, never an empty scan", async () => {
    const clock = createFakeClock()
    const { rpc } = fakeRpc((call) =>
      groupOf(call) === "stake-withdrawer" ? jsonResponse(200, { jsonrpc: "2.0", id: 1, result: null }) : [],
    )
    const result = await readSignerRoles(rpc, addresses, { ...clock, inFlight: 1 })
    expect(result.notChecked).toEqual([
      { group: "stake-withdrawer", reason: "RPC getProgramAccounts answered without an account list" },
    ])
  })

  test("left after four groups refuse is the remaining served requests at the observed per-request time", async () => {
    // 146 keys, 1 in flight. The four token groups fail on their first call; every issued call
    // takes perRequestMs on the fake clock. Skips must not count as finished, or `left`
    // collapses the way the public-endpoint run's "about 46 s" did.
    const keys = Array.from({ length: 146 }, () => Keypair.generate().publicKey.toBase58())
    const refused = new Set<RoleGroupId>(["token-mint", "token-freeze", "token2022-mint", "token2022-freeze"])
    const perRequestMs = 1_000
    const clock = createFakeClock()
    const samples: RoleProgress[] = []
    const { rpc } = fakeRpc(async (call) => {
      await clock.sleep(perRequestMs)
      return refused.has(groupOf(call)) ? jsonResponse(403, { error: "blocked" }) : []
    })
    const result = await readSignerRoles(rpc, keys, {
      ...clock,
      inFlight: 1,
      onProgress: (progress) => samples.push(progress),
    })
    expect(result.notChecked.map((entry) => entry.group)).toEqual([...refused])
    expect(result.requests).toBe(4 + 146 * 3)

    const after = samples.find(
      (sample) => sample.refusedGroups === 4 && sample.elapsedMs >= 5_000 && sample.settled > 4,
    )
    expect(after).toBeDefined()
    const sample = after as RoleProgress
    const servedSettled = sample.settled - 4
    const remainingServed = 146 * 3 - servedSettled
    const observed = sample.elapsedMs / sample.settled
    const left = progressLine(sample).match(/about (\d+) s left/)
    expect(left).not.toBeNull()
    const leftMs = Number(left?.[1]) * 1000
    expect(leftMs).toBeGreaterThanOrEqual(remainingServed * observed)
    // The refused groups' unissued calls are skipped, not settled.
    expect(sample.skipped).toBe(146 * 6 - 4)
    expect(sample.completed).toBe(sample.settled + sample.skipped)
  }, 20_000)

  test("no addresses: no requests, every group trivially checked", async () => {
    const clock = createFakeClock()
    const { rpc, seen } = fakeRpc(() => [])
    const result = await readSignerRoles(rpc, [], clock)
    expect(seen).toHaveLength(0)
    expect(result).toMatchObject({ requests: 0, planned: 0, notChecked: [], found: [] })
    expect(result.checked).toEqual([...ROLE_GROUP_IDS])
  })

  test("SolanaRpcError carries the status, the Retry-After and the RPC code, with the message unchanged", async () => {
    const { fetch } = createRoutedFetch({
      "/rpc": [
        () => jsonResponse(429, {}, { "retry-after": "3" }),
        () => rpcError(-32602, "INVALID_PARAMS"),
        () => jsonResponse(200, { jsonrpc: "2.0", id: 3, result: { value: 1 } }),
      ],
    })
    const rpc = createSolanaRpc("https://rpc.test/rpc", fetch)
    const first = await rpc.getProgramAccounts(TOKEN_PROGRAM_ID, []).catch((error) => error)
    expect(first).toBeInstanceOf(SolanaRpcError)
    expect(first).toMatchObject({ status: 429, retryAfterMs: 3000, message: "RPC getProgramAccounts failed: HTTP 429" })
    const second = await rpc.getProgramAccounts(TOKEN_PROGRAM_ID, []).catch((error) => error)
    expect(second).toMatchObject({ rpcCode: -32602, message: "RPC getProgramAccounts failed: -32602 INVALID_PARAMS" })
    // An existing method's throw is byte-identical to what it was before the class existed.
    const third = await rpc.getBalance(OTHER)
    expect(third).toBe(1n)
  })

  test("getProgramAccountsV2 sends one Helius page: limit 1000, no withContext, cursor only from page 2", async () => {
    const mint = Keypair.generate().publicKey.toBase58()
    const filters = tokenMintFilters(KEY_BYTES)
    const { fetch, calls } = createRoutedFetch({
      "/rpc": [
        () =>
          jsonResponse(200, {
            jsonrpc: "2.0",
            id: 1,
            result: { accounts: [{ pubkey: mint, account: { data: ["", "base64"] } }], paginationKey: "cursor-2" },
          }),
        () => jsonResponse(200, { jsonrpc: "2.0", id: 2, result: { accounts: [], paginationKey: null } }),
        () => jsonResponse(200, { jsonrpc: "2.0", id: 3, result: { paginationKey: null } }),
      ],
    })
    const rpc = createSolanaRpc("https://rpc.test/rpc", fetch)
    const first = await rpc.getProgramAccountsV2(TOKEN_PROGRAM_ID, filters)
    expect(first).toEqual({ pubkeys: [mint], paginationKey: "cursor-2" })
    const second = await rpc.getProgramAccountsV2(TOKEN_PROGRAM_ID, filters, { paginationKey: "cursor-2" })
    expect(second).toEqual({ pubkeys: [], paginationKey: null })
    const bodies = calls.map(
      (call) =>
        JSON.parse(call.init.body as string) as { jsonrpc: string; id: number; method: string; params: unknown[] },
    )
    expect(bodies[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "getProgramAccountsV2",
      params: [
        TOKEN_PROGRAM_ID,
        {
          encoding: "base64",
          commitment: "finalized",
          dataSlice: { offset: 0, length: 0 },
          filters,
          limit: PROGRAM_ACCOUNTS_V2_LIMIT,
        },
      ],
    })
    expect(PROGRAM_ACCOUNTS_V2_LIMIT).toBe(1000)
    const secondConfig = (bodies[1]?.params[1] ?? {}) as { paginationKey?: string; withContext?: boolean }
    expect(secondConfig.paginationKey).toBe("cursor-2")
    expect(secondConfig.withContext).toBeUndefined()
    const broken = await rpc.getProgramAccountsV2(TOKEN_PROGRAM_ID, filters).catch((error) => error)
    expect(broken).toMatchObject({ message: "RPC getProgramAccountsV2 answered without an account list" })
  })

  test("a token group refused with -32600 is checked via two V2 pages, including a finding that is only on page 2", async () => {
    const mint = Keypair.generate().publicKey.toBase58()
    const clock = createFakeClock()
    const samples: RoleProgress[] = []
    const keyBytes = b64([1, 0, 0, 0, ...KEY_BYTES])
    const { rpc, seen, maxInFlight } = fakeRpc((call) => {
      if (groupOf(call) !== "token-mint") return []
      if (call.method === "getProgramAccounts") return rpcError(-32600, HELIUS_PAGINATION_REFUSAL)
      const authority = call.filters.find((filter) => "memcmp" in filter)
      const isFirstKey = authority !== undefined && "memcmp" in authority && authority.memcmp.bytes === keyBytes
      // An empty page with a cursor is not the end (Helius: keep going until paginationKey is null).
      if (isFirstKey && call.paginationKey === undefined) return { pubkeys: [], paginationKey: "cursor-2" }
      if (isFirstKey && call.paginationKey === "cursor-2") return { pubkeys: [mint], paginationKey: null }
      return { pubkeys: [], paginationKey: null }
    })
    const result = await readSignerRoles(rpc, addresses, {
      ...clock,
      inFlight: 1,
      onProgress: (progress) => samples.push(progress),
    })
    expect(result.checked).toContain("token-mint")
    expect(result.notChecked).toEqual([])
    expect(result.found).toEqual([{ address: KEY.toBase58(), role: "mint", program: "token", target: mint }])
    // 18 shapes, plus the second page. The v1 probe is a request and not a page.
    expect(result.planned).toBe(19)
    expect(result.requests).toBe(20)
    expect(maxInFlight()).toBe(1)

    const mintCalls = seen.filter((call) => groupOf(call) === "token-mint")
    expect(mintCalls.map((call) => call.method)).toEqual([
      "getProgramAccounts",
      "getProgramAccountsV2",
      "getProgramAccountsV2",
      "getProgramAccountsV2",
    ])
    expect(mintCalls[1]?.paginationKey).toBeUndefined()
    expect(mintCalls[2]?.paginationKey).toBe("cursor-2")
    expect(mintCalls[3]?.paginationKey).toBeUndefined()
    for (const call of mintCalls) {
      expect(call.filters.some((filter) => "dataSize" in filter && filter.dataSize === 82)).toBe(true)
    }
    for (const call of mintCalls.filter((call) => call.method === "getProgramAccountsV2")) {
      expect(call.limit).toBe(1000)
      expect(call.dataSlice).toEqual({ offset: 0, length: 0 })
      expect(call.withContext).toBeUndefined()
    }
    // The second key never pays for a v1 probe: the group has already switched.
    expect(mintCalls.filter((call) => call.method === "getProgramAccounts")).toHaveLength(1)
    expect(seen.map(groupOf).indexOf("token-freeze")).toBeGreaterThan(seen.map(groupOf).lastIndexOf("token-mint"))

    const last = samples[samples.length - 1]
    expect(last?.total).toBe(19)
    expect(last?.settled).toBe(19)
    expect(last?.skipped).toBe(0)
    expect(last?.completed).toBe(last?.settled)
    expect(samples.some((sample) => sample.total === 18)).toBe(true)
    expect(samples.some((sample) => sample.total === 19)).toBe(true)
  })

  test("a shape that is still paging at the page ceiling stops the group as not checked", async () => {
    const mint = Keypair.generate().publicKey.toBase58()
    const clock = createFakeClock()
    const maxPages = 2
    const { rpc, seen } = fakeRpc((call) => {
      if (groupOf(call) !== "token-mint") return []
      if (call.method === "getProgramAccounts") return rpcError(-32600, HELIUS_PAGINATION_REFUSAL)
      const n = call.paginationKey === undefined ? 1 : Number(call.paginationKey) + 1
      return { pubkeys: n === 1 ? [mint] : [], paginationKey: String(n) }
    })
    const result = await readSignerRoles(rpc, [KEY.toBase58()], { ...clock, inFlight: 1, maxPages })
    expect(MAX_V2_PAGES).toBe(10)
    expect(result.checked).not.toContain("token-mint")
    expect(result.notChecked).toEqual([{ group: "token-mint", reason: "more than 2 pages (getProgramAccountsV2)" }])
    expect(result.found).toEqual([{ address: KEY.toBase58(), role: "mint", program: "token", target: mint }])
    const v2 = seen.filter((call) => call.method === "getProgramAccountsV2" && groupOf(call) === "token-mint")
    expect(v2).toHaveLength(maxPages)
    expect(v2.map((call) => call.paginationKey)).toEqual([undefined, "1"])
    expect(result.requests).toBe(1 + maxPages + 8)
    expect(result.planned).toBe(9 + (maxPages - 1))
  })

  test("an endpoint that offers neither V1 nor V2 leaves the group unchecked and keeps the -32600 reason", async () => {
    const clock = createFakeClock()
    const { rpc, seen } = fakeRpc((call) => {
      if (groupOf(call) !== "token-freeze") return []
      if (call.method === "getProgramAccounts") return rpcError(-32600, HELIUS_PAGINATION_REFUSAL)
      return rpcError(-32601, "Method not found")
    })
    const result = await readSignerRoles(rpc, addresses, { ...clock, inFlight: 1 })
    expect(result.checked).not.toContain("token-freeze")
    expect(result.checked).toContain("token-mint")
    expect(result.notChecked).toEqual([{ group: "token-freeze", reason: HELIUS_PAGINATION_REASON }])
    const freeze = seen.filter((call) => groupOf(call) === "token-freeze")
    expect(freeze.map((call) => call.method)).toEqual(["getProgramAccounts", "getProgramAccountsV2"])
    expect(result.planned).toBe(18)
    expect(result.requests).toBe(18)
    expect(sentenceForm(result)).toBe("U")
  })

  test("a V2 page that fails after page 1 leaves the group unchecked and keeps the page 1 finding", async () => {
    const mint = Keypair.generate().publicKey.toBase58()
    const clock = createFakeClock()
    const { rpc } = fakeRpc((call) => {
      if (groupOf(call) !== "token-mint") return []
      if (call.method === "getProgramAccounts") return rpcError(-32600, HELIUS_PAGINATION_REFUSAL)
      if (call.paginationKey === undefined) return { pubkeys: [mint], paginationKey: "cursor-2" }
      return jsonResponse(500, { error: "unavailable" })
    })
    const result = await readSignerRoles(rpc, [KEY.toBase58()], { ...clock, inFlight: 1 })
    expect(result.checked).not.toContain("token-mint")
    expect(result.notChecked).toEqual([{ group: "token-mint", reason: "HTTP 500" }])
    expect(result.found).toEqual([{ address: KEY.toBase58(), role: "mint", program: "token", target: mint }])
    expect(result.planned).toBe(10)
    expect(result.requests).toBe(11)
  })

  test("Token-2022 V2 pages keep dataSize 82 and the account-type byte at offset 165", async () => {
    const clock = createFakeClock()
    const { rpc, seen } = fakeRpc((call) => {
      if (groupOf(call) !== "token2022-mint") return []
      if (call.method === "getProgramAccounts") return rpcError(-32600, HELIUS_PAGINATION_REFUSAL)
      return { pubkeys: [], paginationKey: null }
    })
    const result = await readSignerRoles(rpc, [KEY.toBase58()], { ...clock, inFlight: 1 })
    expect(result.checked).toContain("token2022-mint")
    const pages = seen.filter((call) => call.method === "getProgramAccountsV2")
    expect(pages.some((call) => call.filters.some((filter) => "dataSize" in filter && filter.dataSize === 82))).toBe(
      true,
    )
    expect(
      pages.some((call) => call.filters.some((filter) => "memcmp" in filter && filter.memcmp.offset === 165)),
    ).toBe(true)
  })

  test("a -32600 outside the four token groups stops that group and does not call V2", async () => {
    const clock = createFakeClock()
    const { rpc, seen } = fakeRpc((call) =>
      groupOf(call) === "stake-staker" ? rpcError(-32600, HELIUS_PAGINATION_REFUSAL) : [],
    )
    const result = await readSignerRoles(rpc, [KEY.toBase58()], { ...clock, inFlight: 1 })
    expect(result.notChecked).toEqual([{ group: "stake-staker", reason: HELIUS_PAGINATION_REASON }])
    expect(seen.some((call) => call.method === "getProgramAccountsV2")).toBe(false)
    expect(seen.filter((call) => groupOf(call) === "stake-staker")).toHaveLength(1)
  })
})

// ── The words ───────────────────────────────────────────────────────────────────────────────

const allRead = (found: SignerRolesResult["found"] = []): SignerRolesResult => ({
  checked: [...ROLE_GROUP_IDS],
  notChecked: [],
  found,
  requests: 18,
  planned: 18,
  rateLimited: 0,
  elapsedMs: 4000,
})

describe("the words (D7, D8)", () => {
  const mint = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"
  const stake = "3Xk9stakeAccount1111111111111111111111Qm2p"
  const a = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
  const b = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
  const publicEndpoint: SignerRolesResult = {
    checked: ["program-upgrade", "stake-staker", "stake-withdrawer"],
    notChecked: [
      { group: "token-mint", reason: "RPC error -32602 INVALID_PARAMS" },
      { group: "token-freeze", reason: "RPC error -32602 INVALID_PARAMS" },
      { group: "token2022-mint", reason: "HTTP 403" },
      { group: "token2022-freeze", reason: "HTTP 403" },
    ],
    found: [],
    requests: 438,
    planned: 1314,
    rateLimited: 0,
    elapsedMs: 544_000,
  }

  test("the §4.1 footer lines for the public endpoint, and for a provider that serves every group with one finding", () => {
    expect(authoritiesCountLine(146, publicEndpoint)).toBe(
      "Authorities: none found; 4 of 7 groups were not read (see below).",
    )
    expect(readSummaryLine("rpc.host", publicEndpoint)).toBe(
      "Authorities read over rpc.host: program upgrade, stake staker, stake withdrawer. Not read: token mint, token freeze (RPC error -32602 INVALID_PARAMS), Token-2022 mint, Token-2022 freeze (HTTP 403). Not checked: multisig membership, Token-2022 extension authorities, metadata update authority.",
    )
    const one = allRead([{ address: a, role: "mint", program: "token", target: mint }])
    expect(authoritiesCountLine(2, one)).toBe(
      "Authorities: 1 of 2 keys holds one (1 finding, in the authority column).",
    )
    expect(readSummaryLine("rpc.host", one)).toBe(
      "Authorities read over rpc.host: token mint, token freeze, Token-2022 mint, Token-2022 freeze, program upgrade, stake staker, stake withdrawer. Not checked: multisig membership, Token-2022 extension authorities, metadata update authority.",
    )
    expect(authoritiesCountLine(146, allRead())).toBe("Authorities: none of the 146 keys holds one.")
    expect(authorityCell(a, one)).toBe(`mint authority of ${mint}`)
    expect(authorityCell(b, one)).toBe("none")
    expect(authorityCell(b, publicEndpoint)).toBe("?")
  })

  test("T12c at the word level: two findings on one key count as one key, and the withdrawer text is the spec's", () => {
    const two = allRead([
      { address: a, role: "mint", program: "token", target: mint },
      { address: a, role: "withdrawer", program: "stake", target: stake },
    ])
    expect(keysWithFindings(two)).toBe(1)
    expect(authoritiesCountLine(2, two)).toBe(
      "Authorities: 1 of 2 keys holds one (2 findings, in the authority column).",
    )
    expect(authorityCell(a, two)).toBe(`mint authority of ${mint}; withdrawer authority of ${stake}`)
    expect(findingLine(two.found[1] as (typeof two.found)[number])).toBe(`withdrawer authority of ${stake} (Stake)`)
    expect(authoritiesBlock("rpc.host", two)).toBe(
      [
        "Authorities (read over rpc.host):",
        `  mint authority of ${mint} (Token)`,
        `  withdrawer authority of ${stake} (Stake)`,
        `  ${NOT_CHECKED_LINE}`,
      ].join("\n"),
    )
  })

  test("the §4.2 block with one finding and two refused groups, and the all-clear block", () => {
    const partial: SignerRolesResult = {
      ...allRead([{ address: a, role: "mint", program: "token", target: mint }]),
      checked: ROLE_GROUP_IDS.filter((id) => !id.startsWith("token2022")),
      notChecked: [
        { group: "token2022-mint", reason: "HTTP 403" },
        { group: "token2022-freeze", reason: "HTTP 403" },
      ],
    }
    expect(authoritiesBlock("rpc.host", partial)).toBe(
      [
        "Authorities (read over rpc.host):",
        `  mint authority of ${mint} (Token)`,
        "  Token-2022 mint, Token-2022 freeze: not read (RPC getProgramAccounts failed: HTTP 403)",
        `  ${NOT_CHECKED_LINE}`,
      ].join("\n"),
    )
    expect(authoritiesBlock("rpc.host", allRead())).toBe(
      [
        "Authorities (read over rpc.host):",
        "  none: not a token mint, freeze, program upgrade or stake authority",
        `  ${NOT_CHECKED_LINE}`,
      ].join("\n"),
    )
  })

  test("the opening, progress and ✓ lines", () => {
    expect(checkOpeningLine(146, "rpc.host")).toBe(
      "Checking token mint, freeze, program upgrade and stake authorities for 146 addresses: 1,314 requests over rpc.host.",
    )
    expect(checkOpeningLine(1, "rpc.host")).toBe(
      "Checking token mint, freeze, program upgrade and stake authorities for 1 address: 9 requests over rpc.host.",
    )
    expect(
      progressLine({ completed: 412, settled: 412, skipped: 0, total: 1314, refusedGroups: 2, elapsedMs: 21_000 }),
    ).toBe("Checking authorities: 412 of 1,314 requests, 2 groups refused, 21 s elapsed, about 46 s left")
    // The same 412, once 404 of them are skips: the rate is the 8 calls that finished, and the
    // 902 still to run are not divided by the skipped ones. The old formula said about 46 s.
    expect(
      progressLine({ completed: 412, settled: 8, skipped: 404, total: 1314, refusedGroups: 4, elapsedMs: 21_000 }),
    ).toBe("Checking authorities: 412 of 1,314 requests, 4 groups refused, 21 s elapsed, about 2368 s left")
    // Blank estimate in the first 5 s, and no refused clause when nothing was refused.
    expect(progressLine({ completed: 3, settled: 3, skipped: 0, total: 18, refusedGroups: 0, elapsedMs: 900 })).toBe(
      "Checking authorities: 3 of 18 requests, 0 s elapsed",
    )
    expect(checkDoneLine(146, publicEndpoint)).toBe(
      "✓ authorities read for 146 addresses (438 requests, 3 of 7 groups read, 4 refused) in 9m 04s",
    )
    expect(checkDoneLine(2, allRead())).toBe(
      "✓ authorities read for 2 addresses (18 requests, 7 of 7 groups read) in 4s",
    )
    expect(checkDoneLine(1, { ...allRead(), requests: 9, elapsedMs: 3000 })).toBe(
      "✓ authorities read for 1 address (9 requests, 7 of 7 groups read) in 3s",
    )
    expect(formatDuration(544_000)).toBe("9m 04s")
    expect(formatDuration(59_400)).toBe("59s")
  })
})
