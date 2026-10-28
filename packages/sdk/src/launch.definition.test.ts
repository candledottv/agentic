import { expect, test } from "bun:test"
import type { LaunchRequest } from "./client"
import { type GeneratedLaunchFields, LAUNCH_DEFINITION } from "./launch-definition"

// SDK controls are intentionally explicit: dryRun is a method, wallet also accepts linked ids,
// and buyAmount is a deprecated SDK-only input for one release.
type ExpectedKeys = Exclude<keyof GeneratedLaunchFields, "dryRun"> | "buyAmount"
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const keysMatch: Equal<keyof LaunchRequest, ExpectedKeys> = true
const requestKeys = {
  wallet: true,
  clientLaunchId: true,
  name: true,
  symbol: true,
  imageUrl: true,
  bannerUrl: true,
  description: true,
  socials: true,
  chain: true,
  quoteAsset: true,
  mode: true,
  curve: true,
  creatorFeeBps: true,
  stakerAllocationBps: true,
  poolFee: true,
  poolOpen: true,
  expPoolShape: true,
  dexVersion: true,
  visibility: true,
  buy: true,
  buyAmount: true,
} satisfies Record<keyof LaunchRequest, true>

test("SDK launch keys equal the definition plus the named SDK-only input", () => {
  expect(keysMatch).toBe(true)
  const sharedKeys = LAUNCH_DEFINITION.fields.map((field) => field.surfaces.sdk.key.split(".")[0] as string)
  expect(Object.keys(requestKeys).sort()).toEqual(
    [...new Set([...sharedKeys.filter((key) => key !== "dryRun"), "buyAmount"])].sort(),
  )
})
