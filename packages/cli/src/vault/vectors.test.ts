/**
 * T53 (CC-11, ED-13, AD-5): the published vectors, run through the SHIPPED code.
 *
 * This is the test everything else in Phase 2 is checked against, which is why it comes first and
 * why it uses published vectors rather than round trips. A round trip proves the code agrees with
 * itself; a derived address that a wallet app must also produce has to agree with BIP-39 and
 * SLIP-0010 as published, because the whole promise of AD-5 is that any BIP-39 plus SLIP-0010
 * implementation re-derives these keys with this CLI gone.
 *
 * The in-repo SLIP-0010 (ED-13) is the reason the second block matters most: it is twenty lines
 * this repository owns, and the two things a reimplementation gets wrong -- the `0x00` padding byte
 * before the parent key, and admitting a non-hardened index -- are both pinned here.
 *
 * The BIP-32 secp256k1 half of T53 is listed in the spec and runs in the Phase 4 PR that declares
 * `@scure/bip32`; Phase 2 adds no secp256k1 derivation code, so there is nothing here to run it
 * against, and the placeholder at the bottom records that rather than leaving a silent gap.
 */
import { describe, expect, test } from "bun:test"
import { mnemonicToSeedSync } from "@scure/bip39"
import { addressFromSecret64 } from "./ed25519"
import { VaultError } from "./errors"
import {
  deriveSolanaKey,
  entropyFromPhrase,
  evmPath,
  phraseFromEntropy,
  seedFromEntropy,
  solanaTeePath,
  solanaVaultPath,
} from "./hd"
import { deriveChild, derivePath, HARDENED_OFFSET, masterFromSeed, parsePath } from "./slip10"

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex")
const unhex = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "hex"))

describe("BIP-39 published vectors, through @scure/bip39 as bundled", () => {
  // The Trezor reference vectors (english.json), 256-bit entries: entropy -> phrase -> seed, with
  // the empty optional passphrase this format fixes (ED-13). The published set uses the passphrase
  // "TREZOR"; the seeds below are therefore computed for BOTH, and the empty-passphrase seed is
  // the one this CLI's derivations actually consume.
  const vectors = [
    {
      entropy: "0000000000000000000000000000000000000000000000000000000000000000",
      phrase:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
      trezorSeed:
        "bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd3097170af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8",
    },
    {
      entropy: "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
      phrase:
        "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title",
      trezorSeed:
        "bc09fca1804f7e69da93c2f2028eb238c227f2e9dda30cd63699232578480a4021b146ad717fbb7e451ce9eb835f43620bf5c514db0f8add49f5d121449d3e87",
    },
    {
      entropy: "8080808080808080808080808080808080808080808080808080808080808080",
      phrase:
        "letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless",
      trezorSeed:
        "c0c519bd0e91a2ed54357d9d1ebef6f5af218a153624cf4f2da911a0ed8f7a09e2ef61af0aca007096df430022f7a2b6fb91661a9589097069720d015e4e982f",
    },
    {
      entropy: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      phrase: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote",
      trezorSeed:
        "dd48c104698c30cfe2b6142103248622fb7bb0ff692eebb00089b32d22484e1613912f0a5b694407be899ffd31ed3992c456cdf60f5d4564b8ba3f05a69890ad",
    },
  ]

  test("entropy renders the published phrase, and the phrase reads back as that entropy", () => {
    for (const vector of vectors) {
      expect(phraseFromEntropy(unhex(vector.entropy))).toBe(vector.phrase)
      expect(hex(entropyFromPhrase(vector.phrase))).toBe(vector.entropy)
    }
  })

  test("the phrase produces the published seed under the vectors' own passphrase", () => {
    // Run against "TREZOR" because that is what the published set states; this pins the PBKDF2
    // construction itself (2048 rounds, HMAC-SHA512, salt "mnemonic" + passphrase) rather than a
    // number this repository chose.
    for (const vector of vectors) {
      expect(hex(mnemonicToSeedSync(vector.phrase, "TREZOR"))).toBe(vector.trezorSeed)
    }
  })

  test("this format fixes the optional passphrase to the empty string, so a restore has one input", async () => {
    for (const vector of vectors) {
      const seed = await seedFromEntropy(unhex(vector.entropy))
      expect(hex(seed)).toBe(hex(mnemonicToSeedSync(vector.phrase, "")))
      // And it is NOT the "TREZOR" seed, which is what makes the fixed empty passphrase a real
      // choice rather than a default that happens to coincide.
      expect(hex(seed)).not.toBe(vector.trezorSeed)
    }
  })

  test("a phrase whose checksum does not match is refused, and nothing is returned", () => {
    // Last word swapped for another valid wordlist entry, which breaks the checksum only.
    const broken =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"
    expect(() => entropyFromPhrase(broken)).toThrow(VaultError)
    try {
      entropyFromPhrase(broken)
    } catch (error) {
      expect((error as VaultError).code).toBe("PHRASE_INVALID")
      // The refusal must not echo a word back: the message is what lands in a terminal and a log.
      expect((error as VaultError).message).not.toContain("abandon")
    }
  })

  test("a phrase of the wrong length is refused before the checksum is consulted", () => {
    expect(() =>
      entropyFromPhrase("legal winner thank year wave sausage worth useful legal winner thank yellow"),
    ).toThrow(/24 words/)
  })
})

