/**
 * BE-296 (spec `2026-09-23-cli-vault-promote-confirm-design.md`, D6, D7, D8): the signer-role
 * read that `vault promote --in-place` and `vault promote-batch` make for every acting key, on
 * every run, behind no flag.
 *
 * Seven role groups, nine `getProgramAccounts` per key, each answerable authoritatively by the
 * operator's own RPC with fixed-offset `memcmp` filters: token mint and freeze authority under
 * both token programs, program upgrade authority, and stake staker and withdrawer authority.
 * Helius refuses the four token groups on plain `getProgramAccounts` (`-32600`); those groups
 * then finish on `getProgramAccountsV2`, one page per settled call.
 * Nothing else is read, and what is not read is named on screen every time (multisig membership
 * above all). A found role WARNS and never refuses: AD-8's "never refuses on the basis of one"
 * stands, and the operator is still the only party who knows whether a key's role matters.
 *
 * Three things live here and nowhere else:
 *
 * - The filter builders, one per group, so the byte layouts have one home and a unit test each
 *   (T9). The COption tag is part of the token and loader `memcmp` bytes, so an unset authority
 *   whose bytes happen to match is never a hit.
 * - The scheduler, `readSignerRoles`: group-major order, up to 8 in flight, one in flight for
 *   the rest of the run after the first 429, per-group stop on the first failure, a 20 s timeout
 *   per request, the ProgramData-to-program resolve, and a progress callback. A token group that
 *   is refused with `-32600` is read again with `getProgramAccountsV2` and followed page by page,
 *   up to `MAX_V2_PAGES` per filter shape. Past that the group is not checked.
 *   The cap, the backoff, the page ceiling, the clock and the sleep are parameters so tests run
 *   it at 1 and 2 in flight with no timers.
 * - The words: the group names, the finding line, the "not checked" line, the footer lines and
 *   the `✓` line, so the two commands cannot drift from each other or from `--json`.
 *
 * "Could not read" is a normal outcome here and is never allowed to read as "found nothing".
 */
