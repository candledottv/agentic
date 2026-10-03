---
name: candle-wallet-layout
description: "[SETUP] How to lay out agent keys, TEE wallets and key signers when running more than one strategy, what is shared between wallets on one key, and how to move funds without landing on a look-alike address. Use when giving a second strategy its own wallet, choosing between one key and a key per bot, setting up a key signer on a trading machine, rebinding a wallet to another key, cleaning up old keys, sending funds between your own wallets, and whenever a destination address would come from transaction history."
---

## What this does

`candle-setup` installs the CLI, creates the vault and promotes a TEE wallet. This skill picks up when
there is more than one strategy, more than one key, or money moving between wallets: what each piece
isolates, what is shared, and the address checks every transfer needs.

Most steps here are the owner's: anything marked **(owner)** is run and typed by the account owner,
never by an agent on their behalf. An agent reads, proposes the exact command, and checks the result.

## The rule

**Give each strategy its own TEE wallet, keep every sweep home a cold vault key that was never
promoted, know what each key can reach, and copy every destination address from your own wallet or vault list, never from transaction history.**

## Wallets

- **A wallet per strategy.** A book's risk is then bounded by its own wallet's balance, its P&L reads
  straight off the chain, and one book's bug cannot spend another's funds. If two books must share a
  wallet, see `candle-book-limits`.
- **Promote fresh wallets (owner).** `candle vault promote --from <cold key> --to-key <label>` derives
  a new wallet. Once a key is promoted, the TEE provider holds its material and it is no longer cold.
  So never promote a sweep-home key in place, and do not reuse a wallet's address after it has been
  swept for a suspected compromise.
- **Recovery is the same for every wallet:** disable, sweep home, promote a fresh wallet (owner). It
  only works if each wallet's sweep home is a key you still control and have backed up.

## One key or a key per bot

Both work. Decide on purpose, because limits attach to the key, not the wallet.

| | One key for all books | A key per book |
|---|---|---|
| Per-trade cap and USD volume cap | Shared: size for all books together; one busy book can use up the volume cap for the rest | Per book |
| Loss limits set on the key | Apply to all its wallets together, so one book's losses can stop the others; per-book stops have to live in each book's own code | Per book, enforced by the rail |
| Signers on the trading machine | One | One per key |
| Keys to track, rotate and revoke | One | Several |

**Embedded wallet.** A key can pay from the account's embedded wallet only when it is allowed
(`--embedded-wallet allow` on `candle keys create`, or `candle keys update <key> --embedded-wallet
allow`, owner). New keys are denied by default; keep bot keys that should only trade their TEE
wallets denied. If a bot is meant to trade a TEE
wallet, it names that wallet as payer and refuses any request that would pay from another.

## Signers (bots on a different machine from the vault)

When bots trade from a different machine than the one holding the vault, use a key signer. The work
then splits across two machines:

| Owner's machine (vault, device token) | Trading machine (agent key only) |
|---|---|
| `candle keys create` for the bot key (owner) | `candle tee signer new --key <label>`, run with the bot's key in its environment; it prints a fingerprint and a code and waits |
| `candle keys signer approve <code> --key <label>`, typing the fingerprint read on the trading machine's screen (owner) | |
| `candle vault promote --from <cold key> --to-key <label>` for each wallet (owner) | the bots, trading every wallet bound to that key |

- **A wallet with a key signer trades from the machine holding the signer**, not from the machine
  that promoted it. (`candle-setup` describes the case without a key signer, where the relay signer
  stays on the promoting machine.)
- **One active signer per key.** Replace it on purpose (a new trading machine), never by adding a
  second to fix a fault. A second `candle tee signer new` leaves a second, pending request next to the
  active signer; the owner rejects it (`candle keys signer approve <code> --key <label> --reject`).
- **No device token on the trading machine.** A machine holding both a device token and a key
  signer can approve its own signer requests.

## Rebinds

