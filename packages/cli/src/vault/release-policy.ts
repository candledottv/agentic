/**
 * Ember Phase 2 (BE-141): the checked-in release policy, read once from
 * `packages/cli/release-policy.json`, the one file that decides whether a release ships the
 * signed Secure Enclave helper. The release job reads the same file with jq; this module is the
 * CLI's read of it, parsed strictly so a malformed edit fails the build's tests rather than
 * silently selecting a state. Kept apart from `enclave.ts` so the tests can inject a policy
 * through `Deps` without touching the file.
 */
import policyJson from "../../release-policy.json"
import { parseReleasePolicy, type ReleasePolicy } from "./enclave"

export const RELEASE_POLICY: ReleasePolicy = parseReleasePolicy(policyJson)