import { base64 } from "@scure/base"
import {
  decodePubkey,
  type ProgramAccountFilter,
  type SolanaRpc,
  SolanaRpcError,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../solana-lite"

export const BPF_UPGRADEABLE_LOADER_ID = "BPFLoaderUpgradeab1e11111111111111111111111"
export const STAKE_PROGRAM_ID = "Stake11111111111111111111111111111111111111"

/** The seven groups, in D6 order, which is also the order requests are issued in (group-major). */
export const ROLE_GROUP_IDS = [
  "token-mint",
  "token-freeze",
  "token2022-mint",
  "token2022-freeze",
  "program-upgrade",
  "stake-staker",
  "stake-withdrawer",
] as const
export type RoleGroupId = (typeof ROLE_GROUP_IDS)[number]

/**
 * SPL Token and Token-2022 are the programs Helius refuses to scan with plain
 * `getProgramAccounts` (measured 2026-09-23: `-32600`, "use getProgramAccountsV2"). Stake and
 * the loader answer v1, so they stay there.
 */
const PAGINATED_TOKEN_GROUPS: ReadonlySet<RoleGroupId> = new Set([
  "token-mint",
  "token-freeze",
  "token2022-mint",
  "token2022-freeze",
])

/** JSON-RPC Invalid Request. Helius uses this code for the unpaginated large-program refusal. */
const RPC_PAGINATION_REQUIRED = -32600
/**
 * Pages of one filter shape on `getProgramAccountsV2` before the group is not checked.
 * Helius can return a short page because `limit` counts accounts scanned, not matches, and
 * the only end signal is an empty page. Ten is headroom over the one page a key with no
 * matches should take, and it stops a filtered scan of the token program from running
 * without a bound. `maxPages` overrides it.
 */
export const MAX_V2_PAGES = 10

/** JSON-RPC Method not found: the endpoint does not offer `getProgramAccountsV2`. */
const RPC_METHOD_NOT_FOUND = -32601
export type Role = "mint" | "freeze" | "upgrade" | "staker" | "withdrawer"
export type RoleProgram = "token" | "token-2022" | "bpf-upgradeable-loader" | "stake"

export interface RoleGroup {
  id: RoleGroupId
  role: Role
  program: RoleProgram
  programId: string
  /** How the group is named on screen: `token mint`, `Token-2022 freeze`, `stake withdrawer`. */
  label: string
  /** The request shapes for one key: one filter list per `getProgramAccounts` call. */
  shapes: (key: Uint8Array) => ProgramAccountFilter[][]
}

/** Requests per key across the seven groups: 1 + 1 + 2 + 2 + 1 + 1 + 1. */
export const REQUESTS_PER_KEY = 9

const b64 = (bytes: Uint8Array): string => base64.encode(bytes)
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
const COPTION_SOME_U32 = new Uint8Array([1, 0, 0, 0])
const COPTION_SOME_U8 = new Uint8Array([1])
const LOADER_PROGRAM_DATA_TAG = new Uint8Array([3, 0, 0, 0])
const LOADER_PROGRAM_TAG = new Uint8Array([2, 0, 0, 0])
const TOKEN_2022_MINT_ACCOUNT_TYPE = new Uint8Array([1])
const memcmp = (offset: number, bytes: Uint8Array): ProgramAccountFilter => ({
  memcmp: { offset, bytes: b64(bytes), encoding: "base64" },
})

// ── The filter builders (D6) ────────────────────────────────────────────────────────────────

/** SPL Token mint: 82 bytes; `mint_authority` is a COption<Pubkey> at offset 0. */
export function tokenMintFilters(key: Uint8Array): ProgramAccountFilter[] {
  return [{ dataSize: 82 }, memcmp(0, concat(COPTION_SOME_U32, key))]
}
/** SPL Token mint: `freeze_authority` is a COption<Pubkey> at offset 46. */
export function tokenFreezeFilters(key: Uint8Array): ProgramAccountFilter[] {
  return [{ dataSize: 82 }, memcmp(46, concat(COPTION_SOME_U32, key))]
}
/**
 * Token-2022 mint, two shapes: (a) the 82-byte mint with no extensions, exactly the SPL shape;
 * (b) a mint with extensions, longer than 82 bytes and identified by its account-type byte at
 * offset 165 (`1` = mint). A filter on offset 0 alone would also scan token accounts.
 */
export function token2022MintFilters(key: Uint8Array): ProgramAccountFilter[][] {
  const authority = memcmp(0, concat(COPTION_SOME_U32, key))
  return [
    [{ dataSize: 82 }, authority],
    [memcmp(165, TOKEN_2022_MINT_ACCOUNT_TYPE), authority],
  ]
}
export function token2022FreezeFilters(key: Uint8Array): ProgramAccountFilter[][] {
  const authority = memcmp(46, concat(COPTION_SOME_U32, key))
  return [
    [{ dataSize: 82 }, authority],
    [memcmp(165, TOKEN_2022_MINT_ACCOUNT_TYPE), authority],
  ]
}
/** ProgramData (`UpgradeableLoaderState` tag 3): slot at 4, `upgrade_authority_address` COption at 12. */
export function programUpgradeFilters(key: Uint8Array): ProgramAccountFilter[] {
  return [memcmp(0, LOADER_PROGRAM_DATA_TAG), memcmp(12, concat(COPTION_SOME_U8, key))]
}
/** The Program account (tag 2) whose `programdata_address` at offset 4 is this ProgramData account. */
export function programIdFilters(programData: Uint8Array): ProgramAccountFilter[] {
  return [memcmp(0, LOADER_PROGRAM_TAG), memcmp(4, programData)]
}
/**
 * A stake account is a fixed 200 bytes (`StakeStateV2`). `Initialized` and `Stake` both begin
 * with the 4-byte enum tag, then `Meta`: `rent_exempt_reserve` at 4, `authorized.staker` at 12,
 * `authorized.withdrawer` at 44. No tag filter: an `Uninitialized` account is all zeros and a
 * `RewardsPool` carries no `Meta`, so neither can match a real key at those offsets.
 */
export function stakeStakerFilters(key: Uint8Array): ProgramAccountFilter[] {
  return [{ dataSize: 200 }, memcmp(12, key)]
}
export function stakeWithdrawerFilters(key: Uint8Array): ProgramAccountFilter[] {
  return [{ dataSize: 200 }, memcmp(44, key)]
}

export const ROLE_GROUPS: readonly RoleGroup[] = [
  {
    id: "token-mint",
    role: "mint",
    program: "token",
    programId: TOKEN_PROGRAM_ID,
    label: "token mint",
    shapes: (key) => [tokenMintFilters(key)],
  },
  {
    id: "token-freeze",
    role: "freeze",
    program: "token",
    programId: TOKEN_PROGRAM_ID,
    label: "token freeze",
    shapes: (key) => [tokenFreezeFilters(key)],
  },
  {
    id: "token2022-mint",
    role: "mint",
    program: "token-2022",
    programId: TOKEN_2022_PROGRAM_ID,
    label: "Token-2022 mint",
    shapes: token2022MintFilters,
  },
  {
    id: "token2022-freeze",
    role: "freeze",
    program: "token-2022",
    programId: TOKEN_2022_PROGRAM_ID,
    label: "Token-2022 freeze",
    shapes: token2022FreezeFilters,
  },
  {
    id: "program-upgrade",
    role: "upgrade",
    program: "bpf-upgradeable-loader",
    programId: BPF_UPGRADEABLE_LOADER_ID,
    label: "program upgrade",
    shapes: (key) => [programUpgradeFilters(key)],
  },
  {
    id: "stake-staker",
    role: "staker",
    program: "stake",
    programId: STAKE_PROGRAM_ID,
    label: "stake staker",
    shapes: (key) => [stakeStakerFilters(key)],
  },
  {
    id: "stake-withdrawer",
    role: "withdrawer",
    program: "stake",
    programId: STAKE_PROGRAM_ID,
    label: "stake withdrawer",
    shapes: (key) => [stakeWithdrawerFilters(key)],
  },
]

/** How a program is named after a finding in single promote: `(Token)`, `(Stake)`. */
export const PROGRAM_LABELS: Record<RoleProgram, string> = {
  token: "Token",
  "token-2022": "Token-2022",
  "bpf-upgradeable-loader": "BPF Upgradeable Loader",
  stake: "Stake",
}

/** D8: printed every time, in both commands, whatever was read. */
export const NOT_CHECKED_LINE =
  "Not checked: multisig membership, Token-2022 extension authorities, metadata update authority."

// ── The scheduler (D7) ──────────────────────────────────────────────────────────────────────

export interface RoleFinding {
  /** The acting key that holds the role. */
  address: string
  role: Role
  program: RoleProgram
  /** The mint, the program id (or the ProgramData address when it could not be resolved), or the stake account. */
  target: string
  /** True when `target` is a ProgramData address because the program id could not be resolved. */
  unresolvedProgram?: boolean
}

export interface RoleProgress {
  /**
   * Settled plus skipped: the `N of M` on the line. A skip was never issued, because its group
   * had already stopped, so it is not part of the rate.
   */
  completed: number
  /**
   * Pages that finished (answered or failed for good). `left` divides by this, not by
   * `completed`. A 429 retry and a v1 `-32600` probe that falls back to V2 are not pages.
   */
  settled: number
  /** Not issued, because the group had already stopped. */
  skipped: number
  /**
   * Same figure as `planned`: one per filter shape, plus one per V2 page after the first.
   * The extra page is added when the previous page returns a `paginationKey`, before that
   * page is issued. The opening line's `{9n}` is this number before any cursor is known.
   */
  total: number
  /** Groups that have stopped (refused, errored or timed out) so far. */
  refusedGroups: number
  elapsedMs: number
}

export interface SignerRolesResult {
  /** Every group, in exactly one of these two. */
  checked: RoleGroupId[]
  notChecked: Array<{ group: RoleGroupId; reason: string }>
  found: RoleFinding[]
  /**
   * HTTP calls actually issued: 429 retries, the v1 `-32600` probe, further V2 pages and
   * program-id resolves. What the operator paid for.
   */
  requests: number
  /**
   * Pages, not HTTP calls. Starts at one page per filter shape (`9 × addresses`). Each
   * `getProgramAccountsV2` page after the first adds one when the previous page returns a
   * `paginationKey`, before that page is issued. A v1 probe and a 429 retry do not add one.
   */
  planned: number
  /** HTTP 429 answers seen. Once one is seen the run stays at one in flight. */
  rateLimited: number
  elapsedMs: number
}

export interface SignerRolesOptions {
  /** Requests in flight at most, before the first 429 (D7: 8). */
  inFlight?: number
  /** The wait after a 429 without `Retry-After` (D7: 2 s). */
  backoffMs?: number
  /** How many times one request is retried after 429s before its group fails (D7: 5). */
  maxRetries?: number
  /** Per-request timeout (D7: 20 s). `0` disables it, for tests that abort by hand. */
  timeoutMs?: number
  /**
   * `getProgramAccountsV2` pages of one filter shape (default `MAX_V2_PAGES`). The next page
   * after this many stops the group as not checked.
   */
  maxPages?: number
  now: () => number
  sleep: (ms: number) => Promise<void>
  onProgress?: (progress: RoleProgress) => void
}

interface Task {
  group: RoleGroup
  address: string
  filters: ProgramAccountFilter[]
  /** `v2` once this group has been refused with `-32600`, or for a page after the first. */
  via: "v1" | "v2"
  paginationKey?: string
}

/** Why a request failed, as one clause for the footer: `HTTP 403`, `RPC error -32602 INVALID_PARAMS`, `timed out after 20 s`. */
function failureReason(error: unknown, timeoutMs: number): string {
  if (error instanceof SolanaRpcError) {
    if (error.status !== undefined) return `HTTP ${error.status}`
    if (error.rpcCode !== undefined) {
      const text = error.message.replace(/^RPC getProgramAccounts(?:V2)? failed: /, "").replace(/^-?\d+\s*/, "")
      return `RPC error ${error.rpcCode}${text ? ` ${text}` : ""}`
    }
    return error.message.replace(/^RPC getProgramAccounts(?:V2)? failed: /, "")
  }
  if (error instanceof Error && error.name === "AbortError") return `timed out after ${Math.round(timeoutMs / 1000)} s`
  if (error instanceof Error && error.name === "TimeoutError")
    return `timed out after ${Math.round(timeoutMs / 1000)} s`
  return error instanceof Error ? error.message : String(error)
}

/** JSON-RPC `-32601`, or a second `-32600` from V2: this endpoint does not offer a usable page. */
function v2NotOffered(error: unknown): boolean {
  return (
    error instanceof SolanaRpcError &&
    error.status === undefined &&
    (error.rpcCode === RPC_METHOD_NOT_FOUND || error.rpcCode === RPC_PAGINATION_REQUIRED)
  )
}

/**
 * Reads every group for every address. Never throws for an RPC reason: a failed request stops
 * its group, is recorded with its first error, and the run continues with the other groups.
 * Hits a group returned before it stopped are kept, because they are true. A group is checked
 * only when every one of its pages finished.
 *
 * Token groups try `getProgramAccounts` first. Helius answers those four with `-32600` and
 * names `getProgramAccountsV2`; that one refusal switches the group, and the refused call is
 * retried as page 1. Later calls in the group skip v1. Pages stay on the same in-flight slot,
 * so a cursor cannot jump the group-major queue. A shape that is still paging after
 * `maxPages` stops the group as not checked (`more than N pages (getProgramAccountsV2)`).
 * An endpoint that offers neither (V2 answers `-32601`, or `-32600` again) keeps the v1
 * reason and the group stays not checked.
 */
export async function readSignerRoles(
  rpc: Pick<SolanaRpc, "getProgramAccounts"> & Partial<Pick<SolanaRpc, "getProgramAccountsV2">>,
  addresses: string[],
  opts: SignerRolesOptions,
): Promise<SignerRolesResult> {
  const startedAt = opts.now()
  let cap = Math.max(1, opts.inFlight ?? 8)
  const backoffMs = opts.backoffMs ?? 2000
  const maxRetries = opts.maxRetries ?? 5
  const timeoutMs = opts.timeoutMs ?? 20_000
  const maxPages = Math.max(1, opts.maxPages ?? MAX_V2_PAGES)

  // Group-major: every key for group 1, then every key for group 2, and so on, so a group an
  // endpoint refuses costs at most the requests already in flight before it stops.
  const tasks: Task[] = []
  const keys = addresses.map((address) => ({ address, bytes: decodePubkey(address) }))
  for (const group of ROLE_GROUPS) {
    for (const key of keys) {
      for (const filters of group.shapes(key.bytes)) tasks.push({ group, address: key.address, filters, via: "v1" })
    }
  }
  let planned = tasks.length

  const failed = new Map<RoleGroupId, string>()
  /** The v1 `-32600` text, kept when V2 is not offered. */
  const v1Refusal = new Map<RoleGroupId, string>()
  /** Token groups whose next call goes straight to V2. */
  const v2Groups = new Set<RoleGroupId>()
  const controllers = new Map<RoleGroupId, Set<AbortController>>()
  const found: RoleFinding[] = []
  const seen = new Set<string>()
  let requests = 0
  let rateLimited = 0
  let settled = 0
  let skipped = 0
  let next = 0
  let active = 0

  const progress = () => {
    opts.onProgress?.({
      completed: settled + skipped,
      settled,
      skipped,
      total: planned,
      refusedGroups: failed.size,
      elapsedMs: opts.now() - startedAt,
    })
  }

  const record = (finding: RoleFinding) => {
    const key = `${finding.address} ${finding.role} ${finding.program} ${finding.target}`
    if (seen.has(key)) return
    seen.add(key)
    found.push(finding)
  }

  const stopGroup = (group: RoleGroup, reason: string) => {
    if (failed.has(group.id)) return
    failed.set(group.id, reason)
    for (const controller of controllers.get(group.id) ?? []) controller.abort()
  }

  /** One request with the per-request timeout and the group's cancel handle. Pages of one query share the slot. */
  const request = async (
    task: Task,
    filters: ProgramAccountFilter[],
  ): Promise<{ pubkeys: string[]; paginationKey: string | null }> => {
    const controller = new AbortController()
    let set = controllers.get(task.group.id)
    if (set === undefined) {
      set = new Set()
      controllers.set(task.group.id, set)
    }
    set.add(controller)
    const timer =
      timeoutMs > 0
        ? setTimeout(() => controller.abort(Object.assign(new Error("timed out"), { name: "TimeoutError" })), timeoutMs)
        : undefined
    try {
      requests += 1
      if (task.via === "v2") {
        if (rpc.getProgramAccountsV2 === undefined) {
          throw new SolanaRpcError("RPC getProgramAccountsV2 failed: -32601 Method not found", {
            rpcCode: RPC_METHOD_NOT_FOUND,
          })
        }
        return await rpc.getProgramAccountsV2(task.group.programId, filters, {
          signal: controller.signal,
          ...(task.paginationKey !== undefined ? { paginationKey: task.paginationKey } : {}),
        })
      }
      const pubkeys = await rpc.getProgramAccounts(task.group.programId, filters, { signal: controller.signal })
      return { pubkeys, paginationKey: null }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      set.delete(controller)
    }
  }

  /**
   * One filter shape. 429s retry in place. A token-group `-32600` retries as V2 page 1, then
   * each further page is its own settled call and adds one to `planned`. `countPage` runs once
   * per finished page, not per probe or retry.
   */
  const run = async (task: Task, countPage: () => void): Promise<void> => {
    let current = task
    let attempt = 0
    const cursors = new Set<string>()
    for (;;) {
      if (failed.has(current.group.id)) return
      try {
        const page = await request(current, current.filters)
        for (const hit of page.pubkeys) {
          if (current.group.id === "program-upgrade") {
            record(await resolveProgram(current, hit))
          } else {
            record({ address: current.address, role: current.group.role, program: current.group.program, target: hit })
          }
        }
        countPage()
        if (failed.has(current.group.id)) return
        const cursor = current.via === "v2" ? page.paginationKey : null
        if (cursor === null) return
        if (cursors.has(cursor)) {
          stopGroup(current.group, "paginationKey did not advance")
          return
        }
        // `cursors` holds the pages already finished that asked for another. This page is one more.
        if (cursors.size + 1 >= maxPages) {
          stopGroup(current.group, `more than ${maxPages} pages (getProgramAccountsV2)`)
          return
        }
        cursors.add(cursor)
        planned += 1
        progress()
        current = { ...current, paginationKey: cursor }
        attempt = 0
      } catch (error) {
        if (failed.has(current.group.id)) {
          countPage()
          return
        }
        if (error instanceof SolanaRpcError && error.status === 429) {
          rateLimited += 1
          cap = 1
          if (attempt < maxRetries) {
            attempt += 1
            await opts.sleep(error.retryAfterMs ?? backoffMs)
            continue
          }
          countPage()
          stopGroup(current.group, `HTTP 429 after ${maxRetries} retries`)
          return
        }
        if (
          current.via === "v1" &&
          PAGINATED_TOKEN_GROUPS.has(current.group.id) &&
          error instanceof SolanaRpcError &&
          error.status === undefined &&
          error.rpcCode === RPC_PAGINATION_REQUIRED
        ) {
          v2Groups.add(current.group.id)
          if (!v1Refusal.has(current.group.id)) v1Refusal.set(current.group.id, failureReason(error, timeoutMs))
          current = { ...current, via: "v2", paginationKey: undefined }
          attempt = 0
          continue
        }
        countPage()
        const reason =
          current.via === "v2" && v2NotOffered(error)
            ? (v1Refusal.get(current.group.id) ?? failureReason(error, timeoutMs))
            : failureReason(error, timeoutMs)
        stopGroup(current.group, reason)
        return
      }
    }
  }

  /** One more loader request per ProgramData hit, so the finding names the program, not its data account. */
  const resolveProgram = async (task: Task, programData: string): Promise<RoleFinding> => {
    const base = { address: task.address, role: task.group.role, program: task.group.program }
    try {
      const page = await request(
        { ...task, via: "v1", paginationKey: undefined },
        programIdFilters(decodePubkey(programData)),
      )
      const program = page.pubkeys[0]
      if (program !== undefined) return { ...base, target: program }
    } catch {
      // A resolve that fails is not a group failure: the role was found, and the ProgramData
      // address is printed with a note instead.
    }
    return { ...base, target: programData, unresolvedProgram: true }
  }

  await new Promise<void>((resolve) => {
    const pump = () => {
      // Skips are counted apart from settled calls, and the line is redrawn once per burst,
      // before the next call is issued. Counting them as settled made `left` collapse as soon
      // as a group stopped (D7: the operator aborts from that estimate).
      let skippedAny = false
      while (active < cap && next < tasks.length) {
        const task = tasks[next++] as Task
        if (failed.has(task.group.id)) {
          skipped += 1
          skippedAny = true
          continue
        }
        if (v2Groups.has(task.group.id)) task.via = "v2"
        if (skippedAny) {
          progress()
          skippedAny = false
        }
        const counted = { n: 0 }
        const countPage = () => {
          counted.n += 1
          settled += 1
          progress()
        }
        active += 1
        void run(task, countPage).finally(() => {
          active -= 1
          // A slot that ended before any page finished (the group stopped first) still settled.
          if (counted.n === 0) {
            settled += 1
            progress()
          }
          pump()
        })
      }
      if (skippedAny) progress()
      if (active === 0 && next >= tasks.length) resolve()
    }
    pump()
  })

  const checked = ROLE_GROUPS.filter((group) => !failed.has(group.id)).map((group) => group.id)
  const notChecked = ROLE_GROUPS.filter((group) => failed.has(group.id)).map((group) => ({
    group: group.id,
    reason: failed.get(group.id) as string,
  }))
  return { checked, notChecked, found, requests, planned, rateLimited, elapsedMs: opts.now() - startedAt }
}

// ── The words (D1, D8) ──────────────────────────────────────────────────────────────────────

export type SentenceForm = "U" | "N" | "F"

/** Form F when anything was found, N only when every group was read, else U (D1). */
export function sentenceForm(result: Pick<SignerRolesResult, "found" | "notChecked">): SentenceForm {
  if (result.found.length > 0) return "F"
  return result.notChecked.length === 0 ? "N" : "U"
}

/** `k`: the number of distinct acting keys with at least one finding, not the number of findings. */
export function keysWithFindings(result: Pick<SignerRolesResult, "found">): number {
  return new Set(result.found.map((finding) => finding.address)).size
}

export function groupLabel(id: RoleGroupId): string {
  return (ROLE_GROUPS.find((group) => group.id === id) as RoleGroup).label
}

/** `mint authority of <mint>`; an unresolved upgrade hit names the ProgramData account and says so. */
export function findingText(finding: RoleFinding): string {
  const text = `${finding.role} authority of ${finding.target}`
  return finding.unresolvedProgram ? `${text} (ProgramData account; the program id could not be resolved)` : text
}

/** The finding line in single promote: the text, then the program in parentheses. */
export function findingLine(finding: RoleFinding): string {
  return `${findingText(finding)} (${PROGRAM_LABELS[finding.program]})`
}

/** The batch row's `authority` cell for one acting key (D8). */
export function authorityCell(address: string, result: Pick<SignerRolesResult, "found" | "notChecked">): string {
  const own = result.found.filter((finding) => finding.address === address)
  if (own.length > 0) return own.map(findingText).join("; ")
  return result.notChecked.length === 0 ? "none" : "?"
}

/** Groups that were not read, in D6 order, adjacent groups with the same reason together. */
function notReadRuns(notChecked: SignerRolesResult["notChecked"]): Array<{ reason: string; groups: string[] }> {
  const runs: Array<{ reason: string; groups: string[] }> = []
  for (const entry of notChecked) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.reason === entry.reason) last.groups.push(groupLabel(entry.group))
    else runs.push({ reason: entry.reason, groups: [groupLabel(entry.group)] })
  }
  return runs
}

