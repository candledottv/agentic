// candle-enclave: the Secure Enclave and synced passkey helper for the Candle CLI (Ember Phase 2,
// BE-141, ED-12; BE-135 for the passkey path, AD-2).
//
// Built into candle-enclave.app by build.sh; Developer ID-signed with the hardened runtime,
// notarized and stapled by the release job (release.yaml, job "macos-helper") when
// packages/cli/release-policy.json says "signed". The CLI spawns Contents/MacOS/candle-enclave
// with a pipe on stdin and stdout, writes one JSON request line, reads one JSON response line;
// this process does that one operation and exits. It never reads a terminal, and it has no prompt
// of its own: the only thing the operator sees is the system's Touch ID sheet, whose reason string
// arrives inside the request and names the operation.
//
// The contract (operations, fields, typed codes) is packages/cli/src/enclave-helper/protocol.ts;
// the scripted helper the CLI's tests spawn implements the same contract over a file of keys, and
// the operator checklist for T48 runs the same commands against this one on a real Mac.
//
// What this helper does and does not defend (ED-12): the Enclave resists extraction of the P-256
// key; it does not stop a process running as the same user from asking this helper to unwrap,
// which is why every unwrap is behind Touch ID with the operation in the prompt. The CLI verifies
// this helper's code signature (team id and bundle id) before trusting its output; this helper
// does not check its caller, because the Bun-compiled CLI has no Apple identity to check.
//
// The passkey path (BE-135, PR G) uses AuthenticationServices on macOS 15 or later: one
// registration of a discoverable, user-verified credential under the relying party cli.candle.tv
// with the PRF extension checked for support, and one assertion per unlock with the envelope's PRF
// salt. Both need this bundle to carry the associated-domains entitlement for
// webcredentials:cli.candle.tv, an embedded provisioning profile for that entitlement, and an
// apple-app-site-association served on the domain; the helper reports the first two in `info` so
// the CLI can refuse before any ceremony (CC-12), and the system decides the third. The passkey
// sheet is the system's; this helper has no UI of its own beyond an invisible anchor window.

import AppKit
import AuthenticationServices
import CryptoKit
import Foundation
import LocalAuthentication
import Security

let protocolVersion = 1
let maxRequestBytes = 64 * 1024
let accessControlName = "biometryCurrentSet"

struct Failure: Error {
    let code: String
    let message: String
}

