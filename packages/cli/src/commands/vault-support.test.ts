import { expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createRoutedFetch, createTestDeps } from "../test-support"
import { confirmLastSix, confirmSend, groupAddress } from "./vault-support"

function fixture(answers: string[], json = false) {
  const stdout = createCapture()
  const stderr = createCapture()
  const asked: string[] = []
  const deps = createTestDeps({
    fetch: createRoutedFetch({}).fetch,
    stdout,
    stderr,
    promptLine: async (text) => {
      asked.push(text)
      return answers.shift() ?? ""
    },
  })
  return {
    ctx: { deps, json, apiUrl: "https://api.test", verifyAccount: false },
    stdout,
    stderr,
    asked,
    count: () => asked.length,
  }
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

const SOLANA = "D5Y2sSZvrMjgE9CTgLBxe2gJan5HKzMy8dGLFFXRGdjA"
const EVM = "0x000000000000000000000000000000000000dEaD"

test("groupAddress groups in fours, 0x as its own group, and round-trips both families", () => {
  expect(groupAddress(SOLANA)).toBe("D5Y2 sSZv rMjg E9CT gLBx e2gJ an5H KzMy 8dGL FFXR GdjA")
  expect(groupAddress(EVM)).toBe("0x 0000 0000 0000 0000 0000 0000 0000 0000 0000 dEaD")
  for (const address of [SOLANA, EVM, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "abc"]) {
    expect(groupAddress(address).replaceAll(" ", "")).toBe(address)
  }
})

test("confirmSend shows the destination grouped, then one prompt naming the send with the address whole", async () => {
  const f = fixture(["confirm"])
  await confirmSend(f.ctx, { amount: "1.5", asset: "SOL", address: SOLANA })
  expect(f.stdout.text).toBe("to   D5Y2 sSZv rMjg E9CT gLBx e2gJ an5H KzMy 8dGL FFXR GdjA\n")
  expect(f.asked).toEqual([`Type confirm to send 1.5 SOL to ${SOLANA}: `])
  const sweep = fixture(["confirm"])
  await confirmSend(sweep.ctx, { amount: "everything from trader", address: SOLANA })
  expect(sweep.asked).toEqual([`Type confirm to send everything from trader to ${SOLANA}: `])
})

test("confirmSend trims and ignores case", async () => {
  for (const word of ["confirm", "CONFIRM", "  Confirm\t", "\ncOnFiRm "]) {
    const f = fixture([word])
    await confirmSend(f.ctx, { amount: "1", asset: "ETH", address: EVM })
    expect(f.count()).toBe(1)
  }
})

test("confirmSend refuses anything else once, with DESTINATION_NOT_CONFIRMED and no retry", async () => {
  for (const word of ["", "yes", "y", "confirmed", "con firm", "dEaD", SOLANA.slice(-6)]) {
    const f = fixture([word, "confirm"])
    await expect(confirmSend(f.ctx, { amount: "1", asset: "SOL", address: SOLANA })).rejects.toMatchObject({
      code: "DESTINATION_NOT_CONFIRMED",
      message: "The send was not confirmed; nothing was done.",
    })
    expect(f.count()).toBe(1)
  }
})

test("confirmSend's grouped line is display only: on stderr under --json, never in the document", async () => {
  const f = fixture(["confirm"], true)
  await confirmSend(f.ctx, { amount: "1", asset: "ETH", address: EVM })
  expect(f.stdout.text).toBe("")
  expect(f.stderr.text).toBe("to   0x 0000 0000 0000 0000 0000 0000 0000 0000 0000 dEaD\n")
})

test("the three vault sends still refuse without a terminal, before any prompt", async () => {
  const sends = [
    ["vault", "transfer", SOLANA, "--amount", "1", "--asset", "SOL", "--from", "cold"],
    ["vault", "fund", SOLANA, "--amount", "1", "--asset", "SOL"],
    ["vault", "fund", EVM, "--amount", "1", "--asset", "ETH"],
    ["external", "sweep", "trader", "--to", "cold"],
  ]
  for (const args of sends) {
    const stdout = createCapture()
    const asked: string[] = []
    const deps = createTestDeps({
      fetch: createRoutedFetch({}).fetch,
      stdout,
      isTTY: { stdin: false, stdout: false, stderr: false },
      promptSecret: async (text) => {
        asked.push(text)
        return ""
      },
      promptLine: async (text) => {
        asked.push(text)
        return "confirm"
      },
    })
    expect(await run([...args, "--json"], deps)).toBe(1)
    expect(JSON.parse(stdout.text)).toMatchObject({ ok: false, code: "VAULT_UNLOCK_FAILED" })
    expect(JSON.parse(stdout.text).message).toContain("needs a terminal")
    expect(asked).toEqual([])
  }
})
