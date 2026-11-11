import { expect, test } from "bun:test"
import { buildRequest } from "./tools"

test("explicit operation id and proof recovery map to dedicated endpoints", () => {
  const cfg = { apiUrl: "https://api.fixture.test", apiKey: "key" }
  const status = buildRequest("candle_get_operation", { operationId: "op" }, cfg)
  expect(status.url).toBe("https://api.fixture.test/api/v1/agent/hood-tee/operations/op")
  expect(status.init.method).toBe("GET")
  expect(() => buildRequest("candle_get_operation", { operationId: "op", clientId: "client" }, cfg)).toThrow(
    /exclusive/,
  )
  const recovery = buildRequest("candle_recover_operation", { operationId: "op", candidateHash: "0xhash" }, cfg)
  expect(recovery.url).toBe("https://api.fixture.test/api/v1/agent/hood-tee/operations/op/recover")
  expect(JSON.parse(String(recovery.init.body))).toEqual({ candidateHash: "0xhash" })
})