`candle tee rebind <wallet> --to-key <label>` (owner) moves a wallet to another key. The behavior
below is as observed at the time of writing; check the command's help before relying on it.

- Onto a key **with** a signer, the binding and the wallet's owner move in one step, and the command
  runs on the machine holding the wallet's current signer. From anywhere else it refuses with
  nothing changed. That usually means a temporary owner login on the trading machine: log out
  afterwards, and revoke the device in the web console, since logout alone does not.
- Onto a key **without** a signer, only the binding moves; the wallet keeps its old signer.
- Between the rebind and the bot switching to the new key, the old key no longer has the wallet, so
  exits fail. Pause buys first and keep that window short. Positions opened under the old key exit
  normally under the new one.
- Test an unfamiliar key or wallet behavior on a throwaway key and wallet, with a trade of a few
  thousandths of a SOL, before it touches a live book.

## Know what every key can reach

Before any key or wallet change, list every key with `candle keys list` and `candle keys wallets
<prefix>`, and every wallet with `candle wallets`. For each key, know its access level, its embedded
wallet setting, the wallets bound to it, its signer and machine, and which bot uses it. A key nobody
can explain is a question for the owner before anything else. A key that holds no wallet and no job
is revoked and removed from every environment file in the same step.

Steps that widen access or move custody (create a key, promote, trust, rebind, approve a signer) are
the owner's. Steps that only reduce access (disable a wallet, revoke a key) must not wait on a
formality in an emergency; whoever takes one reports it to the owner at once.

## Addresses and transfers

- **Look-alike dust often follows a transfer.** Address poisoners watch for transfers and soon after
  send a tiny amount from an address that shares the first and last few characters with one
  of your real addresses, so it sits in the history next to the real one.
- **Copy destinations only from your own wallet list or vault list.** Never from transaction
  history, an explorer's recent list, or a chat message. Compare the whole address, not its ends.
  Confirm prompts that ask for the destination's last characters want them exactly, case included.
- **Agent transfers reach only the wallet's vault and the wallets you linked while signed in or
  marked trusted.** Trusting a wallet (`candle wallets trust`, owner) is what lets an agent send to
  it, so trust only your own wallets.
- **Know what a `max` or percent amount includes.** It may be refused for tokens, or take rent and
  fee reserves along with it. When that matters, send an exact amount read from the chain just
  before the transfer.
- **A failed or timed-out transfer is not proof that nothing moved.** Look for a signature and read
  both balances before trying again.
- **Fund over a reliable RPC.** A public RPC can drop a transaction; read the balance before
  sending again.

## Secrets

- Owner steps that type a secret run in a separate terminal from the agent, because an agent's shell
  history and logs keep what passes through them.
- **Assume any tool's output can carry a secret.** A key-creation command prints the new key once,
  and a wrapper that relays command output relays the key. If a key appears in an agent's transcript,
  do not repeat it; tell the owner, who revokes it and issues a new one.
- Check the API host and key that `candle doctor` reports before acting. An environment file or
  variable can point the CLI at another deployment without any other sign.

## Checklist

- A TEE wallet per strategy, promoted fresh; every sweep home a cold, backed-up vault key.
- One key or a key per book, chosen on purpose; bot keys deny the embedded wallet where they should;
  a bot meant for a TEE wallet names it as payer.
- With bots on a separate machine: one active signer per key there, approved by the owner, and no
  device token left there; rebinds run on the machine holding the current signer, with buys paused.
- Every key explained before a change; unused keys revoked and removed from environment files.
- Destinations copied from your own lists and compared in full; only own wallets trusted.
- Secrets typed by the owner, never echoed; any leaked key revoked.

## Related skills

- `candle-setup`: install, vault, promote, key access levels and the emergency stop.
- `candle-first-live-trade`: the first trades on a new wallet, key or signer.
- `candle-book-limits`: caps that can block exits, and two books on one wallet.
- `candle-trading-discipline`: the loss limits set on a key.

This skill is advisory. It does not authorize trades, transfers, or limit changes; those remain your operator's decision.
