---
name: candle-webhooks
description: "[EVENTS] Register a webhook endpoint and verify signed Candle event deliveries for launches, graduations, migrations, and trades. Use when the user asks about webhooks, notifications, or reacting to fills or graduations instead of polling."
---

## What this does

Most agent toolkits only know what happened by polling. Candle can push events instead: launch
confirmations, curve graduations, migrations, and executed trades, signed and delivered to an
endpoint you register, so an agent reacts the moment something happens rather than discovering it
on the next poll.

## Setup

Registering an endpoint is a logged-in-session operation, not an agent-key one: `POST
/api/v1/agent/webhooks` requires a real account session (the portal, or a Privy bearer token for a
direct API call) and rejects an agent API key or device token exactly the way it would reject
anything else unauthenticated. Agent features must already be enabled on the account (see the
candle-setup skill). None of this runs through the MCP server or the CLI today: there is no tool or
command for it. What an agent's own runtime actually needs afterward is just the signing secret
handed back at registration; that secret (not a session, a key, or a token) is the only credential
delivery verification requires.

## The workflow

1. From a logged-in session, register an endpoint: `POST /api/v1/agent/webhooks` with a public
   https `url` and the `events` you want (for example `curve.graduated`, `trade.executed`,
   `launch.confirmed`, `launch.failed`, `migration.completed`, `migration.delayed`). The response
   includes a signing secret (`whsec_...`) shown exactly once; store it where your agent's own code
   can reach it, since it is never shown again.
2. Verify every delivery before acting on it, using only that secret. Each delivery carries a
   header shaped `x-candle-signature: t=<unix seconds>,v1=<hex hmac>`. The SDK's
   `verifyWebhookSignature(secret, header, body, nowSec)` (exported from `packages/sdk`) checks the
   signature and a timestamp tolerance in one call. Always verify against the raw request body
   text, never a re-serialized copy: re-serializing JSON can reorder keys and silently break the
   signature.
3. Respond 2xx quickly. A failing or slow endpoint gets retried on a backoff for roughly 12 hours
   before Candle gives up on that delivery.
4. List endpoints, inspect recent delivery attempts, or revoke an endpoint, all from that same
   session surface (`GET`/`DELETE /api/v1/agent/webhooks`, `GET /api/v1/agent/webhooks/:id/deliveries`).

## Safety rails

Never act on an unverified delivery: always check the signature first. Only public https endpoints
are accepted, checked at registration and re-checked on every delivery; loopback and private
targets are rejected. An account can register at most 3 active endpoints at once.

## Example

"Tell me the moment this token graduates, don't make me poll for it."
1. Register an endpoint for `curve.graduated` (and `trade.executed`, if fills matter too).
2. On each delivery, verify it with `verifyWebhookSignature` before reacting to the payload.
3. Treat the delivery's `id` as the dedupe key. Its `createdAt` is the moment THAT delivery attempt
   was sent, stamped per attempt, so a retry of the same event carries a later `createdAt` than the
   first try did. It is not the time the underlying event happened, and the delivery body carries
   no separate event timestamp: when the exact event time matters, resolve it on-chain from the
   `signature` the payload carries (launch and trade events include one).

For the full endpoint and event reference, see docs.candle.tv.