/** `token mint, token freeze (HTTP 403), Token-2022 mint, Token-2022 freeze (RPC error -32602 ...)`. */
function notReadClause(notChecked: SignerRolesResult["notChecked"]): string {
  return notReadRuns(notChecked)
    .map((run) => `${run.groups.join(", ")} (${run.reason})`)
    .join(", ")
}

/** The footer's "what was and was not read" line (D8), and the single command's `not read` lines. */
export function readSummaryLine(host: string, result: SignerRolesResult): string {
  const read = result.checked.length === 0 ? "none" : result.checked.map(groupLabel).join(", ")
  const notRead = result.notChecked.length === 0 ? "" : ` Not read: ${notReadClause(result.notChecked)}.`
  return `Authorities read over ${host}: ${read}.${notRead} ${NOT_CHECKED_LINE}`
}

/** The footer's count line (D8): keys, not findings. */
export function authoritiesCountLine(keys: number, result: SignerRolesResult): string {
  const k = keysWithFindings(result)
  if (k > 0) {
    const findings = result.found.length
    return `Authorities: ${k} of ${keys} keys ${k === 1 ? "holds" : "hold"} one (${findings} finding${findings === 1 ? "" : "s"}, in the authority column).`
  }
  if (result.notChecked.length === 0) return `Authorities: none of the ${keys} keys holds one.`
  return `Authorities: none found; ${result.notChecked.length} of ${ROLE_GROUPS.length} groups were not read (see below).`
}

