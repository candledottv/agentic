/** Shared by tool descriptions and every hosted/stdio server instruction mode. */
export const EXTERNAL_MARKET_DISCLOSURE =
  "For external tokens (external: true), buysOpen, sellsOpen, quoteMint, feeBps, venue, " +
  "graduationVenue and poolAddress are compatibility placeholders, not measured facts about " +
  "trading availability, pool pairing, fees or pool venue; trade.routable is stored eligibility " +
  "and does not verify those fields."

/**
 * BE-3794 (BE-3630 spec 6.3): the Hood holder-exit disclosure, quoted by `candle_get_market`,
 * `candle_holder_exit`, `candle_claim_holder_exit` and the server instructions, so an agent says it
 * before it acts on a launch that did not migrate. The state's own sentence is the API's
 * `holderExit.disclosure`; this server never writes its own.
 */
export const HOLDER_EXIT_DISCLOSURE =
  "On a Hood market, holderExit says where a holder stands if the launch does not migrate: state " +
  "(none, awaiting_migration, recovery_open, recovery, rescue_pending, rescued), the Recovery window " +
  "and rate, any rescue request, the team vesting escrow, and the actions that would succeed now. " +
  "holderExit.disclosure is one sentence for that state: quote it to the user verbatim before any " +
  "exit or trade on that token. Recovery pays by tokens held, not by what was paid. rescue_pending " +
  "closes buying; rescued has no on-chain claim."