describe("SLIP-0010 published Ed25519 vectors, through the in-repo derivation", () => {
  // SLIP-0010 test vector 1, seed 000102030405060708090a0b0c0d0e0f, curve "ed25519".
  const seed1 = unhex("000102030405060708090a0b0c0d0e0f")
  const vector1: Array<{ path: string; chainCode: string; key: string; publicKey: string }> = [
    {
      path: "m",
      chainCode: "90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb",
      key: "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7",
      publicKey: "00a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed",
    },
    {
      path: "m/0'",
      chainCode: "8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69",
      key: "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3",
      publicKey: "008c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c",
    },
    {
      path: "m/0'/1'",
      chainCode: "a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14",
      key: "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2",
      publicKey: "001932a5270f335bed617d5b935c80aedb1a35bd9fc1e31acafd5372c30f5c1187",
    },
    {
      path: "m/0'/1'/2'",
      chainCode: "2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c",
      key: "92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9",
      publicKey: "00ae98736566d30ed0e9d2f4486a64bc95740d89c7db33f52121f8ea8f76ff0fc1",
    },
    {
      path: "m/0'/1'/2'/2'",
      chainCode: "8f6d87f93d750e0efccda017d662a1b31a266e4a6f5993b15f5c1f07f74dd5cc",
      key: "30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662",
      publicKey: "008abae2d66361c879b900d204ad2cc4984fa2aa344dd7ddc46007329ac76c429c",
    },
    {
      path: "m/0'/1'/2'/2'/1000000000'",
      chainCode: "68789923a0cac2cd5a29172a475fe9e0fb14cd6adb5ad98a3fa70333e7afa230",
      key: "8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793",
      publicKey: "003c24da049451555d51a7014a37337aa4e12d41e485abccfa46b47dfb2af54b7a",
    },
  ]

  test("the master key and every listed hardened child match, key and chain code", () => {
    for (const entry of vector1) {
      const node =
        entry.path === "m"
          ? masterFromSeed(seed1)
          : parsePath(entry.path).reduce((current, index) => deriveChild(current, index), masterFromSeed(seed1))
      // The path is folded into the compared value so a failure names WHICH child diverged; the
      // chain code is asserted too, because it is the input to the next child and a derivation
      // that got the key right and the chain code wrong would pass at depth one and fail at two.
      expect(`${entry.path} key ${hex(node.key)}`).toBe(`${entry.path} key ${entry.key}`)
      expect(`${entry.path} chainCode ${hex(node.chainCode)}`).toBe(`${entry.path} chainCode ${entry.chainCode}`)
    }
  })

  test("the derived public key matches the vector, which is what an address is made of", () => {
    for (const entry of vector1) {
      const leaf = entry.path === "m" ? masterFromSeed(seed1).key : derivePath(seed1, entry.path)
      const { ed25519 } = require("@noble/curves/ed25519") as typeof import("@noble/curves/ed25519")
      // SLIP-0010 prefixes the Ed25519 public key with 0x00, which the vectors carry and an
      // address does not.
      expect(`00${hex(ed25519.getPublicKey(leaf))}`).toBe(entry.publicKey)
    }
  })

  test("a non-hardened index is refused, because SLIP-0010 defines no such Ed25519 child", () => {
    const master = masterFromSeed(seed1)
    expect(() => deriveChild(master, 0)).toThrow(VaultError)
    expect(() => deriveChild(master, HARDENED_OFFSET - 1)).toThrow(/no non-hardened children/)
    // And through a path string, which is how a stored `derivation.path` arrives.
    expect(() => parsePath("m/44'/501'/0'/0")).toThrow(/no non-hardened children/)
    expect(() => derivePath(seed1, "m/44'/501'/0'/0")).toThrow(VaultError)
  })

  test("a path that is not a path at all is refused rather than guessed at", () => {
    expect(() => parsePath("44'/501'")).toThrow(/Not a derivation path/)
    expect(() => parsePath("m/abc'")).toThrow(/Not a derivation path element/)
  })
})