/** Single promote's block under the holdings (D8). */
export function authoritiesBlock(host: string, result: SignerRolesResult): string {
  const lines = [`Authorities (read over ${host}):`]
  if (result.found.length > 0) {
    for (const finding of result.found) lines.push(`  ${findingLine(finding)}`)
  } else if (result.notChecked.length === 0) {
    lines.push("  none: not a token mint, freeze, program upgrade or stake authority")
  }
  for (const run of notReadRuns(result.notChecked)) {
    lines.push(`  ${run.groups.join(", ")}: not read (RPC getProgramAccounts failed: ${run.reason})`)
  }
  lines.push(`  ${NOT_CHECKED_LINE}`)
  return lines.join("\n")
}

/** `4s`, `9m 04s`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
}

const thousands = (n: number): string => n.toLocaleString("en-US")

/**
 * The batch's opening line, printed before the first request (D7). The count is one page per
 * filter shape. Further V2 pages are not known yet; `planned` and the progress `total` grow
 * by one each time a page returns a cursor.
 */
export function checkOpeningLine(keys: number, host: string): string {
  return `Checking token mint, freeze, program upgrade and stake authorities for ${keys} address${keys === 1 ? "" : "es"}: ${thousands(keys * REQUESTS_PER_KEY)} requests over ${host}.`
}

