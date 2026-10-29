/**
 * The local state of x402 plans on this machine (spec 5.3, 6.3 and 10.1; card C7), per profile,
 * beside the spend log: `<config dir>/spend/<profile>.plan.json`, mode 0600 in the 0700 `spend`
 * directory.
 *
 * - **Auto-renew** (6.3) is a local flag. x402 has no subscription and the server never pulls funds,
 *   so the CLI keeps the plan, its period end, the paying wallet and the most a renewal may cost
 *   without a person (`renewCeilingRaw`: what the last confirmed purchase paid), and asks for a
 *   renewal quote itself.
 * - **A payment in flight** (`pending`) is written before it is sent and cleared only once its
 *   outcome is final. While it is here no new plan payment starts: `plan buy` and `plan renew`
 *   resend the same signed payment instead, which the server answers from its payment row (3.5,
 *   5.3), so a crash, a 202 or a 503 resumes and never pays twice.
 * - **A signup's key signer** (`signupSigners`, 5.3 and 5.5): the public half of each `S`, whose
 *   private half sits in the secret store under `signupSignerRef`, written before the first quote.
 *   One per identity wallet, reused by every retry for that payer, because the quote is bound to it.
 *   It is copied to its key's slot (`key_signer_<prefix>_<spkiSha256>`) once the account and key
 *   exist, and only then removed from here: a slot that may own wallets is never dropped.
 *
 * Every read-check-write goes through `updatePlanState`, under one exclusive lock on the file, so
 * two CLI processes cannot both start a payment or both start an auto-renewal.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { withFileLock } from "../file-lock"
import type { SpendPaths } from "./spend-log"

export type PaidPlanName = "pro" | "max"

/** The plan route's request body (5.3): what the quote priced, resent unchanged on a retry. */
export interface PlanRequestBody {
  payer: string
  signerPublicKey?: string
  termsVersion: string
  autoRenew: boolean
}

export interface PendingPlanPayment {
  /** The spend log id of this payment. */
  id: string
  plan: PaidPlanName
  renew: boolean
  path: string
  body: PlanRequestBody
  /** The `PAYMENT-SIGNATURE` value sent: a transfer already signed, holding no key. */
  paymentHeader: string
  /** True when the request carried the profile's API key (5.1 rule 1). */
  keyed: boolean
  amountRaw: string
  /** The list price the person confirmed (6.1, A3): what auto-renew may pay unattended afterwards. */
  ceilingRaw?: string
  payer: string
  startedAt: string
  /** The `S` this payment's quote was bound to, when it was a signup. */
  signupSpkiSha256?: string
}

export interface SignupSigner {
  spkiSha256: string
  publicKeyDer: string
  fingerprint: string
  /** The identity wallet `K` the signup is for. A different payer gets a different `S`. */
  payer: string
  createdAt: string
}

export interface PlanState {
  autoRenew: boolean
  plan?: PaidPlanName
  payer?: string
  periodEnd?: string
  renewCeilingRaw?: string
  lastRenewAttemptAt?: string
  pending?: PendingPlanPayment
  signupSigners?: SignupSigner[]
}

/** The secret-store slot of a signup's `S` before its key exists. One per public key. */
export function signupSignerRef(spkiSha256: string): string {
  return `x402_signup_signer_${spkiSha256}`
}