func writeLine(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else {
        FileHandle.standardOutput.write("{\"ok\":false,\"protocol\":1,\"code\":\"INTERNAL\",\"message\":\"could not encode the response\"}\n".data(using: .utf8)!)
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func refuse(_ code: String, _ message: String, status: Int32) -> Never {
    writeLine(["ok": false, "protocol": protocolVersion, "code": code, "message": message])
    exit(status)
}

// MARK: - What this helper is

func bundleVersion() -> String {
    return Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
}

func bundleIdentifier() -> String {
    return Bundle.main.bundleIdentifier ?? ""
}

/// This process's own code signing information, as the CLI's codesign check will see it.
func signingInformation() -> [String: Any] {
    var code: SecCode?
    guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let running = code else { return [:] }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(running, SecCSFlags(), &staticCode) == errSecSuccess, let fixed = staticCode else {
        return [:]
    }
    var info: CFDictionary?
    let flags = SecCSFlags(rawValue: kSecCSSigningInformation)
    guard SecCodeCopySigningInformation(fixed, flags, &info) == errSecSuccess,
          let dictionary = info as? [String: Any] else { return [:] }
    return dictionary
}

/// The team id from this process's own code signature.
func teamIdentifier() -> String {
    return signingInformation()[kSecCodeInfoTeamIdentifier as String] as? String ?? ""
}

/// `com.apple.developer.associated-domains` from this process's own entitlements (BE-135). An
/// unsigned build has none, and a build signed without the entitlement has none either.
func associatedDomains() -> [String] {
    guard let entitlements = signingInformation()[kSecCodeInfoEntitlementsDict as String] as? [String: Any] else {
        return []
    }
    return entitlements["com.apple.developer.associated-domains"] as? [String] ?? []
}

/// Whether the bundle embeds a provisioning profile, which the associated-domains entitlement needs
/// under Developer ID (BE-135). The release job embeds it as Contents/embedded.provisionprofile.
func provisioningProfileEmbedded() -> Bool {
    let url = Bundle.main.bundleURL.appendingPathComponent("Contents/embedded.provisionprofile")
    return FileManager.default.fileExists(atPath: url.path)
}

func osVersionString() -> String {
    let version = ProcessInfo.processInfo.operatingSystemVersion
    return "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
}

/// LocalAuthentication's `LAError` codes by their Swift case names, so the CLI and an operator
/// reading `info` see `systemCancel` rather than `-4` (BE-135).
func laErrorName(_ code: Int) -> String {
    switch code {
    case LAError.authenticationFailed.rawValue: return "authenticationFailed"
    case LAError.userCancel.rawValue: return "userCancel"
    case LAError.userFallback.rawValue: return "userFallback"
    case LAError.systemCancel.rawValue: return "systemCancel"
    case LAError.passcodeNotSet.rawValue: return "passcodeNotSet"
    case LAError.biometryNotAvailable.rawValue: return "biometryNotAvailable"
    case LAError.biometryNotEnrolled.rawValue: return "biometryNotEnrolled"
    case LAError.biometryLockout.rawValue: return "biometryLockout"
    case LAError.appCancel.rawValue: return "appCancel"
    case LAError.invalidContext.rawValue: return "invalidContext"
    case LAError.notInteractive.rawValue: return "notInteractive"
    default: return "unknown"
    }
}

func biometryTypeName(_ type: LABiometryType) -> String {
    switch type {
    case .touchID: return "touchID"
    case .faceID: return "faceID"
    case LABiometryType.none: return "none"
    default: return "opticID"
    }
}

struct Biometry {
    /// "available", "none" (not enrolled), "locked-out", "not-interactive" (no prompt can be shown
    /// from this session: SSH, a background agent, the lid closed), or "unavailable" (no sensor or
    /// anything else). See protocol.ts's BiometryState.
    let state: String
    let reason: String?
    let laError: (code: Int, name: String)?
    /// Which sensor this Mac has, whatever the state says about using it now.
    let type: String
}

/// Touch ID right now, as `canEvaluatePolicy` answers it. PR F reported every failure that was not
/// "not enrolled" as "unavailable", so a process outside the user's interactive session (which
/// gets `LAError` -4, `systemCancel`) told the operator Touch ID was unavailable on a Mac that has
/// it (BE-135). The verdict now carries the `LAError` by name and the biometry type, and the two
/// session codes are their own state.
func biometryState() -> Biometry {
    let context = LAContext()
    var error: NSError?
    let usable = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    let type = biometryTypeName(context.biometryType)
    if usable {
        return Biometry(state: "available", reason: nil, laError: nil, type: type)
    }
    guard let error = error, error.domain == LAErrorDomain else {
        return Biometry(
            state: "unavailable",
            reason: error?.localizedDescription ?? "Touch ID is not available",
            laError: nil,
            type: type
        )
    }
    let la = (code: error.code, name: laErrorName(error.code))
    switch error.code {
    case LAError.biometryNotEnrolled.rawValue:
        return Biometry(state: "none", reason: error.localizedDescription, laError: la, type: type)
    case LAError.biometryLockout.rawValue:
        return Biometry(state: "locked-out", reason: error.localizedDescription, laError: la, type: type)
    case LAError.systemCancel.rawValue, LAError.notInteractive.rawValue:
        return Biometry(state: "not-interactive", reason: error.localizedDescription, laError: la, type: type)
    default:
        return Biometry(state: "unavailable", reason: error.localizedDescription, laError: la, type: type)
    }
}

// MARK: - Error translation (the helper's typed codes; the CLI maps them to the vault's)

func failure(fromStatus status: OSStatus, fallback: String) -> Failure {
    let description = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
    let message = "OSStatus \(status): \(description)"
    switch status {
    case errSecUserCanceled: return Failure(code: "CANCELLED", message: message)
    case errSecAuthFailed: return Failure(code: "AUTH_FAILED", message: message)
    case errSecItemNotFound: return Failure(code: "KEY_NOT_FOUND", message: message)
    case errSecInteractionNotAllowed: return Failure(code: "LOCKED", message: message)
    case errSecDuplicateItem: return Failure(code: "KEY_EXISTS", message: message)
    default: return Failure(code: fallback, message: message)
    }
}

func failure(fromNSError nsError: NSError, fallback: String) -> Failure {
    // LocalAuthentication's verdict is the most specific one, and it is often wrapped inside a
    // Security framework error, so the underlying error is inspected first.
    if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? NSError, underlying !== nsError {
        let inner = failure(fromNSError: underlying, fallback: fallback)
        if inner.code != fallback { return inner }
    }
    let message = "\(nsError.domain) \(nsError.code): \(nsError.localizedDescription)"
    if nsError.domain == LAErrorDomain {
        switch nsError.code {
        case LAError.userCancel.rawValue, LAError.appCancel.rawValue:
            return Failure(code: "CANCELLED", message: message)
        case LAError.systemCancel.rawValue, LAError.notInteractive.rawValue:
            // The system, not the operator, ended it: no prompt can be shown from this session.
            return Failure(code: "NOT_INTERACTIVE", message: "\(message) (LAError \(laErrorName(nsError.code)))")
        case LAError.authenticationFailed.rawValue:
            return Failure(code: "AUTH_FAILED", message: message)
        case LAError.biometryLockout.rawValue:
            return Failure(code: "LOCKED", message: message)
        case LAError.biometryNotAvailable.rawValue, LAError.biometryNotEnrolled.rawValue, LAError.passcodeNotSet.rawValue:
            return Failure(code: "BIOMETRY_UNAVAILABLE", message: message)
        default:
            return Failure(code: fallback, message: message)
        }
    }
    if nsError.domain == NSOSStatusErrorDomain {
        return failure(fromStatus: OSStatus(nsError.code), fallback: fallback)
    }
    return Failure(code: fallback, message: message)
}

func failure(from error: Unmanaged<CFError>?, fallback: String) -> Failure {
    guard let cfError = error?.takeRetainedValue() else {
        return Failure(code: fallback, message: "the Security framework reported no error detail")
    }
    return failure(fromNSError: cfError as Error as NSError, fallback: fallback)
}

// MARK: - The Enclave

func findKey(tag: Data, context: LAContext?) throws -> SecKey? {
    var query: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrApplicationTag as String: tag,
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecUseDataProtectionKeychain as String: true,
        kSecReturnRef as String: true,
    ]
    if let context = context {
        query[kSecUseAuthenticationContext as String] = context
    }
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let found = item else {
        throw failure(fromStatus: status, fallback: "KEYCHAIN_IO")
    }
    return (found as! SecKey)
}

func publicPoint(of privateKey: SecKey) throws -> Data {
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
        throw Failure(code: "INTERNAL", message: "could not read the key's public half")
    }
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
        throw failure(from: error, fallback: "INTERNAL")
    }
    return data
}

