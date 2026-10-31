import { expect, test } from "bun:test"
import { CandleClient } from "./client"
import { CandleApiError } from "./errors"

const mint = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT"
const payload = {
  chain: "solana",
  mint,
  changed: true,
  version: 1,
  description: "",
  socials: { twitter: "https://x.com/gadi" },
  chainState: "candle",
  chainTx: null,
}

function client(answer: (url: string, init: RequestInit) => Response, apiKey: string | null = "cdl_key") {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return answer(url, init)
  }) as unknown as typeof fetch
  return {
    calls,
    sdk: new CandleClient({ apiUrl: "https://api.example", apiKey: apiKey ?? undefined, fetch: fetchImpl }),
  }
}

test("editTokenMetadata PATCHes the four-key body with the key and an Idempotency-Key, and returns the payload", async () => {
  const { calls, sdk } = client(() => Response.json({ success: true, payload }))
  const result = await sdk.editTokenMetadata(
    { chain: "solana", mint, socials: { twitter: "https://x.com/gadi", website: null } },
    { idempotencyKey: "k-1" },
  )
  expect(result).toEqual(payload as never)
  const [call] = calls
  expect(call?.url).toBe(`https://api.example/api/v1/tokens/solana/${mint}/metadata`)
  expect(call?.init.method).toBe("PATCH")
  const headers = call?.init.headers as Record<string, string>
  expect(headers["Idempotency-Key"]).toBe("k-1")
  expect(headers["x-api-key"]).toBe("cdl_key")
  expect(JSON.parse(String(call?.init.body))).toEqual({ socials: { twitter: "https://x.com/gadi", website: null } })
})

test("editTokenMetadata sends a fresh key when none is given, and only the fields named", async () => {
  const { calls, sdk } = client(() => Response.json({ success: true, payload }))
  await sdk.editTokenMetadata({ chain: "hood", mint: "0xabc", description: "" })
  const headers = calls[0]?.init.headers as Record<string, string>
  expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/)
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ description: "" })
})

test("editTokenMetadata needs a key and throws the API's code on a refusal", async () => {
  await expect(client(() => Response.json({}), null).sdk.editTokenMetadata({ chain: "solana", mint })).rejects.toThrow(
    "requires an apiKey",
  )
  const { sdk } = client(() =>
    Response.json(
      { success: false, error: { code: "ONCHAIN_METADATA_TOKEN", message: "edit on chain", retryable: false } },
      { status: 409 },
    ),
  )
  const error = await sdk.editTokenMetadata({ chain: "hood", mint: "0xabc", description: "x" }).catch((e) => e)
  expect(error).toBeInstanceOf(CandleApiError)
  expect((error as CandleApiError).code).toBe("ONCHAIN_METADATA_TOKEN")
})

test("tokenMetadataHistory reads the public history with cursor and limit", async () => {
  const page = { chain: "solana", mint, items: [], nextCursor: null }
  const { calls, sdk } = client(() => Response.json({ success: true, payload: page }))
  expect(await sdk.tokenMetadataHistory({ chain: "solana", mint, cursor: "3", limit: 2 })).toEqual(page as never)
  expect(calls[0]?.url).toBe(`https://api.example/api/v1/tokens/solana/${mint}/metadata/history?limit=2&cursor=3`)
  expect(calls[0]?.init.method).toBe("GET")
})
