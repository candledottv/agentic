/**
 * The credential must not survive into an error message.
 *
 * Written from a real incident: a caller forwarded one of these messages to a Discord alert
 * channel on 2026-08-27 and had to rotate a production Helius key. The two shapes below are the
 * two real providers, and they hide the key in different places -- query string and path -- so
 * both are pinned rather than one standing in for the other.
 */
import { describe, expect, test } from "bun:test"
import { describeRpcEndpoint } from "./rpc-endpoint"

const SECRET = "2de0ff42-dead-beef-cafe-000000000000"

describe("describeRpcEndpoint", () => {
  test("drops a key carried in the QUERY string, as Helius does", () => {
    const out = describeRpcEndpoint(`https://mainnet.helius-rpc.com/?api-key=${SECRET}`)
    expect(out).toBe("https://mainnet.helius-rpc.com")
    expect(out).not.toContain(SECRET)
  })

  test("drops a key carried in the PATH, as Alchemy does", () => {
    const out = describeRpcEndpoint(`https://robinhood-mainnet.g.alchemy.com/v2/${SECRET}`)
    expect(out).toBe("https://robinhood-mainnet.g.alchemy.com")
    expect(out).not.toContain(SECRET)
  })

  test("keeps the host, which is the part worth reading", () => {
    expect(describeRpcEndpoint("https://api.mainnet-beta.solana.com")).toBe("https://api.mainnet-beta.solana.com")
  })

  test("keeps a non-default port, since two local nodes are told apart by it", () => {
    expect(describeRpcEndpoint("http://127.0.0.1:8899")).toBe("http://127.0.0.1:8899")
  })

  test("drops userinfo credentials too", () => {
    const out = describeRpcEndpoint(`https://user:${SECRET}@rpc.example.com/path`)
    expect(out).not.toContain(SECRET)
    expect(out).toBe("https://rpc.example.com")
  })

  /*
    This runs while an error is being CONSTRUCTED. Throwing here would replace a real RPC failure
    with a URL-parsing one and lose the original, so an unparseable value degrades instead -- and
    is never echoed back, since echoing it is the leak this function exists to prevent.
  */
  test("an unparseable url is reported as unknown, never echoed and never thrown", () => {
    expect(() => describeRpcEndpoint("not a url")).not.toThrow()
    expect(describeRpcEndpoint("not a url")).toBe("<unparseable rpc endpoint>")
    expect(describeRpcEndpoint(`::${SECRET}::`)).not.toContain(SECRET)
  })

  test("an empty string does not throw either", () => {
    expect(() => describeRpcEndpoint("")).not.toThrow()
  })
})
