import { expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createRoutedFetch, createTestDeps } from "../test-support"
import { confirmAddress, confirmSend, groupAddress, typedConfirm } from "./vault-support"

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

test("confirmAddress (BE-1710): the address grouped under its label, then one prompt naming the action", async () => {
  const f = fixture(["confirm"])
  await confirmAddress(f.ctx, "key", SOLANA, `export the key for ${SOLANA}`)
  expect(f.stdout.text).toBe("key  D5Y2 sSZv rMjg E9CT gLBx e2gJ an5H KzMy 8dGL FFXR GdjA\n")
  expect(f.asked).toEqual([`Type confirm to export the key for ${SOLANA}: `])
  const account = fixture(["  CONFIRM "])
  await confirmAddress(account.ctx, "account", EVM, `act as account ${EVM}`)
  expect(account.stdout.text).toBe("account 0x 0000 0000 0000 0000 0000 0000 0000 0000 0000 dEaD\n")
})

test("confirmAddress refuses anything else once, the old last six included, with nothing done", async () => {
  for (const word of ["", "yes", "confirmed", SOLANA.slice(-6), SOLANA]) {
    const f = fixture([word, "confirm"])
    await expect(confirmAddress(f.ctx, "vault", SOLANA, `sweep everything to ${SOLANA}`)).rejects.toMatchObject({
      code: "DESTINATION_NOT_CONFIRMED",
      message: "That was not confirmed; nothing was done.",
    })
    expect(f.count()).toBe(1)
  }
})

test("typedConfirm answers the word without throwing, its grouped line on stderr under --json", async () => {
  const yes = fixture(["Confirm"], true)
  expect(await typedConfirm(yes.ctx, "vault", SOLANA, "sweep")).toBe(true)
  expect(yes.stdout.text).toBe("")
  expect(yes.stderr.text).toBe("vault D5Y2 sSZv rMjg E9CT gLBx e2gJ an5H KzMy 8dGL FFXR GdjA\n")
  const no = fixture([SOLANA.slice(-6)])
  expect(await typedConfirm(no.ctx, "vault", SOLANA, "sweep")).toBe(false)
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