describe("the spec-fixed paths, for fixture entropy", () => {
  // 0x00..0x1f, the fixture root. The addresses below are recorded here as the fixture's own
  // expected values: they are what the shipped derivation produces for the shipped paths, and a
  // change to either -- a path string, a padding byte, a wordlist -- moves them.
  const entropy = new Uint8Array(32).map((_, index) => index)

  test("the Solana vault branch is m/44'/501'/n'/0' and is fully hardened", async () => {
    expect(solanaVaultPath(0)).toBe("m/44'/501'/0'/0'")
    expect(solanaVaultPath(7)).toBe("m/44'/501'/7'/0'")
    const zero = await deriveSolanaKey(entropy, solanaVaultPath(0))
    const one = await deriveSolanaKey(entropy, solanaVaultPath(1))
    expect(zero.address).not.toBe(one.address)
    // The recorded address for index 0, which is the fixture's anchor.
    expect(zero.address).toBe(FIXTURE_VAULT_0)
    // A derived secret is the 64-byte layout the rest of the CLI already speaks, and its address
    // is re-derived from the seed half rather than read out of the second half.
    expect(zero.secret64.length).toBe(64)
    expect(addressFromSecret64(zero.secret64)).toBe(zero.address)
  })

  test("the TEE branch is m/44'/501'/k'/1' and never collides with the vault branch", async () => {
    expect(solanaTeePath(0)).toBe("m/44'/501'/0'/1'")
    const vault0 = await deriveSolanaKey(entropy, solanaVaultPath(0))
    const tee0 = await deriveSolanaKey(entropy, solanaTeePath(0))
    // Same account index, different change index: change `1'` is on no published scan list, which
    // is the property that keeps a remotely exposed key from showing up as an ordinary account.
    expect(tee0.address).not.toBe(vault0.address)
    expect(tee0.address).toBe(FIXTURE_TEE_0)
  })

  test("the EVM path is the Ledger Live layout, fixed now and derived by nothing in Phase 2", () => {
    expect(evmPath(0)).toBe("m/44'/60'/0'/0/0")
    expect(evmPath(3)).toBe("m/44'/60'/3'/0/0")
    // Not the MetaMask layout, which shares one hardened account across every key (AD-5).
    expect(evmPath(3)).not.toBe("m/44'/60'/0'/0/3")
  })

  test("derivation is deterministic: the same entropy and path always give the same address", async () => {
    const first = await deriveSolanaKey(entropy, solanaVaultPath(4))
    const second = await deriveSolanaKey(entropy, solanaVaultPath(4))
    expect(first.address).toBe(second.address)
  })
})

/** The fixture's index-0 addresses, recorded so a derivation change is a test failure. */
export const FIXTURE_VAULT_0 = "5Pobwp6d9ihN9Nz38f87gVCEBFMgipFiSM2VtUhVit6w"
export const FIXTURE_TEE_0 = "FKhHHGpQ52Wcf446ANQL9vmuxLjjfuKYfFpZiKRbS63J"

test("the BIP-32 secp256k1 half of T53 is recorded as Phase 4's, not silently skipped", () => {
  // Phase 2 adds no secp256k1 derivation code (ED-13), so there is nothing here to run the BIP-32
  // vectors against. The path is fixed and asserted above; the vectors run in the Phase 4 PR that
  // declares `@scure/bip32`. This assertion exists so the gap is visible in the suite's output
  // rather than being an absence nobody notices.
  expect(evmPath(0)).toBe("m/44'/60'/0'/0/0")
})
