/**
 * Ember Phase 4a (BE-350, spec `2026-09-24-ember-phase-4a-evm-vault-keys-design.md`, §6), E1 and
 * E2: the EVM primitives against published vectors and against `viem`.
 *
 * `viem` is a devDependency and appears in no shipped file: it is the independent implementation
 * the bytes `evm-lite` produces are checked against. A round trip would prove the code agrees with
 * itself; a wallet app or a node must also agree, so the checks here are against BIP-32's published
 * test vector, against `viem`'s `mnemonicToAccount` (which IS `m/44'/60'/n'/0/0` for
 * `accountIndex: n`), and against `viem`'s serializer and signer byte for byte.
 */
import { describe, expect, test } from "bun:test"
import { HDKey } from "@scure/bip32"
import { mnemonicToSeedSync } from "@scure/bip39"
import { keccak256, parseTransaction, recoverAddress, recoverTransactionAddress, serializeTransaction } from "viem"
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts"
import {
  buildErc20Transfer,
  buildNativeTransfer,
  bytesToHex,
  checkEvmAddress,
  decodeErc20Transfer,
  deriveEvmKey,
  encodeErc20Transfer,
  evmAddressFromSecret,
  evmDerivationPath,
  formatUnits,
  gasWithHeadroom,
  hexToBytes,
  parseUnits,
  requiredDepth,
  rlpEncode,
  signingPayload,
  signTransaction,
  toChecksumAddress,
  uintToMinimalBytes,
} from "./evm-lite"
import { deriveEvmKeyFromRoot, evmPath } from "./vault/hd"
import { FIXTURE_ENTROPY, FIXTURE_PHRASE } from "./vault/test-vault"

const seed = mnemonicToSeedSync(FIXTURE_PHRASE, "")

describe("E1: BIP-32 through @scure/bip32 as bundled, and the fixture root against viem", () => {
  test("BIP-32 test vector 1, master and the hardened/non-hardened chain, key by key", () => {
    // The published vector: seed 000102...0f, path m/0'/1/2'/2/1000000000.
    const root = HDKey.fromMasterSeed(hexToBytes("000102030405060708090a0b0c0d0e0f"))
    expect(bytesToHex(root.privateKey as Uint8Array)).toBe(
      "0xe8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35",
    )
    expect(bytesToHex(root.chainCode as Uint8Array)).toBe(
      "0x873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508",
    )
    const leaf = root.derive("m/0'/1/2'/2/1000000000")
    expect(bytesToHex(leaf.privateKey as Uint8Array)).toBe(
      "0x471b76e389e528d6de6d816857e012c5455051cad6660850e58372a6c3e6e7c8",
    )
    expect(bytesToHex(leaf.chainCode as Uint8Array)).toBe(
      "0xc783e67b921d2beb8f6b389cc646d7263b4145701dadd2161548a8b078e65e9e",
    )
  })

  test("indices 0..2 of the fixture phrase match viem's mnemonicToAccount with accountIndex n", () => {
    for (let index = 0; index < 3; index++) {
      const ours = deriveEvmKey(seed, index)
      const theirs = mnemonicToAccount(FIXTURE_PHRASE, { accountIndex: index })
      expect(ours.path).toBe(`m/44'/60'/${index}'/0/0`)
      expect(ours.address).toBe(theirs.address)
      // And the scalar itself, not only the address it hashes to.
      const secret = privateKeyToAccount(bytesToHex(ours.secret) as `0x${string}`)
      expect(secret.address).toBe(theirs.address)
    }
  })

  test("the path is Phase 2's Ledger Live layout, one hardened account per key, and hd.ts agrees", async () => {
    expect(evmDerivationPath(0)).toBe("m/44'/60'/0'/0/0")
    expect(evmDerivationPath(7)).toBe(evmPath(7))
    expect(evmDerivationPath(3)).not.toBe("m/44'/60'/0'/0/3")
    // From the root entropy through `hd.ts`, the derivation event the commands use.
    const fromRoot = await deriveEvmKeyFromRoot(Uint8Array.from(FIXTURE_ENTROPY), 1)
    expect(fromRoot.address).toBe(mnemonicToAccount(FIXTURE_PHRASE, { accountIndex: 1 }).address)
    expect(fromRoot.secret.length).toBe(32)
    expect(evmAddressFromSecret(fromRoot.secret)).toBe(fromRoot.address)
    expect(deriveEvmKey(seed, 0).address).toBe(FIXTURE_EVM_0)
    expect(deriveEvmKey(seed, 1).address).toBe(FIXTURE_EVM_1)
  })

  test("the address is EIP-55 checksummed, and the checksum check refuses a wrong mixed case", () => {
    const address = deriveEvmKey(seed, 0).address
    expect(address).toBe(toChecksumAddress(address.toLowerCase()))
    expect(checkEvmAddress(address)).toEqual({ ok: true, address })
    expect(checkEvmAddress(address.toLowerCase())).toEqual({ ok: true, address })
    // Flip the case of one letter: mixed case that fails EIP-55.
    const letter = address.split("").findIndex((c, i) => i > 1 && /[a-f]/.test(c))
    const wrong = `${address.slice(0, letter)}${(address[letter] as string).toUpperCase()}${address.slice(letter + 1)}`
    expect(checkEvmAddress(wrong)).toMatchObject({ ok: false })
    expect(checkEvmAddress("0x1234")).toMatchObject({ ok: false })
    expect(checkEvmAddress("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")).toMatchObject({ ok: false })
  })
})