func createKey(tag: Data, label: String) throws -> Data {
    guard SecureEnclave.isAvailable else {
        throw Failure(code: "NO_ENCLAVE", message: "this Mac has no Secure Enclave")
    }
    let biometry = biometryState()
    guard biometry.state == "available" else {
        let code: String
        switch biometry.state {
        case "not-interactive": code = "NOT_INTERACTIVE"
        case "locked-out": code = "LOCKED"
        default: code = "BIOMETRY_UNAVAILABLE"
        }
        let detail = biometry.laError.map { " (LAError \($0.name))" } ?? ""
        throw Failure(code: code, message: (biometry.reason ?? "Touch ID is not available right now") + detail)
    }
    if try findKey(tag: tag, context: nil) != nil {
        throw Failure(code: "KEY_EXISTS", message: "a Secure Enclave key with this tag already exists on this Mac")
    }
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.privateKeyUsage, .biometryCurrentSet],
        &error
    ) else {
        throw failure(from: error, fallback: "INTERNAL")
    }
    let attributes: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecUseDataProtectionKeychain as String: true,
        kSecPrivateKeyAttrs as String: [
            kSecAttrIsPermanent as String: true,
            kSecAttrApplicationTag as String: tag,
            kSecAttrAccessControl as String: access,
            kSecAttrLabel as String: label,
        ],
    ]
    guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
        throw failure(from: error, fallback: "KEYCHAIN_IO")
    }
    return try publicPoint(of: privateKey)
}

