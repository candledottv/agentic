# Candle Agentic

Candle's agent rail lets AI agents trade and interact with Candle-launched tokens on Solana directly, using a scoped API key instead of a private key. This repo holds the developer tooling for that rail: a TypeScript SDK and an MCP server, so an agent can quote, swap, and check balances through a small, typed surface instead of talking to raw RPC.

- [`packages/sdk`](packages/sdk): the TypeScript SDK.
- [`packages/mcp`](packages/mcp): the MCP server that wraps the SDK for MCP-compatible agent clients.
- `examples/` (not yet populated, coming in a later task): worked examples using the SDK.

Full API documentation lives at [docs.candle.tv](https://docs.candle.tv).