export function planStatePath(paths: SpendPaths): string {
  return paths.log.replace(/\.jsonl$/, ".plan.json")
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const plan = (value: unknown): PaidPlanName | undefined => (value === "pro" || value === "max" ? value : undefined)

function parsePending(value: unknown): PendingPlanPayment | undefined {
  if (!isObject(value) || !isObject(value.body)) return undefined
  const p = plan(value.plan)
  const { id, path, paymentHeader, amountRaw, payer, startedAt } = value
  const body = value.body
  if (
    !p ||
    typeof id !== "string" ||
    typeof path !== "string" ||
    typeof paymentHeader !== "string" ||
    typeof amountRaw !== "string" ||
    !/^[0-9]{1,20}$/.test(amountRaw) ||
    typeof payer !== "string" ||
    typeof startedAt !== "string" ||
    typeof body.payer !== "string" ||
    typeof body.termsVersion !== "string"
  ) {
    return undefined
  }
  return {
    id,
    plan: p,
    renew: value.renew === true,
    path,
    body: {
      payer: body.payer,
      ...(typeof body.signerPublicKey === "string" ? { signerPublicKey: body.signerPublicKey } : {}),
      termsVersion: body.termsVersion,
      autoRenew: body.autoRenew === true,
    },
    paymentHeader,
    keyed: value.keyed === true,
    amountRaw,
    ...(typeof value.ceilingRaw === "string" && /^[0-9]{1,20}$/.test(value.ceilingRaw)
      ? { ceilingRaw: value.ceilingRaw }
      : {}),
    payer,
    startedAt,
    ...(typeof value.signupSpkiSha256 === "string" ? { signupSpkiSha256: value.signupSpkiSha256 } : {}),
  }
}

function parseSigner(value: unknown): SignupSigner | undefined {
  if (!isObject(value)) return undefined
  const { spkiSha256, publicKeyDer, fingerprint, payer, createdAt } = value
  if (
    typeof spkiSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(spkiSha256) ||
    typeof publicKeyDer !== "string" ||
    typeof fingerprint !== "string" ||
    typeof payer !== "string" ||
    typeof createdAt !== "string"
  ) {
    return undefined
  }
  return { spkiSha256, publicKeyDer, fingerprint, payer, createdAt }
}

/** The state as stored, or the empty state. An unreadable field is dropped, never guessed. */
export function parsePlanState(text: string | null): PlanState {
  if (text === null) return { autoRenew: false }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { autoRenew: false }
  }
  if (!isObject(raw)) return { autoRenew: false }
  const ceiling = str(raw.renewCeilingRaw)
  const pending = parsePending(raw.pending)
  const signers = Array.isArray(raw.signupSigners)
    ? raw.signupSigners.map(parseSigner).filter((s): s is SignupSigner => s !== undefined)
    : []
  const p = plan(raw.plan)
  return {
    autoRenew: raw.autoRenew === true,
    ...(p ? { plan: p } : {}),
    ...(str(raw.payer) ? { payer: str(raw.payer) } : {}),
    ...(str(raw.periodEnd) && Number.isFinite(Date.parse(str(raw.periodEnd) ?? ""))
      ? { periodEnd: str(raw.periodEnd) }
      : {}),
    ...(ceiling && /^[0-9]{1,20}$/.test(ceiling) ? { renewCeilingRaw: ceiling } : {}),
    ...(str(raw.lastRenewAttemptAt) ? { lastRenewAttemptAt: str(raw.lastRenewAttemptAt) } : {}),
    ...(pending ? { pending } : {}),
    ...(signers.length > 0 ? { signupSigners: signers } : {}),
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null
    throw error
  }
}

export async function readPlanState(paths: SpendPaths): Promise<PlanState> {
  return parsePlanState(await readText(planStatePath(paths)))
}

async function writePlanState(paths: SpendPaths, state: PlanState): Promise<void> {
  const path = planStatePath(paths)
  const temp = `${path}.tmp`
  await writeFile(temp, `${JSON.stringify({ v: 1, ...state })}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(temp, path)
  await chmod(path, 0o600).catch(() => {})
}

/**
 * Read, change and write the state under the file's lock. `change` returns the new state (or null
 * to write nothing) and a value for the caller; it must not do I/O of its own.
 */
export async function updatePlanState<T>(
  paths: SpendPaths,
  change: (state: PlanState) => { state: PlanState | null; result: T },
): Promise<T> {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 })
  await chmod(paths.dir, 0o700).catch(() => {})
  const path = planStatePath(paths)
  return withFileLock(path, async () => {
    const { state, result } = change(parsePlanState(await readText(path)))
    if (state !== null) await writePlanState(paths, state)
    return result
  })
}