func decrypt(tag: Data, expectedPublicKey: Data, ciphertext: Data, reason: String) throws -> Data {
    let context = LAContext()
    context.localizedReason = reason
    guard let key = try findKey(tag: tag, context: context) else {
        throw Failure(
            code: "KEY_NOT_FOUND",
            message: "no Secure Enclave key with this tag on this Mac; an Enclave key never leaves the Mac that created it"
        )
    }
    let point = try publicPoint(of: key)
    guard point == expectedPublicKey else {
        throw Failure(
            code: "KEY_NOT_FOUND",
            message: "the Secure Enclave key with this tag has a different public key than the envelope records"
        )
    }
    var error: Unmanaged<CFError>?
    guard let plaintext = SecKeyCreateDecryptedData(
        key,
        .eciesEncryptionCofactorVariableIVX963SHA256AESGCM,
        ciphertext as CFData,
        &error
    ) as Data? else {
        throw failure(from: error, fallback: "DECRYPT_FAILED")
    }
    return plaintext
}

func deleteKey(tag: Data) throws -> Bool {
    let query: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrApplicationTag as String: tag,
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecUseDataProtectionKeychain as String: true,
    ]
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecSuccess { return true }
    if status == errSecItemNotFound { return false }
    throw failure(fromStatus: status, fallback: "KEYCHAIN_IO")
}

// MARK: - The synced passkey (BE-135, AD-2, macOS 15 or later)

let passkeyRelyingParty = "cli.candle.tv"
/// Past this the CLI has already terminated the helper (its own timeout is 120 s); this is the
/// helper's own bound so a sheet nobody answers never leaves a process spinning.
let passkeyCeremonyTimeout: TimeInterval = 115

/// Runs one ASAuthorizationController request to completion on the main run loop. The system's
/// passkey sheet is out of process; this process only needs an anchor window (invisible, one
/// pixel) and a turning run loop to receive the result.
@available(macOS 15.0, *)
final class PasskeyCeremony: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding
{
    private var outcome: Result<ASAuthorization, Error>?
    private var anchor: NSWindow?

    func run(_ request: ASAuthorizationRequest) throws -> ASAuthorization {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.finishLaunching()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.makeKeyAndOrderFront(nil)
        anchor = window
        app.activate(ignoringOtherApps: true)

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        controller.performRequests()

        let deadline = Date(timeIntervalSinceNow: passkeyCeremonyTimeout)
        while outcome == nil, Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
        }
        window.close()
        anchor = nil
        guard let result = outcome else {
            throw Failure(code: "CANCELLED", message: "the passkey sheet was not answered in time")
        }
        return try result.get()
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return anchor ?? NSWindow()
    }

    func authorizationController(
        controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        outcome = .success(authorization)
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        outcome = .failure(error)
    }
}

/// AuthenticationServices' verdict into the helper's typed codes. `ASAuthorizationError.failed`
/// carries the domain association failure ("application ... is not associated with domain") and
/// the no-credential case in its description; both are named here rather than left as INTERNAL,
/// and T57 records what the real framework says for each.
@available(macOS 15.0, *)
func passkeyFailure(_ error: Error) -> Failure {
    let nsError = error as NSError
    if let failure = error as? Failure { return failure }
    let message = "\(nsError.domain) \(nsError.code): \(nsError.localizedDescription)"
    let text = nsError.localizedDescription.lowercased()
    if nsError.domain == ASAuthorizationError.errorDomain {
        switch nsError.code {
        case ASAuthorizationError.canceled.rawValue:
            return Failure(code: "CANCELLED", message: message)
        case ASAuthorizationError.notInteractive.rawValue:
            return Failure(code: "NOT_INTERACTIVE", message: message)
        case ASAuthorizationError.matchedExcludedCredential.rawValue:
            return Failure(code: "KEY_EXISTS", message: message)
        default:
            break
        }
    }
    if text.contains("not associated") || text.contains("associated domain") || text.contains("apple-app-site-association") {
        return Failure(code: "DOMAIN_NOT_ASSOCIATED", message: message)
    }
    if text.contains("no credentials") || text.contains("no passkey") {
        return Failure(code: "NO_CREDENTIAL", message: message)
    }
    if nsError.domain == LAErrorDomain {
        return failure(fromNSError: nsError, fallback: "AUTH_FAILED")
    }
    return Failure(code: "INTERNAL", message: message)
}

