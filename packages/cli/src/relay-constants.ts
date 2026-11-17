/**
 * The Relay (relay.link) contracts Candle signs deposits to, pinned in code rather than env (Ember
 * Phase 4c, 4c-ED-4, spec docs/superpowers/specs/2026-09-29-ember-phase-4c-relay-bridging-design.md).
 *
 * Every value here was read off a live `POST /quote` on 2026-09-29 (spec S16). A Relay contract
 * change is a PR to this file, never a config edit: the step verifier refuses anything else, and
 * `scripts/check-relay-endpoints.ts` quotes both directions nightly and diffs the targets against
 * these constants so a move is reported before it is refused.
 */

/** Relay's depository on Hood (chain 4663). Every Hood-origin deposit, and every approve's spender. */
export const RELAY_HOOD_DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31"

/**
 * Relay's same-chain swap contracts on Hood (chain 4663, v3.2, from Relay's `/chains`), the target of
 * an ETH <-> USDG `swap` step on `POST /agent/swap`. `erc20Router` is the ETH origin's target;
 * `approvalProxy` is the USDG origin's approve spender and swap target.
 */
export const RELAY_HOOD_ERC20_ROUTER = "0x0729e2a4716d9f7dd17858d5d504426d228697f7"
export const RELAY_HOOD_APPROVAL_PROXY = "0x5567954cd026cebfe486062cb75848e0f1c12e58"

/**
 * The ETH origin's same-chain swap on `erc20Router`:
 * `multicall((address target, bool allowFailure, uint256 value, bytes callData)[] calls,
 * address refundTo, address nftRecipient, bytes metadata)`, payable with `value` = the amount.
 */
export const RELAY_HOOD_ROUTER_MULTICALL_SELECTOR = "0xcd6e13f7"

/**
 * The USDG origin's same-chain swap on `approvalProxy`:
 * `transferAndMulticall(address[] tokens, uint256[] amounts, (address,bool,uint256,bytes)[] calls,
 * address refundTo, address nftRecipient, bytes metadata)`, `value` 0, after an approve to the proxy.
 */
export const RELAY_HOOD_TRANSFER_AND_MULTICALL_SELECTOR = "0xf9e4bab4"

/**
 * Bytes Relay appends after the ABI-encoded swap call on Hood (a 32-byte tag on every live quote,
 * 2026-11-17). The ABI decoder ignores them, so they cannot change what the call does; any other
 * trailer length refuses.
 */
export const RELAY_HOOD_SWAP_CALLDATA_TRAILER_BYTES: readonly number[] = [0, 32]

/** `deposit(address depositor, bytes32 id)` with `value` = the amount: a native ETH origin. */
export const RELAY_HOOD_DEPOSIT_NATIVE_SELECTOR = "0x49290c1c"

/** `deposit(address depositor, address token, uint256 amount, bytes32 id)` with `value` 0: an ERC-20 origin. */
export const RELAY_HOOD_DEPOSIT_ERC20_SELECTOR = "0xe8017952"

/** The complete set of Hood deposit selectors today's quotes use. Any other selector refuses. */
export const RELAY_HOOD_DEPOSIT_SELECTORS: readonly string[] = [
  RELAY_HOOD_DEPOSIT_NATIVE_SELECTOR,
  RELAY_HOOD_DEPOSIT_ERC20_SELECTOR,
]

/** Relay's Solana depository program: the only top-level program a Solana deposit may invoke. */
export const RELAY_SOLANA_DEPOSITORY_PROGRAM = "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2"

/**
 * The most a Solana Relay deposit may pay in network fees, in lamports: one signature's base fee.
 * No live quote carries a Compute Budget instruction, and a priority fee is the one way a drain
 * could still present as a network fee, so the cap admits the base fee and nothing more.
 */
export const RELAY_SOLANA_MAX_NETWORK_FEE_LAMPORTS = 5_000