describe("E2: the two type-2 shapes against viem, byte for byte", () => {
  const key = deriveEvmKey(seed, 0)
  const account = privateKeyToAccount(bytesToHex(key.secret) as `0x${string}`)
  const DEAD = "0x000000000000000000000000000000000000dEaD"
  const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"

  test("integers are minimal big-endian and zero is the empty string; RLP matches the published cases", () => {
    expect(uintToMinimalBytes(0n)).toEqual(new Uint8Array(0))
    expect(uintToMinimalBytes(1n)).toEqual(Uint8Array.of(1))
    expect(uintToMinimalBytes(255n)).toEqual(Uint8Array.of(255))
    expect(uintToMinimalBytes(256n)).toEqual(Uint8Array.of(1, 0))
    // The RLP examples from the yellow paper / wiki.
    expect(rlpEncode(new Uint8Array(0))).toEqual(Uint8Array.of(0x80))
    expect(rlpEncode(Uint8Array.of(0x0f))).toEqual(Uint8Array.of(0x0f))
    expect(rlpEncode(new TextEncoder().encode("dog"))).toEqual(Uint8Array.of(0x83, 0x64, 0x6f, 0x67))
    expect(rlpEncode([new TextEncoder().encode("cat"), new TextEncoder().encode("dog")])).toEqual(
      Uint8Array.of(0xc8, 0x83, 0x63, 0x61, 0x74, 0x83, 0x64, 0x6f, 0x67),
    )
    expect(rlpEncode([])).toEqual(Uint8Array.of(0xc0))
    expect(rlpEncode([[], [[]], [[], [[]]]])).toEqual(Uint8Array.of(0xc7, 0xc0, 0xc1, 0xc0, 0xc3, 0xc0, 0xc1, 0xc0))
    const long = new TextEncoder().encode("Lorem ipsum dolor sit amet, consectetur adipisicing elit")
    expect(rlpEncode(long).subarray(0, 2)).toEqual(Uint8Array.of(0xb8, 0x38))
  })

  test("a native transfer serializes as viem does, signs as viem signs, and hashes the raw bytes", async () => {
    const cases = [
      {
        chainId: 4663n,
        nonce: 0n,
        tip: 1_000_000n,
        max: 200_000_000n,
        gas: 21_000n,
        value: 1_500_000_000_000_000_000n,
      },
      { chainId: 1n, nonce: 256n, tip: 0n, max: 0n, gas: 21_000n, value: 0n },
      { chainId: 8453n, nonce: 7n, tip: 1n, max: 1n << 64n, gas: 25_200n, value: 1n },
      // Signatures are deterministic (RFC 6979), so yParity is fixed per case; a run of nonces is
      // what makes both values appear, and every one of them is checked against viem.
      ...Array.from({ length: 8 }, (_, nonce) => ({
        chainId: 4663n,
        nonce: BigInt(nonce + 100),
        tip: 2n,
        max: 300n,
        gas: 21_000n,
        value: 10n ** 15n,
      })),
    ]
    let parities = new Set<number>()
    for (const c of cases) {
      const tx = buildNativeTransfer({
        chainId: c.chainId,
        nonce: c.nonce,
        maxPriorityFeePerGas: c.tip,
        maxFeePerGas: c.max,
        gas: c.gas,
        to: DEAD,
        value: c.value,
      })
      expect(tx.data.length).toBe(0)
      const theirs = {
        type: "eip1559" as const,
        chainId: Number(c.chainId),
        nonce: Number(c.nonce),
        maxPriorityFeePerGas: c.tip,
        maxFeePerGas: c.max,
        gas: c.gas,
        to: DEAD as `0x${string}`,
        value: c.value,
        accessList: [],
      }
      // The signing payload is keccak of viem's unsigned serialization.
      expect(bytesToHex(signingPayload(tx))).toBe(keccak256(serializeTransaction(theirs)))
      const signed = signTransaction(tx, key.secret)
      const viemSigned = await account.signTransaction(theirs)
      expect(bytesToHex(signed.raw)).toBe(viemSigned)
      expect(signed.hash).toBe(keccak256(viemSigned as `0x${string}`) as string)
      expect(
        await recoverTransactionAddress({ serializedTransaction: bytesToHex(signed.raw) as `0x02${string}` }),
      ).toBe(key.address as `0x${string}`)
      const parsed = parseTransaction(bytesToHex(signed.raw) as `0x${string}`)
      expect(parsed.yParity).toBe(signed.yParity)
      expect(parsed.nonce).toBe(Number(c.nonce))
      expect(parsed.value ?? 0n).toBe(c.value)
      parities = parities.add(signed.yParity)
    }
    expect(parities).toEqual(new Set([0, 1]))
  })

  test("an ERC-20 transfer is exactly transfer(address,uint256), and serializes as viem does", async () => {
    const tx = buildErc20Transfer({
      chainId: 4663n,
      nonce: 3n,
      maxPriorityFeePerGas: 1_000n,
      maxFeePerGas: 2_000n,
      gas: 60_000n,
      token: USDG,
      recipient: DEAD,
      amount: 1_500_000n,
    })
    expect(tx.to).toBe(toChecksumAddress(USDG))
    expect(tx.value).toBe(0n)
    expect(tx.data.length).toBe(68)
    expect(bytesToHex(tx.data)).toBe(
      "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead000000000000000000000000000000000000000000000000000000000016e360",
    )
    expect(decodeErc20Transfer(tx.data)).toEqual({ recipient: DEAD, amount: 1_500_000n })
    expect(decodeErc20Transfer(encodeErc20Transfer(DEAD, 0n))).toEqual({ recipient: DEAD, amount: 0n })
    expect(decodeErc20Transfer(new Uint8Array(4))).toBeUndefined()

    const theirs = {
      type: "eip1559" as const,
      chainId: 4663,
      nonce: 3,
      maxPriorityFeePerGas: 1_000n,
      maxFeePerGas: 2_000n,
      gas: 60_000n,
      to: tx.to as `0x${string}`,
      value: 0n,
      data: bytesToHex(tx.data) as `0x${string}`,
      accessList: [],
    }
    const signed = signTransaction(tx, key.secret)
    expect(bytesToHex(signed.raw)).toBe(await account.signTransaction(theirs))
    expect(signed.hash).toBe(keccak256(bytesToHex(signed.raw) as `0x${string}`) as string)
    expect(signed.raw[0]).toBe(0x02)
    // The signature recovers to the key's address, from the payload and (r, s, yParity).
    const recovered = await recoverAddress({
      hash: bytesToHex(signingPayload(tx)) as `0x${string}`,
      signature: {
        r: `0x${signed.r.toString(16).padStart(64, "0")}`,
        s: `0x${signed.s.toString(16).padStart(64, "0")}`,
        yParity: signed.yParity,
      },
    })
    expect(recovered).toBe(key.address as `0x${string}`)
  })

  test("units, headroom and depth are integer arithmetic", () => {
    expect(formatUnits(1_500_000_000_000_000_000n, 18)).toBe("1.5")
    expect(formatUnits(0n, 18)).toBe("0")
    expect(formatUnits(1n, 6)).toBe("0.000001")
    expect(formatUnits(1_000_000n, 6)).toBe("1")
    expect(parseUnits("1.5", 18)).toEqual({ ok: true, raw: 1_500_000_000_000_000_000n })
    expect(parseUnits("0.0000001", 6)).toEqual({ ok: false, reason: "precision" })
    expect(parseUnits("0", 6)).toEqual({ ok: false, reason: "zero" })
    expect(parseUnits("max", 6)).toEqual({ ok: false, reason: "not-a-number" })
    expect(gasWithHeadroom(21_000n)).toBe(25_200n)
    expect(gasWithHeadroom(1n)).toBe(2n)
    expect(requiredDepth(4663n)).toBe(1)
    expect(requiredDepth(1n)).toBe(2)
  })
})

/** The fixture root's EVM indices 0 and 1, recorded so a derivation change is a test failure (as T53's Solana anchors are). */
export const FIXTURE_EVM_0 = "0xF9297b542BDb5DA50C364f9AE4Cbe1F3933bA40F"
export const FIXTURE_EVM_1 = "0x8771B6667865B8Ce9586686211A271d496C90552"