@available(macOS 15.0, *)
func passkeyRegister(rpId: String, userId: Data, userName: String, clientDataHash: Data) throws -> [String: Any] {
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
    // The operation digest is the challenge: the platform builds the client data around it, so the
    // ceremony is bound to this request the way candle-fido2's clientDataHash binds its own.
    let request = provider.createCredentialRegistrationRequest(challenge: clientDataHash, name: userName, userID: userId)
    request.userVerificationPreference = .required
    request.prf = .checkForSupport
    let authorization: ASAuthorization
    do {
        authorization = try PasskeyCeremony().run(request)
    } catch {
        throw passkeyFailure(error)
    }
    guard let registration = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
        throw Failure(code: "INTERNAL", message: "the platform authenticator answered with an unexpected credential type")
    }
    guard let attestation = registration.rawAttestationObject else {
        throw Failure(code: "INTERNAL", message: "the registration carried no attestation object")
    }
    return [
        "credentialId": registration.credentialID.base64EncodedString(),
        "attestationObject": attestation.base64EncodedString(),
        "prfSupported": registration.prf?.isSupported ?? false,
    ]
}

@available(macOS 15.0, *)
func passkeyAssert(rpId: String, credentialId: Data, clientDataHash: Data, prfSalt: Data) throws -> [String: Any] {
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
    let request = provider.createCredentialAssertionRequest(challenge: clientDataHash)
    request.userVerificationPreference = .required
    request.allowedCredentials = [ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: credentialId)]
    // The raw 32-byte salt from the envelope; the platform applies its own derivation
    // (saltDerivation: "platform"), and T57 records how that compares with a browser's.
    // The assertion input is an enum in the Swift overlay, not a constructible class.
    request.prf = .inputValues(.init(saltInput1: prfSalt, saltInput2: nil))
    let authorization: ASAuthorization
    do {
        authorization = try PasskeyCeremony().run(request)
    } catch {
        throw passkeyFailure(error)
    }
    guard let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
        throw Failure(code: "INTERNAL", message: "the platform authenticator answered with an unexpected credential type")
    }
    guard let first = assertion.prf?.first else {
        throw Failure(code: "PRF_UNSUPPORTED", message: "the assertion returned no PRF output for this credential")
    }
    // The helper's own UV check (CC-03); the CLI re-checks the same flag before deriving anything.
    // rawAuthenticatorData is optional; a missing value is the same AUTH_FAILED refusal as a clear UV flag.
    guard let authData = assertion.rawAuthenticatorData, authData.count >= 37,
          (authData[authData.startIndex + 32] & 0x04) != 0 else {
        throw Failure(code: "AUTH_FAILED", message: "the assertion was made without user verification (the UV flag is clear)")
    }
    let prfOutput = first.withUnsafeBytes { Data($0) }
    return [
        "authenticatorData": authData.base64EncodedString(),
        "prfOutput": prfOutput.base64EncodedString(),
    ]
}

// MARK: - The request

func requiredString(_ object: [String: Any], _ field: String) throws -> String {
    guard let value = object[field] as? String, !value.isEmpty else {
        throw Failure(code: "BAD_REQUEST", message: "\(field) is missing or empty")
    }
    return value
}

func base64Field(_ object: [String: Any], _ field: String, expected: Int? = nil) throws -> Data {
    let text = try requiredString(object, field)
    guard let data = Data(base64Encoded: text) else {
        throw Failure(code: "BAD_REQUEST", message: "\(field) is not base64")
    }
    if let expected = expected, data.count != expected {
        throw Failure(code: "BAD_REQUEST", message: "\(field) is \(data.count) bytes, expected \(expected)")
    }
    return data
}

