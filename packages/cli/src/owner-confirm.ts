/**
 * BE-2948 (spec 2026-11-09-owner-confirm-device-token-design.md, 7.1): what the CLI prints when a device-token
 * owner step needs the owner's browser approval. `apiRequest` (client.ts) runs the poll and the resend; this
 * file only decides how the challenge reaches the person at the terminal, and `run` (index.ts) installs it
 * for the whole command, so every call site that reaches a gated route gets the same flow.
 */
import { browserUrl, type OwnerConfirmChallenge, type OwnerConfirmHooks } from "./client"
import type { Deps } from "./deps"

/** `--no-wait`: the challenge was printed and nothing was polled. Listed in `help.ts`. */
export const EXIT_OWNER_CONFIRM_PENDING = 7

/** The commands that already own a `--no-wait` of their own; the global one is not taken from them. */
export const OWN_NO_WAIT_COMMANDS: ReadonlyArray<readonly string[]> = [["tee"], ["lab"], ["wallets", "authorize"]]

export interface OwnerConfirmRunState {
  /** A challenge was shown under `--no-wait`: the run exits {@link EXIT_OWNER_CONFIRM_PENDING}. */
  pendingWithoutWait: boolean
}

/** `4C…6jDX`-style: enough of a wallet to eyeball against the browser's account. */
export function shortWallet(wallet: string): string {
  return wallet.length >= 12 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : wallet
}

/** BE-3296: `Economic-Brown-Mollusk (3Cir…6jDX)`, or just the short wallet when there is no name. */
export function accountLabel(account: { wallet: string; displayName: string | null }): string {
  const short = shortWallet(account.wallet)
  return account.displayName ? `${account.displayName} (${short})` : short
}

/** The `--json` pending line (7.1 step 1): everything the person needs, never the `confirmId` secret. */
export function ownerConfirmPendingLine(challenge: OwnerConfirmChallenge): string {
  return JSON.stringify({
    ok: false,
    pending: true,
    code: "OWNER_CONFIRM_REQUIRED",
    ownerConfirm: {
      userCode: challenge.userCode,
      verificationUriComplete: challenge.verificationUriComplete,
      expiresIn: challenge.expiresIn,
      step: challenge.step,
      summary: challenge.summary,
      ...(challenge.account ? { account: challenge.account } : {}),
    },
  })
}

export function cliOwnerConfirmHooks(
  deps: Pick<Deps, "stderr" | "sleep" | "now" | "openBrowser">,
  opts: { json: boolean; wait: boolean; open: boolean },
  state: OwnerConfirmRunState,
): OwnerConfirmHooks {
  return {
    wait: opts.wait,
    sleep: (ms) => deps.sleep(ms),
    now: () => deps.now(),
    pending(challenge) {
      if (!opts.wait) state.pendingWithoutWait = true
      if (opts.json) {
        deps.stderr.write(`${ownerConfirmPendingLine(challenge)}\n`)
      } else {
        const minutes = Math.max(1, Math.round(challenge.expiresIn / 60))
        // BE-3296: name the account the request was made as, so a wrong-account browser is obvious
        // before it ever answers "Request not found". Absent on an older API: the old line stands.
        const as = challenge.account ? ` as ${accountLabel(challenge.account)}` : ""
        deps.stderr.write(
          [
            `This needs your approval in the browser${as}: ${challenge.summary}`,
            `Open ${challenge.verificationUriComplete}`,
            `Code: ${challenge.userCode}`,
            ...(challenge.account ? [`The browser must be signed in as ${accountLabel(challenge.account)}.`] : []),
            "Only approve if you just ran this command.",
            opts.wait ? `Waiting for approval (expires in ${minutes} minute${minutes === 1 ? "" : "s"})...` : "",
          ]
            .filter(Boolean)
            .join("\n")
            .concat("\n"),
        )
      }
      if (opts.open) {
        const url = browserUrl(challenge.verificationUriComplete)
        if (url) deps.openBrowser(url)
      }
    },
    settled(_challenge, outcome) {
      if (!opts.json && outcome === "approved") deps.stderr.write("Approved. Sending the request again.\n")
    },
  }
}

/**
 * 7.2: the hooks `candle core` gives its two key mints (`mintWithdrawKey`, `mintReadKey`). The pending
 * confirm reaches the Harness as an `owner_confirm` event with the `--json` line's fields (never the
 * `confirmId`), the core keeps polling and resends through the client flow, and the outcome is published.
 * A cancel from the Harness (`ownerConfirm.cancel`) adds the mint to `cancelled`, which stops the poll.
 */
export function coreOwnerConfirmHooks(
  mint: "withdraw" | "read",
  opts: {
    sleep: (ms: number) => Promise<void>
    now: () => number
    publish: (data: Record<string, unknown>) => void
    cancelled: Set<string>
  },
): OwnerConfirmHooks {
  return {
    wait: true,
    sleep: opts.sleep,
    now: opts.now,
    cancelled: () => opts.cancelled.has(mint),
    pending(challenge) {
      opts.cancelled.delete(mint)
      const line = JSON.parse(ownerConfirmPendingLine(challenge)) as { ownerConfirm: Record<string, unknown> }
      opts.publish({ mint, state: "pending", ...line.ownerConfirm })
    },
    settled(challenge, outcome) {
      opts.publish({ mint, state: outcome, step: challenge.step, summary: challenge.summary })
    },
  }
}
