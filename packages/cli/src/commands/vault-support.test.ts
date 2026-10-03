import { expect, test } from "bun:test"
import { createCapture, createRoutedFetch, createTestDeps } from "../test-support"
import { confirmLastSix } from "./vault-support"

function fixture(answers: string[]) {
  const stderr = createCapture()
  let prompts = 0
  const deps = createTestDeps({
    fetch: createRoutedFetch({}).fetch,
    stderr,
    promptLine: async () => {
      prompts++
      return answers.shift() ?? ""
    },
  })
  return { ctx: { deps, json: false, apiUrl: "https://api.test", verifyAccount: false }, stderr, count: () => prompts }
}

test("confirmLastSix reports first differing character and accepts a correct retry", async () => {
  const f = fixture(["aB3kqz", "aB3kQz"])
  await confirmLastSix(f.ctx, "AddressaB3kQz", "destination")
  expect(f.count()).toBe(2)
  expect(f.stderr.text).toContain("Expected  aB3kQz\nYou typed aB3kqz\n              ^ character 5 differs")
})

test("confirmLastSix fails after three wrong attempts with DESTINATION_NOT_CONFIRMED", async () => {
  const f = fixture(["wrong1", "wrong2", "wrong3", "aB3kQz"])
  try {
    await confirmLastSix(f.ctx, "AddressaB3kQz", "destination")
    throw new Error("accepted mismatch")
  } catch (error) {
    expect(error).toMatchObject({ code: "DESTINATION_NOT_CONFIRMED" })
  }
  expect(f.count()).toBe(3)
})

test("confirmLastSix ignores case for 0x addresses and not for base58", async () => {
  const evm = fixture(["ABCdef"])
  await confirmLastSix(evm.ctx, "0x0000000000000000000000000000000000abcdef", "destination")
  expect(evm.count()).toBe(1)
  const solana = fixture(["abcDEF", "abcdef"])
  await confirmLastSix(solana.ctx, "Addressabcdef", "destination")
  expect(solana.count()).toBe(2)
})