func handle(_ request: [String: Any]) throws -> [String: Any] {
    let op = try requiredString(request, "op")
    _ = try requiredString(request, "vaultId")
    _ = try requiredString(request, "envelopeId")
    _ = try base64Field(request, "digest", expected: 32)
    switch op {
    case "info":
        let biometry = biometryState()
        var response: [String: Any] = [
            "ok": true,
            "protocol": protocolVersion,
            "op": "info",
            "version": bundleVersion(),
            "bundleId": bundleIdentifier(),
            "teamId": teamIdentifier(),
            "secureEnclave": SecureEnclave.isAvailable,
            "biometry": biometry.state,
            "biometryType": biometry.type,
            "osVersion": osVersionString(),
            "associatedDomains": associatedDomains(),
            "provisioningProfile": provisioningProfileEmbedded(),
        ]
        if let reason = biometry.reason { response["biometryReason"] = reason }
        if let la = biometry.laError { response["laError"] = ["code": la.code, "name": la.name] }
        return response
    case "create":
        let tag = try requiredString(request, "keyTag")
        let label = try requiredString(request, "label")
        let accessControl = try requiredString(request, "accessControl")
        guard accessControl == accessControlName else {
            throw Failure(code: "BAD_REQUEST", message: "accessControl must be \(accessControlName); this helper enrols no other access control")
        }
        let point = try createKey(tag: tag.data(using: .utf8)!, label: label)
        return ["ok": true, "protocol": protocolVersion, "op": "create", "publicKey": point.base64EncodedString()]
    case "decrypt":
        let tag = try requiredString(request, "keyTag")
        let publicKey = try base64Field(request, "publicKey", expected: 65)
        let ciphertext = try base64Field(request, "ciphertext")
        let reason = try requiredString(request, "reason")
        let plaintext = try decrypt(tag: tag.data(using: .utf8)!, expectedPublicKey: publicKey, ciphertext: ciphertext, reason: reason)
        return ["ok": true, "protocol": protocolVersion, "op": "decrypt", "plaintext": plaintext.base64EncodedString()]
    case "delete":
        let tag = try requiredString(request, "keyTag")
        let removed = try deleteKey(tag: tag.data(using: .utf8)!)
        return ["ok": true, "protocol": protocolVersion, "op": "delete", "removed": removed]
    case "passkey-register", "passkey-assert":
        let rpId = try requiredString(request, "rpId")
        guard rpId == passkeyRelyingParty else {
            throw Failure(code: "BAD_REQUEST", message: "rpId must be \(passkeyRelyingParty); this helper serves no other relying party")
        }
        let clientDataHash = try base64Field(request, "clientDataHash", expected: 32)
        guard #available(macOS 15.0, *) else {
            throw Failure(
                code: "PASSKEY_UNSUPPORTED",
                message: "the platform passkey API needs macOS 15 or later; this Mac runs \(osVersionString())"
            )
        }
        if op == "passkey-register" {
            let userId = try base64Field(request, "userId")
            let userName = try requiredString(request, "userName")
            var response = try passkeyRegister(rpId: rpId, userId: userId, userName: userName, clientDataHash: clientDataHash)
            response["ok"] = true
            response["protocol"] = protocolVersion
            response["op"] = "passkey-register"
            return response
        }
        let credentialId = try base64Field(request, "credentialId")
        let prfSalt = try base64Field(request, "prfSalt", expected: 32)
        var response = try passkeyAssert(rpId: rpId, credentialId: credentialId, clientDataHash: clientDataHash, prfSalt: prfSalt)
        response["ok"] = true
        response["protocol"] = protocolVersion
        response["op"] = "passkey-assert"
        return response
    default:
        throw Failure(
            code: "BAD_REQUEST",
            message: "unknown op \(op); this helper knows info, create, decrypt, delete, passkey-register and passkey-assert"
        )
    }
}

// MARK: - Entry

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.contains("--version") {
    print("candle-enclave \(bundleVersion()) (protocol \(protocolVersion))")
    exit(0)
}
if isatty(STDIN_FILENO) != 0 {
    refuse(
        "BAD_REQUEST",
        "candle-enclave reads exactly one JSON request from a piped stdin and never from a terminal; it is run by the candle CLI, not by hand",
        status: 2
    )
}
guard let line = readLine(strippingNewline: true), !line.trimmingCharacters(in: .whitespaces).isEmpty else {
    refuse("BAD_REQUEST", "expected one JSON request line on stdin (at most \(maxRequestBytes) bytes)", status: 2)
}
guard line.utf8.count <= maxRequestBytes else {
    refuse("BAD_REQUEST", "expected one JSON request line on stdin (at most \(maxRequestBytes) bytes)", status: 2)
}
guard let raw = try? JSONSerialization.jsonObject(with: line.data(using: .utf8)!, options: []),
      let request = raw as? [String: Any] else {
    refuse("BAD_REQUEST", "the request is not a JSON object", status: 1)
}
do {
    writeLine(try handle(request))
    exit(0)
} catch let failure as Failure {
    refuse(failure.code, failure.message, status: 1)
} catch {
    refuse("INTERNAL", "\(error)", status: 1)
}