/**
 * The in-place progress line (D7). `left` is blank for the first 5 s. It is the requests still
 * to run — not settled and not skipped — divided by the rate of calls that actually finished.
 */
export function progressLine(progress: RoleProgress): string {
  const parts = [`Checking authorities: ${thousands(progress.completed)} of ${thousands(progress.total)} requests`]
  if (progress.refusedGroups > 0) {
    parts.push(`${progress.refusedGroups} group${progress.refusedGroups === 1 ? "" : "s"} refused`)
  }
  const elapsedS = Math.floor(progress.elapsedMs / 1000)
  parts.push(`${elapsedS} s elapsed`)
  const remaining = progress.total - progress.settled - progress.skipped
  if (progress.elapsedMs >= 5000 && progress.settled > 0 && remaining > 0) {
    const leftS = Math.ceil((remaining * progress.elapsedMs) / progress.settled / 1000)
    parts.push(`about ${leftS} s left`)
  }
  return parts.join(", ")
}

/** The permanent line that replaces the progress line (D7), in the style of the SOL read's. */
export function checkDoneLine(keys: number, result: SignerRolesResult): string {
  const refused = result.notChecked.length
  return `✓ authorities read for ${keys} address${keys === 1 ? "" : "es"} (${thousands(result.requests)} requests, ${result.checked.length} of ${ROLE_GROUPS.length} groups read${refused > 0 ? `, ${refused} refused` : ""}) in ${formatDuration(result.elapsedMs)}`
}

/** The `--json` `authorities` value (D9). */
export function authoritiesJson(result: SignerRolesResult): {
  checked: RoleGroupId[]
  notChecked: Array<{ group: RoleGroupId; reason: string }>
  found: Array<{ address: string; role: Role; target: string; program: RoleProgram }>
} {
  return {
    checked: result.checked,
    notChecked: result.notChecked,
    found: result.found.map(({ address, role, target, program }) => ({ address, role, target, program })),
  }
}
