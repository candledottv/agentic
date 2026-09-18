// candle-enclave: the Secure Enclave helper for the Candle CLI (Ember Phase 2, BE-141, ED-12).
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

/// The team id from this process's own code signature, as the CLI's codesign check will see it.
func teamIdentifier() -> String {
    var code: SecCode?
    guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let running = code else { return "" }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(running, SecCSFlags(), &staticCode) == errSecSuccess, let fixed = staticCode else {
        return ""
    }
    var info: CFDictionary?
    let flags = SecCSFlags(rawValue: kSecCSSigningInformation)
    guard SecCodeCopySigningInformation(fixed, flags, &info) == errSecSuccess,
          let dictionary = info as? [String: Any] else { return "" }
    return dictionary[kSecCodeInfoTeamIdentifier as String] as? String ?? ""
}

/// Touch ID right now: "available", "unavailable" (lid closed, no sensor, locked out), or "none" (not enrolled).
func biometryState() -> (state: String, reason: String?) {
    let context = LAContext()
    var error: NSError?
    if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
        return ("available", nil)
    }
    if let error = error, error.domain == LAErrorDomain, error.code == LAError.biometryNotEnrolled.rawValue {
        return ("none", error.localizedDescription)
    }
    return ("unavailable", error?.localizedDescription ?? "Touch ID is not available")
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
        case LAError.userCancel.rawValue, LAError.systemCancel.rawValue, LAError.appCancel.rawValue:
            return Failure(code: "CANCELLED", message: message)
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
        throw Failure(code: "BIOMETRY_UNAVAILABLE", message: biometry.reason ?? "Touch ID is not available right now")
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
        ]
        if let reason = biometry.reason { response["biometryReason"] = reason }
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
    default:
        throw Failure(code: "BAD_REQUEST", message: "unknown op \(op); this helper knows info, create, decrypt and delete")
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
