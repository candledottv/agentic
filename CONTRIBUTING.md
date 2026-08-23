# Contributing

This repository is a **read-only mirror**. It is generated from Candle's monorepo by a sync
workflow, so a pull request opened here cannot be merged: the next sync would overwrite it.

That is worth stating plainly rather than discovering after writing a patch.

## Where changes actually go

| What you want to change | Where it lives |
| --- | --- |
| SDK, MCP server, CLI behaviour | `packages/*` in the Candle monorepo |
| Skills, this README, the install docs | `distribution/agentic/` in the monorepo |
| Prose documentation | [docs.candle.tv](https://docs.candle.tv) |

If you are not a Candle contributor, the useful paths are:

- **Open an issue here.** Bug reports, missing capabilities, and confusing docs are all welcome,
  and issues are read. Include the tool or command you called, the error code you got back, and
  what you expected.
- **Report an API problem** through the developer surface at
  [docs.candle.tv](https://docs.candle.tv), which routes to the team that owns the rail.

## If you are a Candle contributor

Work in the monorepo. `distribution/agentic/` has a CI gate
(`scripts/check-agentic-skills.ts`) that pins every MCP tool name, every CLI subcommand, and every
Candle environment variable in this tree to what the MCP server and CLI actually ship.
Prose that drifts from the real surface fails the build rather than reaching users, so add the
capability first and describe it second.

## Security

Do not open a public issue for a vulnerability. Follow the disclosure process at
[docs.candle.tv/legal/vulnerability-disclosure](https://docs.candle.tv/legal/vulnerability-disclosure).

## License

MIT, see [LICENSE](LICENSE). Contributions are accepted under the same terms.
