# Public Hyperliquid recording

`recording.json` records the capture timestamp, public URL, and five exact request bodies. Each adjacent JSON file is the complete decoded response. No key, account, signature, relay, or `/exchange` was used. Tests replay these files offline.

Spec B verification:

- Universe size: 234 entries, including delisted entries. The default list has no artificial limit.
- `marginTables` is present in `metaAndAssetCtxs[0]`; BTC references table 56 and has multiple tiers. No additional `meta` read is needed.
- Funding period: `predictedFundings`'s `HlPerp` entries explicitly contain `fundingIntervalHours: 1`. Asset-context funding is the hourly rate, annualized here by `24 * 365 * 100`. The official [funding documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding) distinguishes the eight-hour calculation formula from its one-eighth hourly payment.
- OI cap: the recorded cap set contains CANTO, FTM, JELLY, LOOM, RLB, VINE and ZEREBRO. A public read cannot demonstrate order refusal. The official [error contract](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses) documents position increase/flip and overly aggressive price refusals at the cap. This is reported separately from Candle's gate; no order was attempted.
- Weights are not included in these response bodies. The official [rate-limit documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits) assigns 20 to each of `metaAndAssetCtxs`, `predictedFundings` and `perpsAtOpenInterestCap`; `l2Book` is 2. Thus a cold market list/detail is 60, book is 22, and candles are **40 plus candle response weight**, including the 20-weight coin-resolution read. The spec's candles estimate of 20 omitted that resolution read. `candleSnapshot` adds weight per 60 returned items. This recording contains four candles.

API facts above were checked on 2026-10-17. Response values are a historical fixture, not current prices or a tradeability promise.
