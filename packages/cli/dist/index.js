#!/usr/bin/env node
import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// ../../node_modules/@sigstore/protobuf-specs/dist/__generated__/envelope.js
var require_envelope = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.Signature = exports.Envelope = undefined;
  exports.Envelope = {
    fromJSON(object) {
      return {
        payload: isSet(object.payload) ? Buffer.from(bytesFromBase64(object.payload)) : Buffer.alloc(0),
        payloadType: isSet(object.payloadType) ? globalThis.String(object.payloadType) : "",
        signatures: globalThis.Array.isArray(object?.signatures) ? object.signatures.map((e) => exports.Signature.fromJSON(e)) : []
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.payload.length !== 0) {
        obj.payload = base64FromBytes(message.payload);
      }
      if (message.payloadType !== "") {
        obj.payloadType = message.payloadType;
      }
      if (message.signatures?.length) {
        obj.signatures = message.signatures.map((e) => exports.Signature.toJSON(e));
      }
      return obj;
    }
  };
  exports.Signature = {
    fromJSON(object) {
      return {
        sig: isSet(object.sig) ? Buffer.from(bytesFromBase64(object.sig)) : Buffer.alloc(0),
        keyid: isSet(object.keyid) ? globalThis.String(object.keyid) : ""
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.sig.length !== 0) {
        obj.sig = base64FromBytes(message.sig);
      }
      if (message.keyid !== "") {
        obj.keyid = message.keyid;
      }
      return obj;
    }
  };
  function bytesFromBase64(b64) {
    return Uint8Array.from(globalThis.Buffer.from(b64, "base64"));
  }
  function base64FromBytes(arr) {
    return globalThis.Buffer.from(arr).toString("base64");
  }
  function isSet(value) {
    return value !== null && value !== undefined;
  }
});

// ../../node_modules/@sigstore/protobuf-specs/dist/__generated__/google/protobuf/timestamp.js
var require_timestamp = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.Timestamp = undefined;
  exports.Timestamp = {
    fromJSON(object) {
      return {
        seconds: isSet(object.seconds) ? globalThis.String(object.seconds) : "0",
        nanos: isSet(object.nanos) ? globalThis.Number(object.nanos) : 0
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.seconds !== "0") {
        obj.seconds = message.seconds;
      }
      if (message.nanos !== 0) {
        obj.nanos = Math.round(message.nanos);
      }
      return obj;
    }
  };
  function isSet(value) {
    return value !== null && value !== undefined;
  }
});

// ../../node_modules/@sigstore/protobuf-specs/dist/__generated__/sigstore_common.js
var require_sigstore_common = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.TimeRange = exports.X509CertificateChain = exports.SubjectAlternativeName = exports.X509Certificate = exports.DistinguishedName = exports.ObjectIdentifierValuePair = exports.ObjectIdentifier = exports.PublicKeyIdentifier = exports.PublicKey = exports.RFC3161SignedTimestamp = exports.LogId = exports.MessageSignature = exports.HashOutput = exports.SubjectAlternativeNameType = exports.PublicKeyDetails = exports.HashAlgorithm = undefined;
  exports.hashAlgorithmFromJSON = hashAlgorithmFromJSON;
  exports.hashAlgorithmToJSON = hashAlgorithmToJSON;
  exports.publicKeyDetailsFromJSON = publicKeyDetailsFromJSON;
  exports.publicKeyDetailsToJSON = publicKeyDetailsToJSON;
  exports.subjectAlternativeNameTypeFromJSON = subjectAlternativeNameTypeFromJSON;
  exports.subjectAlternativeNameTypeToJSON = subjectAlternativeNameTypeToJSON;
  var timestamp_1 = require_timestamp();
  var HashAlgorithm;
  (function(HashAlgorithm2) {
    HashAlgorithm2[HashAlgorithm2["HASH_ALGORITHM_UNSPECIFIED"] = 0] = "HASH_ALGORITHM_UNSPECIFIED";
    HashAlgorithm2[HashAlgorithm2["SHA2_256"] = 1] = "SHA2_256";
    HashAlgorithm2[HashAlgorithm2["SHA2_384"] = 2] = "SHA2_384";
    HashAlgorithm2[HashAlgorithm2["SHA2_512"] = 3] = "SHA2_512";
    HashAlgorithm2[HashAlgorithm2["SHA3_256"] = 4] = "SHA3_256";
    HashAlgorithm2[HashAlgorithm2["SHA3_384"] = 5] = "SHA3_384";
  })(HashAlgorithm || (exports.HashAlgorithm = HashAlgorithm = {}));
  function hashAlgorithmFromJSON(object) {
    switch (object) {
      case 0:
      case "HASH_ALGORITHM_UNSPECIFIED":
        return HashAlgorithm.HASH_ALGORITHM_UNSPECIFIED;
      case 1:
      case "SHA2_256":
        return HashAlgorithm.SHA2_256;
      case 2:
      case "SHA2_384":
        return HashAlgorithm.SHA2_384;
      case 3:
      case "SHA2_512":
        return HashAlgorithm.SHA2_512;
      case 4:
      case "SHA3_256":
        return HashAlgorithm.SHA3_256;
      case 5:
      case "SHA3_384":
        return HashAlgorithm.SHA3_384;
      default:
        throw new globalThis.Error("Unrecognized enum value " + object + " for enum HashAlgorithm");
    }
  }
  function hashAlgorithmToJSON(object) {
    switch (object) {
      case HashAlgorithm.HASH_ALGORITHM_UNSPECIFIED:
        return "HASH_ALGORITHM_UNSPECIFIED";
      case HashAlgorithm.SHA2_256:
        return "SHA2_256";
      case HashAlgorithm.SHA2_384:
        return "SHA2_384";
      case HashAlgorithm.SHA2_512:
        return "SHA2_512";
      case HashAlgorithm.SHA3_256:
        return "SHA3_256";
      case HashAlgorithm.SHA3_384:
        return "SHA3_384";
      default:
        throw new globalThis.Error("Unrecognized enum value " + object + " for enum HashAlgorithm");
    }
  }
  var PublicKeyDetails;
  (function(PublicKeyDetails2) {
    PublicKeyDetails2[PublicKeyDetails2["PUBLIC_KEY_DETAILS_UNSPECIFIED"] = 0] = "PUBLIC_KEY_DETAILS_UNSPECIFIED";
    PublicKeyDetails2[PublicKeyDetails2["PKCS1_RSA_PKCS1V5"] = 1] = "PKCS1_RSA_PKCS1V5";
    PublicKeyDetails2[PublicKeyDetails2["PKCS1_RSA_PSS"] = 2] = "PKCS1_RSA_PSS";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_RSA_PKCS1V5"] = 3] = "PKIX_RSA_PKCS1V5";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_RSA_PSS"] = 4] = "PKIX_RSA_PSS";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_RSA_PKCS1V15_2048_SHA256"] = 9] = "PKIX_RSA_PKCS1V15_2048_SHA256";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_RSA_PKCS1V15_3072_SHA256"] = 10] = "PKIX_RSA_PKCS1V15_3072_SHA256";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_RSA_PKCS1V15_4096_SHA256"] = 11] = "PKIX_RSA_PKCS1V15_4096_SHA256";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_RSA_PSS_2048_SHA256"] = 16] = "PKIX_RSA_PSS_2048_SHA256";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_RSA_PSS_3072_SHA256"] = 17] = "PKIX_RSA_PSS_3072_SHA256";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_RSA_PSS_4096_SHA256"] = 18] = "PKIX_RSA_PSS_4096_SHA256";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_ECDSA_P256_HMAC_SHA_256"] = 6] = "PKIX_ECDSA_P256_HMAC_SHA_256";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_ECDSA_P256_SHA_256"] = 5] = "PKIX_ECDSA_P256_SHA_256";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_ECDSA_P384_SHA_384"] = 12] = "PKIX_ECDSA_P384_SHA_384";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_ECDSA_P521_SHA_512"] = 13] = "PKIX_ECDSA_P521_SHA_512";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_ED25519"] = 7] = "PKIX_ED25519";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_ED25519_PH"] = 8] = "PKIX_ED25519_PH";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_ECDSA_P384_SHA_256"] = 19] = "PKIX_ECDSA_P384_SHA_256";
    PublicKeyDetails2[PublicKeyDetails2["PKIX_ECDSA_P521_SHA_256"] = 20] = "PKIX_ECDSA_P521_SHA_256";
    PublicKeyDetails2[PublicKeyDetails2["LMS_SHA256"] = 14] = "LMS_SHA256";
    PublicKeyDetails2[PublicKeyDetails2["LMOTS_SHA256"] = 15] = "LMOTS_SHA256";
    PublicKeyDetails2[PublicKeyDetails2["ML_DSA_44"] = 23] = "ML_DSA_44";
    PublicKeyDetails2[PublicKeyDetails2["ML_DSA_65"] = 21] = "ML_DSA_65";
    PublicKeyDetails2[PublicKeyDetails2["ML_DSA_87"] = 22] = "ML_DSA_87";
  })(PublicKeyDetails || (exports.PublicKeyDetails = PublicKeyDetails = {}));
  function publicKeyDetailsFromJSON(object) {
    switch (object) {
      case 0:
      case "PUBLIC_KEY_DETAILS_UNSPECIFIED":
        return PublicKeyDetails.PUBLIC_KEY_DETAILS_UNSPECIFIED;
      case 1:
      case "PKCS1_RSA_PKCS1V5":
        return PublicKeyDetails.PKCS1_RSA_PKCS1V5;
      case 2:
      case "PKCS1_RSA_PSS":
        return PublicKeyDetails.PKCS1_RSA_PSS;
      case 3:
      case "PKIX_RSA_PKCS1V5":
        return PublicKeyDetails.PKIX_RSA_PKCS1V5;
      case 4:
      case "PKIX_RSA_PSS":
        return PublicKeyDetails.PKIX_RSA_PSS;
      case 9:
      case "PKIX_RSA_PKCS1V15_2048_SHA256":
        return PublicKeyDetails.PKIX_RSA_PKCS1V15_2048_SHA256;
      case 10:
      case "PKIX_RSA_PKCS1V15_3072_SHA256":
        return PublicKeyDetails.PKIX_RSA_PKCS1V15_3072_SHA256;
      case 11:
      case "PKIX_RSA_PKCS1V15_4096_SHA256":
        return PublicKeyDetails.PKIX_RSA_PKCS1V15_4096_SHA256;
      case 16:
      case "PKIX_RSA_PSS_2048_SHA256":
        return PublicKeyDetails.PKIX_RSA_PSS_2048_SHA256;
      case 17:
      case "PKIX_RSA_PSS_3072_SHA256":
        return PublicKeyDetails.PKIX_RSA_PSS_3072_SHA256;
      case 18:
      case "PKIX_RSA_PSS_4096_SHA256":
        return PublicKeyDetails.PKIX_RSA_PSS_4096_SHA256;
      case 6:
      case "PKIX_ECDSA_P256_HMAC_SHA_256":
        return PublicKeyDetails.PKIX_ECDSA_P256_HMAC_SHA_256;
      case 5:
      case "PKIX_ECDSA_P256_SHA_256":
        return PublicKeyDetails.PKIX_ECDSA_P256_SHA_256;
      case 12:
      case "PKIX_ECDSA_P384_SHA_384":
        return PublicKeyDetails.PKIX_ECDSA_P384_SHA_384;
      case 13:
      case "PKIX_ECDSA_P521_SHA_512":
        return PublicKeyDetails.PKIX_ECDSA_P521_SHA_512;
      case 7:
      case "PKIX_ED25519":
        return PublicKeyDetails.PKIX_ED25519;
      case 8:
      case "PKIX_ED25519_PH":
        return PublicKeyDetails.PKIX_ED25519_PH;
      case 19:
      case "PKIX_ECDSA_P384_SHA_256":
        return PublicKeyDetails.PKIX_ECDSA_P384_SHA_256;
      case 20:
      case "PKIX_ECDSA_P521_SHA_256":
        return PublicKeyDetails.PKIX_ECDSA_P521_SHA_256;
      case 14:
      case "LMS_SHA256":
        return PublicKeyDetails.LMS_SHA256;
      case 15:
      case "LMOTS_SHA256":
        return PublicKeyDetails.LMOTS_SHA256;
      case 23:
      case "ML_DSA_44":
        return PublicKeyDetails.ML_DSA_44;
      case 21:
      case "ML_DSA_65":
        return PublicKeyDetails.ML_DSA_65;
      case 22:
      case "ML_DSA_87":
        return PublicKeyDetails.ML_DSA_87;
      default:
        throw new globalThis.Error("Unrecognized enum value " + object + " for enum PublicKeyDetails");
    }
  }
  function publicKeyDetailsToJSON(object) {
    switch (object) {
      case PublicKeyDetails.PUBLIC_KEY_DETAILS_UNSPECIFIED:
        return "PUBLIC_KEY_DETAILS_UNSPECIFIED";
      case PublicKeyDetails.PKCS1_RSA_PKCS1V5:
        return "PKCS1_RSA_PKCS1V5";
      case PublicKeyDetails.PKCS1_RSA_PSS:
        return "PKCS1_RSA_PSS";
      case PublicKeyDetails.PKIX_RSA_PKCS1V5:
        return "PKIX_RSA_PKCS1V5";
      case PublicKeyDetails.PKIX_RSA_PSS:
        return "PKIX_RSA_PSS";
      case PublicKeyDetails.PKIX_RSA_PKCS1V15_2048_SHA256:
        return "PKIX_RSA_PKCS1V15_2048_SHA256";
      case PublicKeyDetails.PKIX_RSA_PKCS1V15_3072_SHA256:
        return "PKIX_RSA_PKCS1V15_3072_SHA256";
      case PublicKeyDetails.PKIX_RSA_PKCS1V15_4096_SHA256:
        return "PKIX_RSA_PKCS1V15_4096_SHA256";
      case PublicKeyDetails.PKIX_RSA_PSS_2048_SHA256:
        return "PKIX_RSA_PSS_2048_SHA256";
      case PublicKeyDetails.PKIX_RSA_PSS_3072_SHA256:
        return "PKIX_RSA_PSS_3072_SHA256";
      case PublicKeyDetails.PKIX_RSA_PSS_4096_SHA256:
        return "PKIX_RSA_PSS_4096_SHA256";
      case PublicKeyDetails.PKIX_ECDSA_P256_HMAC_SHA_256:
        return "PKIX_ECDSA_P256_HMAC_SHA_256";
      case PublicKeyDetails.PKIX_ECDSA_P256_SHA_256:
        return "PKIX_ECDSA_P256_SHA_256";
      case PublicKeyDetails.PKIX_ECDSA_P384_SHA_384:
        return "PKIX_ECDSA_P384_SHA_384";
      case PublicKeyDetails.PKIX_ECDSA_P521_SHA_512:
        return "PKIX_ECDSA_P521_SHA_512";
      case PublicKeyDetails.PKIX_ED25519:
        return "PKIX_ED25519";
      case PublicKeyDetails.PKIX_ED25519_PH:
        return "PKIX_ED25519_PH";
      case PublicKeyDetails.PKIX_ECDSA_P384_SHA_256:
        return "PKIX_ECDSA_P384_SHA_256";
      case PublicKeyDetails.PKIX_ECDSA_P521_SHA_256:
        return "PKIX_ECDSA_P521_SHA_256";
      case PublicKeyDetails.LMS_SHA256:
        return "LMS_SHA256";
      case PublicKeyDetails.LMOTS_SHA256:
        return "LMOTS_SHA256";
      case PublicKeyDetails.ML_DSA_44:
        return "ML_DSA_44";
      case PublicKeyDetails.ML_DSA_65:
        return "ML_DSA_65";
      case PublicKeyDetails.ML_DSA_87:
        return "ML_DSA_87";
      default:
        throw new globalThis.Error("Unrecognized enum value " + object + " for enum PublicKeyDetails");
    }
  }
  var SubjectAlternativeNameType;
  (function(SubjectAlternativeNameType2) {
    SubjectAlternativeNameType2[SubjectAlternativeNameType2["SUBJECT_ALTERNATIVE_NAME_TYPE_UNSPECIFIED"] = 0] = "SUBJECT_ALTERNATIVE_NAME_TYPE_UNSPECIFIED";
    SubjectAlternativeNameType2[SubjectAlternativeNameType2["EMAIL"] = 1] = "EMAIL";
    SubjectAlternativeNameType2[SubjectAlternativeNameType2["URI"] = 2] = "URI";
    SubjectAlternativeNameType2[SubjectAlternativeNameType2["OTHER_NAME"] = 3] = "OTHER_NAME";
  })(SubjectAlternativeNameType || (exports.SubjectAlternativeNameType = SubjectAlternativeNameType = {}));
  function subjectAlternativeNameTypeFromJSON(object) {
    switch (object) {
      case 0:
      case "SUBJECT_ALTERNATIVE_NAME_TYPE_UNSPECIFIED":
        return SubjectAlternativeNameType.SUBJECT_ALTERNATIVE_NAME_TYPE_UNSPECIFIED;
      case 1:
      case "EMAIL":
        return SubjectAlternativeNameType.EMAIL;
      case 2:
      case "URI":
        return SubjectAlternativeNameType.URI;
      case 3:
      case "OTHER_NAME":
        return SubjectAlternativeNameType.OTHER_NAME;
      default:
        throw new globalThis.Error("Unrecognized enum value " + object + " for enum SubjectAlternativeNameType");
    }
  }
  function subjectAlternativeNameTypeToJSON(object) {
    switch (object) {
      case SubjectAlternativeNameType.SUBJECT_ALTERNATIVE_NAME_TYPE_UNSPECIFIED:
        return "SUBJECT_ALTERNATIVE_NAME_TYPE_UNSPECIFIED";
      case SubjectAlternativeNameType.EMAIL:
        return "EMAIL";
      case SubjectAlternativeNameType.URI:
        return "URI";
      case SubjectAlternativeNameType.OTHER_NAME:
        return "OTHER_NAME";
      default:
        throw new globalThis.Error("Unrecognized enum value " + object + " for enum SubjectAlternativeNameType");
    }
  }
  exports.HashOutput = {
    fromJSON(object) {
      return {
        algorithm: isSet(object.algorithm) ? hashAlgorithmFromJSON(object.algorithm) : 0,
        digest: isSet(object.digest) ? Buffer.from(bytesFromBase64(object.digest)) : Buffer.alloc(0)
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.algorithm !== 0) {
        obj.algorithm = hashAlgorithmToJSON(message.algorithm);
      }
      if (message.digest.length !== 0) {
        obj.digest = base64FromBytes(message.digest);
      }
      return obj;
    }
  };
  exports.MessageSignature = {
    fromJSON(object) {
      return {
        messageDigest: isSet(object.messageDigest) ? exports.HashOutput.fromJSON(object.messageDigest) : undefined,
        signature: isSet(object.signature) ? Buffer.from(bytesFromBase64(object.signature)) : Buffer.alloc(0)
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.messageDigest !== undefined) {
        obj.messageDigest = exports.HashOutput.toJSON(message.messageDigest);
      }
      if (message.signature.length !== 0) {
        obj.signature = base64FromBytes(message.signature);
      }
      return obj;
    }
  };
  exports.LogId = {
    fromJSON(object) {
      return { keyId: isSet(object.keyId) ? Buffer.from(bytesFromBase64(object.keyId)) : Buffer.alloc(0) };
    },
    toJSON(message) {
      const obj = {};
      if (message.keyId.length !== 0) {
        obj.keyId = base64FromBytes(message.keyId);
      }
      return obj;
    }
  };
  exports.RFC3161SignedTimestamp = {
    fromJSON(object) {
      return {
        signedTimestamp: isSet(object.signedTimestamp) ? Buffer.from(bytesFromBase64(object.signedTimestamp)) : Buffer.alloc(0)
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.signedTimestamp.length !== 0) {
        obj.signedTimestamp = base64FromBytes(message.signedTimestamp);
      }
      return obj;
    }
  };
  exports.PublicKey = {
    fromJSON(object) {
      return {
        rawBytes: isSet(object.rawBytes) ? Buffer.from(bytesFromBase64(object.rawBytes)) : undefined,
        keyDetails: isSet(object.keyDetails) ? publicKeyDetailsFromJSON(object.keyDetails) : 0,
        validFor: isSet(object.validFor) ? exports.TimeRange.fromJSON(object.validFor) : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.rawBytes !== undefined) {
        obj.rawBytes = base64FromBytes(message.rawBytes);
      }
      if (message.keyDetails !== 0) {
        obj.keyDetails = publicKeyDetailsToJSON(message.keyDetails);
      }
      if (message.validFor !== undefined) {
        obj.validFor = exports.TimeRange.toJSON(message.validFor);
      }
      return obj;
    }
  };
  exports.PublicKeyIdentifier = {
    fromJSON(object) {
      return { hint: isSet(object.hint) ? globalThis.String(object.hint) : "" };
    },
    toJSON(message) {
      const obj = {};
      if (message.hint !== "") {
        obj.hint = message.hint;
      }
      return obj;
    }
  };
  exports.ObjectIdentifier = {
    fromJSON(object) {
      return { id: globalThis.Array.isArray(object?.id) ? object.id.map((e) => globalThis.Number(e)) : [] };
    },
    toJSON(message) {
      const obj = {};
      if (message.id?.length) {
        obj.id = message.id.map((e) => Math.round(e));
      }
      return obj;
    }
  };
  exports.ObjectIdentifierValuePair = {
    fromJSON(object) {
      return {
        oid: isSet(object.oid) ? exports.ObjectIdentifier.fromJSON(object.oid) : undefined,
        value: isSet(object.value) ? Buffer.from(bytesFromBase64(object.value)) : Buffer.alloc(0)
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.oid !== undefined) {
        obj.oid = exports.ObjectIdentifier.toJSON(message.oid);
      }
      if (message.value.length !== 0) {
        obj.value = base64FromBytes(message.value);
      }
      return obj;
    }
  };
  exports.DistinguishedName = {
    fromJSON(object) {
      return {
        organization: isSet(object.organization) ? globalThis.String(object.organization) : "",
        commonName: isSet(object.commonName) ? globalThis.String(object.commonName) : ""
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.organization !== "") {
        obj.organization = message.organization;
      }
      if (message.commonName !== "") {
        obj.commonName = message.commonName;
      }
      return obj;
    }
  };
  exports.X509Certificate = {
    fromJSON(object) {
      return { rawBytes: isSet(object.rawBytes) ? Buffer.from(bytesFromBase64(object.rawBytes)) : Buffer.alloc(0) };
    },
    toJSON(message) {
      const obj = {};
      if (message.rawBytes.length !== 0) {
        obj.rawBytes = base64FromBytes(message.rawBytes);
      }
      return obj;
    }
  };
  exports.SubjectAlternativeName = {
    fromJSON(object) {
      return {
        type: isSet(object.type) ? subjectAlternativeNameTypeFromJSON(object.type) : 0,
        identity: isSet(object.regexp) ? { $case: "regexp", regexp: globalThis.String(object.regexp) } : isSet(object.value) ? { $case: "value", value: globalThis.String(object.value) } : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.type !== 0) {
        obj.type = subjectAlternativeNameTypeToJSON(message.type);
      }
      if (message.identity?.$case === "regexp") {
        obj.regexp = message.identity.regexp;
      } else if (message.identity?.$case === "value") {
        obj.value = message.identity.value;
      }
      return obj;
    }
  };
  exports.X509CertificateChain = {
    fromJSON(object) {
      return {
        certificates: globalThis.Array.isArray(object?.certificates) ? object.certificates.map((e) => exports.X509Certificate.fromJSON(e)) : []
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.certificates?.length) {
        obj.certificates = message.certificates.map((e) => exports.X509Certificate.toJSON(e));
      }
      return obj;
    }
  };
  exports.TimeRange = {
    fromJSON(object) {
      return {
        start: isSet(object.start) ? fromJsonTimestamp(object.start) : undefined,
        end: isSet(object.end) ? fromJsonTimestamp(object.end) : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.start !== undefined) {
        obj.start = message.start.toISOString();
      }
      if (message.end !== undefined) {
        obj.end = message.end.toISOString();
      }
      return obj;
    }
  };
  function bytesFromBase64(b64) {
    return Uint8Array.from(globalThis.Buffer.from(b64, "base64"));
  }
  function base64FromBytes(arr) {
    return globalThis.Buffer.from(arr).toString("base64");
  }
  function fromTimestamp(t) {
    let millis = (globalThis.Number(t.seconds) || 0) * 1000;
    millis += (t.nanos || 0) / 1e6;
    return new globalThis.Date(millis);
  }
  function fromJsonTimestamp(o) {
    if (o instanceof globalThis.Date) {
      return o;
    } else if (typeof o === "string") {
      return new globalThis.Date(o);
    } else {
      return fromTimestamp(timestamp_1.Timestamp.fromJSON(o));
    }
  }
  function isSet(value) {
    return value !== null && value !== undefined;
  }
});

// ../../node_modules/@sigstore/protobuf-specs/dist/__generated__/sigstore_rekor.js
var require_sigstore_rekor = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.TransparencyLogEntry = exports.InclusionPromise = exports.InclusionProof = exports.Checkpoint = exports.KindVersion = undefined;
  var sigstore_common_1 = require_sigstore_common();
  exports.KindVersion = {
    fromJSON(object) {
      return {
        kind: isSet(object.kind) ? globalThis.String(object.kind) : "",
        version: isSet(object.version) ? globalThis.String(object.version) : ""
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.kind !== "") {
        obj.kind = message.kind;
      }
      if (message.version !== "") {
        obj.version = message.version;
      }
      return obj;
    }
  };
  exports.Checkpoint = {
    fromJSON(object) {
      return { envelope: isSet(object.envelope) ? globalThis.String(object.envelope) : "" };
    },
    toJSON(message) {
      const obj = {};
      if (message.envelope !== "") {
        obj.envelope = message.envelope;
      }
      return obj;
    }
  };
  exports.InclusionProof = {
    fromJSON(object) {
      return {
        logIndex: isSet(object.logIndex) ? globalThis.String(object.logIndex) : "0",
        rootHash: isSet(object.rootHash) ? Buffer.from(bytesFromBase64(object.rootHash)) : Buffer.alloc(0),
        treeSize: isSet(object.treeSize) ? globalThis.String(object.treeSize) : "0",
        hashes: globalThis.Array.isArray(object?.hashes) ? object.hashes.map((e) => Buffer.from(bytesFromBase64(e))) : [],
        checkpoint: isSet(object.checkpoint) ? exports.Checkpoint.fromJSON(object.checkpoint) : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.logIndex !== "0") {
        obj.logIndex = message.logIndex;
      }
      if (message.rootHash.length !== 0) {
        obj.rootHash = base64FromBytes(message.rootHash);
      }
      if (message.treeSize !== "0") {
        obj.treeSize = message.treeSize;
      }
      if (message.hashes?.length) {
        obj.hashes = message.hashes.map((e) => base64FromBytes(e));
      }
      if (message.checkpoint !== undefined) {
        obj.checkpoint = exports.Checkpoint.toJSON(message.checkpoint);
      }
      return obj;
    }
  };
  exports.InclusionPromise = {
    fromJSON(object) {
      return {
        signedEntryTimestamp: isSet(object.signedEntryTimestamp) ? Buffer.from(bytesFromBase64(object.signedEntryTimestamp)) : Buffer.alloc(0)
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.signedEntryTimestamp.length !== 0) {
        obj.signedEntryTimestamp = base64FromBytes(message.signedEntryTimestamp);
      }
      return obj;
    }
  };
  exports.TransparencyLogEntry = {
    fromJSON(object) {
      return {
        logIndex: isSet(object.logIndex) ? globalThis.String(object.logIndex) : "0",
        logId: isSet(object.logId) ? sigstore_common_1.LogId.fromJSON(object.logId) : undefined,
        kindVersion: isSet(object.kindVersion) ? exports.KindVersion.fromJSON(object.kindVersion) : undefined,
        integratedTime: isSet(object.integratedTime) ? globalThis.String(object.integratedTime) : "0",
        inclusionPromise: isSet(object.inclusionPromise) ? exports.InclusionPromise.fromJSON(object.inclusionPromise) : undefined,
        inclusionProof: isSet(object.inclusionProof) ? exports.InclusionProof.fromJSON(object.inclusionProof) : undefined,
        canonicalizedBody: isSet(object.canonicalizedBody) ? Buffer.from(bytesFromBase64(object.canonicalizedBody)) : Buffer.alloc(0)
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.logIndex !== "0") {
        obj.logIndex = message.logIndex;
      }
      if (message.logId !== undefined) {
        obj.logId = sigstore_common_1.LogId.toJSON(message.logId);
      }
      if (message.kindVersion !== undefined) {
        obj.kindVersion = exports.KindVersion.toJSON(message.kindVersion);
      }
      if (message.integratedTime !== "0") {
        obj.integratedTime = message.integratedTime;
      }
      if (message.inclusionPromise !== undefined) {
        obj.inclusionPromise = exports.InclusionPromise.toJSON(message.inclusionPromise);
      }
      if (message.inclusionProof !== undefined) {
        obj.inclusionProof = exports.InclusionProof.toJSON(message.inclusionProof);
      }
      if (message.canonicalizedBody.length !== 0) {
        obj.canonicalizedBody = base64FromBytes(message.canonicalizedBody);
      }
      return obj;
    }
  };
  function bytesFromBase64(b64) {
    return Uint8Array.from(globalThis.Buffer.from(b64, "base64"));
  }
  function base64FromBytes(arr) {
    return globalThis.Buffer.from(arr).toString("base64");
  }
  function isSet(value) {
    return value !== null && value !== undefined;
  }
});

// ../../node_modules/@sigstore/protobuf-specs/dist/__generated__/sigstore_bundle.js
var require_sigstore_bundle = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.Bundle = exports.VerificationMaterial = exports.TimestampVerificationData = undefined;
  var envelope_1 = require_envelope();
  var sigstore_common_1 = require_sigstore_common();
  var sigstore_rekor_1 = require_sigstore_rekor();
  exports.TimestampVerificationData = {
    fromJSON(object) {
      return {
        rfc3161Timestamps: globalThis.Array.isArray(object?.rfc3161Timestamps) ? object.rfc3161Timestamps.map((e) => sigstore_common_1.RFC3161SignedTimestamp.fromJSON(e)) : []
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.rfc3161Timestamps?.length) {
        obj.rfc3161Timestamps = message.rfc3161Timestamps.map((e) => sigstore_common_1.RFC3161SignedTimestamp.toJSON(e));
      }
      return obj;
    }
  };
  exports.VerificationMaterial = {
    fromJSON(object) {
      return {
        content: isSet(object.publicKey) ? { $case: "publicKey", publicKey: sigstore_common_1.PublicKeyIdentifier.fromJSON(object.publicKey) } : isSet(object.x509CertificateChain) ? {
          $case: "x509CertificateChain",
          x509CertificateChain: sigstore_common_1.X509CertificateChain.fromJSON(object.x509CertificateChain)
        } : isSet(object.certificate) ? { $case: "certificate", certificate: sigstore_common_1.X509Certificate.fromJSON(object.certificate) } : undefined,
        tlogEntries: globalThis.Array.isArray(object?.tlogEntries) ? object.tlogEntries.map((e) => sigstore_rekor_1.TransparencyLogEntry.fromJSON(e)) : [],
        timestampVerificationData: isSet(object.timestampVerificationData) ? exports.TimestampVerificationData.fromJSON(object.timestampVerificationData) : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.content?.$case === "publicKey") {
        obj.publicKey = sigstore_common_1.PublicKeyIdentifier.toJSON(message.content.publicKey);
      } else if (message.content?.$case === "x509CertificateChain") {
        obj.x509CertificateChain = sigstore_common_1.X509CertificateChain.toJSON(message.content.x509CertificateChain);
      } else if (message.content?.$case === "certificate") {
        obj.certificate = sigstore_common_1.X509Certificate.toJSON(message.content.certificate);
      }
      if (message.tlogEntries?.length) {
        obj.tlogEntries = message.tlogEntries.map((e) => sigstore_rekor_1.TransparencyLogEntry.toJSON(e));
      }
      if (message.timestampVerificationData !== undefined) {
        obj.timestampVerificationData = exports.TimestampVerificationData.toJSON(message.timestampVerificationData);
      }
      return obj;
    }
  };
  exports.Bundle = {
    fromJSON(object) {
      return {
        mediaType: isSet(object.mediaType) ? globalThis.String(object.mediaType) : "",
        verificationMaterial: isSet(object.verificationMaterial) ? exports.VerificationMaterial.fromJSON(object.verificationMaterial) : undefined,
        content: isSet(object.messageSignature) ? { $case: "messageSignature", messageSignature: sigstore_common_1.MessageSignature.fromJSON(object.messageSignature) } : isSet(object.dsseEnvelope) ? { $case: "dsseEnvelope", dsseEnvelope: envelope_1.Envelope.fromJSON(object.dsseEnvelope) } : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.mediaType !== "") {
        obj.mediaType = message.mediaType;
      }
      if (message.verificationMaterial !== undefined) {
        obj.verificationMaterial = exports.VerificationMaterial.toJSON(message.verificationMaterial);
      }
      if (message.content?.$case === "messageSignature") {
        obj.messageSignature = sigstore_common_1.MessageSignature.toJSON(message.content.messageSignature);
      } else if (message.content?.$case === "dsseEnvelope") {
        obj.dsseEnvelope = envelope_1.Envelope.toJSON(message.content.dsseEnvelope);
      }
      return obj;
    }
  };
  function isSet(value) {
    return value !== null && value !== undefined;
  }
});

// ../../node_modules/@sigstore/protobuf-specs/dist/__generated__/sigstore_trustroot.js
var require_sigstore_trustroot = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.ClientTrustConfig = exports.ServiceConfiguration = exports.Service = exports.SigningConfig = exports.TrustedRoot = exports.CertificateAuthority = exports.TransparencyLogInstance = exports.ServiceSelector = undefined;
  exports.serviceSelectorFromJSON = serviceSelectorFromJSON;
  exports.serviceSelectorToJSON = serviceSelectorToJSON;
  var sigstore_common_1 = require_sigstore_common();
  var ServiceSelector;
  (function(ServiceSelector2) {
    ServiceSelector2[ServiceSelector2["SERVICE_SELECTOR_UNDEFINED"] = 0] = "SERVICE_SELECTOR_UNDEFINED";
    ServiceSelector2[ServiceSelector2["ALL"] = 1] = "ALL";
    ServiceSelector2[ServiceSelector2["ANY"] = 2] = "ANY";
    ServiceSelector2[ServiceSelector2["EXACT"] = 3] = "EXACT";
  })(ServiceSelector || (exports.ServiceSelector = ServiceSelector = {}));
  function serviceSelectorFromJSON(object) {
    switch (object) {
      case 0:
      case "SERVICE_SELECTOR_UNDEFINED":
        return ServiceSelector.SERVICE_SELECTOR_UNDEFINED;
      case 1:
      case "ALL":
        return ServiceSelector.ALL;
      case 2:
      case "ANY":
        return ServiceSelector.ANY;
      case 3:
      case "EXACT":
        return ServiceSelector.EXACT;
      default:
        throw new globalThis.Error("Unrecognized enum value " + object + " for enum ServiceSelector");
    }
  }
  function serviceSelectorToJSON(object) {
    switch (object) {
      case ServiceSelector.SERVICE_SELECTOR_UNDEFINED:
        return "SERVICE_SELECTOR_UNDEFINED";
      case ServiceSelector.ALL:
        return "ALL";
      case ServiceSelector.ANY:
        return "ANY";
      case ServiceSelector.EXACT:
        return "EXACT";
      default:
        throw new globalThis.Error("Unrecognized enum value " + object + " for enum ServiceSelector");
    }
  }
  exports.TransparencyLogInstance = {
    fromJSON(object) {
      return {
        baseUrl: isSet(object.baseUrl) ? globalThis.String(object.baseUrl) : "",
        hashAlgorithm: isSet(object.hashAlgorithm) ? (0, sigstore_common_1.hashAlgorithmFromJSON)(object.hashAlgorithm) : 0,
        publicKey: isSet(object.publicKey) ? sigstore_common_1.PublicKey.fromJSON(object.publicKey) : undefined,
        logId: isSet(object.logId) ? sigstore_common_1.LogId.fromJSON(object.logId) : undefined,
        checkpointKeyId: isSet(object.checkpointKeyId) ? sigstore_common_1.LogId.fromJSON(object.checkpointKeyId) : undefined,
        operator: isSet(object.operator) ? globalThis.String(object.operator) : ""
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.baseUrl !== "") {
        obj.baseUrl = message.baseUrl;
      }
      if (message.hashAlgorithm !== 0) {
        obj.hashAlgorithm = (0, sigstore_common_1.hashAlgorithmToJSON)(message.hashAlgorithm);
      }
      if (message.publicKey !== undefined) {
        obj.publicKey = sigstore_common_1.PublicKey.toJSON(message.publicKey);
      }
      if (message.logId !== undefined) {
        obj.logId = sigstore_common_1.LogId.toJSON(message.logId);
      }
      if (message.checkpointKeyId !== undefined) {
        obj.checkpointKeyId = sigstore_common_1.LogId.toJSON(message.checkpointKeyId);
      }
      if (message.operator !== "") {
        obj.operator = message.operator;
      }
      return obj;
    }
  };
  exports.CertificateAuthority = {
    fromJSON(object) {
      return {
        subject: isSet(object.subject) ? sigstore_common_1.DistinguishedName.fromJSON(object.subject) : undefined,
        uri: isSet(object.uri) ? globalThis.String(object.uri) : "",
        certChain: isSet(object.certChain) ? sigstore_common_1.X509CertificateChain.fromJSON(object.certChain) : undefined,
        validFor: isSet(object.validFor) ? sigstore_common_1.TimeRange.fromJSON(object.validFor) : undefined,
        operator: isSet(object.operator) ? globalThis.String(object.operator) : ""
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.subject !== undefined) {
        obj.subject = sigstore_common_1.DistinguishedName.toJSON(message.subject);
      }
      if (message.uri !== "") {
        obj.uri = message.uri;
      }
      if (message.certChain !== undefined) {
        obj.certChain = sigstore_common_1.X509CertificateChain.toJSON(message.certChain);
      }
      if (message.validFor !== undefined) {
        obj.validFor = sigstore_common_1.TimeRange.toJSON(message.validFor);
      }
      if (message.operator !== "") {
        obj.operator = message.operator;
      }
      return obj;
    }
  };
  exports.TrustedRoot = {
    fromJSON(object) {
      return {
        mediaType: isSet(object.mediaType) ? globalThis.String(object.mediaType) : "",
        tlogs: globalThis.Array.isArray(object?.tlogs) ? object.tlogs.map((e) => exports.TransparencyLogInstance.fromJSON(e)) : [],
        certificateAuthorities: globalThis.Array.isArray(object?.certificateAuthorities) ? object.certificateAuthorities.map((e) => exports.CertificateAuthority.fromJSON(e)) : [],
        ctlogs: globalThis.Array.isArray(object?.ctlogs) ? object.ctlogs.map((e) => exports.TransparencyLogInstance.fromJSON(e)) : [],
        timestampAuthorities: globalThis.Array.isArray(object?.timestampAuthorities) ? object.timestampAuthorities.map((e) => exports.CertificateAuthority.fromJSON(e)) : []
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.mediaType !== "") {
        obj.mediaType = message.mediaType;
      }
      if (message.tlogs?.length) {
        obj.tlogs = message.tlogs.map((e) => exports.TransparencyLogInstance.toJSON(e));
      }
      if (message.certificateAuthorities?.length) {
        obj.certificateAuthorities = message.certificateAuthorities.map((e) => exports.CertificateAuthority.toJSON(e));
      }
      if (message.ctlogs?.length) {
        obj.ctlogs = message.ctlogs.map((e) => exports.TransparencyLogInstance.toJSON(e));
      }
      if (message.timestampAuthorities?.length) {
        obj.timestampAuthorities = message.timestampAuthorities.map((e) => exports.CertificateAuthority.toJSON(e));
      }
      return obj;
    }
  };
  exports.SigningConfig = {
    fromJSON(object) {
      return {
        mediaType: isSet(object.mediaType) ? globalThis.String(object.mediaType) : "",
        caUrls: globalThis.Array.isArray(object?.caUrls) ? object.caUrls.map((e) => exports.Service.fromJSON(e)) : [],
        oidcUrls: globalThis.Array.isArray(object?.oidcUrls) ? object.oidcUrls.map((e) => exports.Service.fromJSON(e)) : [],
        rekorTlogUrls: globalThis.Array.isArray(object?.rekorTlogUrls) ? object.rekorTlogUrls.map((e) => exports.Service.fromJSON(e)) : [],
        rekorTlogConfig: isSet(object.rekorTlogConfig) ? exports.ServiceConfiguration.fromJSON(object.rekorTlogConfig) : undefined,
        tsaUrls: globalThis.Array.isArray(object?.tsaUrls) ? object.tsaUrls.map((e) => exports.Service.fromJSON(e)) : [],
        tsaConfig: isSet(object.tsaConfig) ? exports.ServiceConfiguration.fromJSON(object.tsaConfig) : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.mediaType !== "") {
        obj.mediaType = message.mediaType;
      }
      if (message.caUrls?.length) {
        obj.caUrls = message.caUrls.map((e) => exports.Service.toJSON(e));
      }
      if (message.oidcUrls?.length) {
        obj.oidcUrls = message.oidcUrls.map((e) => exports.Service.toJSON(e));
      }
      if (message.rekorTlogUrls?.length) {
        obj.rekorTlogUrls = message.rekorTlogUrls.map((e) => exports.Service.toJSON(e));
      }
      if (message.rekorTlogConfig !== undefined) {
        obj.rekorTlogConfig = exports.ServiceConfiguration.toJSON(message.rekorTlogConfig);
      }
      if (message.tsaUrls?.length) {
        obj.tsaUrls = message.tsaUrls.map((e) => exports.Service.toJSON(e));
      }
      if (message.tsaConfig !== undefined) {
        obj.tsaConfig = exports.ServiceConfiguration.toJSON(message.tsaConfig);
      }
      return obj;
    }
  };
  exports.Service = {
    fromJSON(object) {
      return {
        url: isSet(object.url) ? globalThis.String(object.url) : "",
        majorApiVersion: isSet(object.majorApiVersion) ? globalThis.Number(object.majorApiVersion) : 0,
        validFor: isSet(object.validFor) ? sigstore_common_1.TimeRange.fromJSON(object.validFor) : undefined,
        operator: isSet(object.operator) ? globalThis.String(object.operator) : ""
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.url !== "") {
        obj.url = message.url;
      }
      if (message.majorApiVersion !== 0) {
        obj.majorApiVersion = Math.round(message.majorApiVersion);
      }
      if (message.validFor !== undefined) {
        obj.validFor = sigstore_common_1.TimeRange.toJSON(message.validFor);
      }
      if (message.operator !== "") {
        obj.operator = message.operator;
      }
      return obj;
    }
  };
  exports.ServiceConfiguration = {
    fromJSON(object) {
      return {
        selector: isSet(object.selector) ? serviceSelectorFromJSON(object.selector) : 0,
        count: isSet(object.count) ? globalThis.Number(object.count) : 0
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.selector !== 0) {
        obj.selector = serviceSelectorToJSON(message.selector);
      }
      if (message.count !== 0) {
        obj.count = Math.round(message.count);
      }
      return obj;
    }
  };
  exports.ClientTrustConfig = {
    fromJSON(object) {
      return {
        mediaType: isSet(object.mediaType) ? globalThis.String(object.mediaType) : "",
        trustedRoot: isSet(object.trustedRoot) ? exports.TrustedRoot.fromJSON(object.trustedRoot) : undefined,
        signingConfig: isSet(object.signingConfig) ? exports.SigningConfig.fromJSON(object.signingConfig) : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.mediaType !== "") {
        obj.mediaType = message.mediaType;
      }
      if (message.trustedRoot !== undefined) {
        obj.trustedRoot = exports.TrustedRoot.toJSON(message.trustedRoot);
      }
      if (message.signingConfig !== undefined) {
        obj.signingConfig = exports.SigningConfig.toJSON(message.signingConfig);
      }
      return obj;
    }
  };
  function isSet(value) {
    return value !== null && value !== undefined;
  }
});

// ../../node_modules/@sigstore/protobuf-specs/dist/__generated__/sigstore_verification.js
var require_sigstore_verification = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.Input = exports.Artifact = exports.ArtifactVerificationOptions_ObserverTimestampOptions = exports.ArtifactVerificationOptions_TlogIntegratedTimestampOptions = exports.ArtifactVerificationOptions_TimestampAuthorityOptions = exports.ArtifactVerificationOptions_CtlogOptions = exports.ArtifactVerificationOptions_TlogOptions = exports.ArtifactVerificationOptions = exports.PublicKeyIdentities = exports.CertificateIdentities = exports.CertificateIdentity = undefined;
  var sigstore_bundle_1 = require_sigstore_bundle();
  var sigstore_common_1 = require_sigstore_common();
  var sigstore_trustroot_1 = require_sigstore_trustroot();
  exports.CertificateIdentity = {
    fromJSON(object) {
      return {
        issuer: isSet(object.issuer) ? globalThis.String(object.issuer) : "",
        san: isSet(object.san) ? sigstore_common_1.SubjectAlternativeName.fromJSON(object.san) : undefined,
        oids: globalThis.Array.isArray(object?.oids) ? object.oids.map((e) => sigstore_common_1.ObjectIdentifierValuePair.fromJSON(e)) : []
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.issuer !== "") {
        obj.issuer = message.issuer;
      }
      if (message.san !== undefined) {
        obj.san = sigstore_common_1.SubjectAlternativeName.toJSON(message.san);
      }
      if (message.oids?.length) {
        obj.oids = message.oids.map((e) => sigstore_common_1.ObjectIdentifierValuePair.toJSON(e));
      }
      return obj;
    }
  };
  exports.CertificateIdentities = {
    fromJSON(object) {
      return {
        identities: globalThis.Array.isArray(object?.identities) ? object.identities.map((e) => exports.CertificateIdentity.fromJSON(e)) : []
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.identities?.length) {
        obj.identities = message.identities.map((e) => exports.CertificateIdentity.toJSON(e));
      }
      return obj;
    }
  };
  exports.PublicKeyIdentities = {
    fromJSON(object) {
      return {
        publicKeys: globalThis.Array.isArray(object?.publicKeys) ? object.publicKeys.map((e) => sigstore_common_1.PublicKey.fromJSON(e)) : []
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.publicKeys?.length) {
        obj.publicKeys = message.publicKeys.map((e) => sigstore_common_1.PublicKey.toJSON(e));
      }
      return obj;
    }
  };
  exports.ArtifactVerificationOptions = {
    fromJSON(object) {
      return {
        signers: isSet(object.certificateIdentities) ? {
          $case: "certificateIdentities",
          certificateIdentities: exports.CertificateIdentities.fromJSON(object.certificateIdentities)
        } : isSet(object.publicKeys) ? { $case: "publicKeys", publicKeys: exports.PublicKeyIdentities.fromJSON(object.publicKeys) } : undefined,
        tlogOptions: isSet(object.tlogOptions) ? exports.ArtifactVerificationOptions_TlogOptions.fromJSON(object.tlogOptions) : undefined,
        ctlogOptions: isSet(object.ctlogOptions) ? exports.ArtifactVerificationOptions_CtlogOptions.fromJSON(object.ctlogOptions) : undefined,
        tsaOptions: isSet(object.tsaOptions) ? exports.ArtifactVerificationOptions_TimestampAuthorityOptions.fromJSON(object.tsaOptions) : undefined,
        integratedTsOptions: isSet(object.integratedTsOptions) ? exports.ArtifactVerificationOptions_TlogIntegratedTimestampOptions.fromJSON(object.integratedTsOptions) : undefined,
        observerOptions: isSet(object.observerOptions) ? exports.ArtifactVerificationOptions_ObserverTimestampOptions.fromJSON(object.observerOptions) : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.signers?.$case === "certificateIdentities") {
        obj.certificateIdentities = exports.CertificateIdentities.toJSON(message.signers.certificateIdentities);
      } else if (message.signers?.$case === "publicKeys") {
        obj.publicKeys = exports.PublicKeyIdentities.toJSON(message.signers.publicKeys);
      }
      if (message.tlogOptions !== undefined) {
        obj.tlogOptions = exports.ArtifactVerificationOptions_TlogOptions.toJSON(message.tlogOptions);
      }
      if (message.ctlogOptions !== undefined) {
        obj.ctlogOptions = exports.ArtifactVerificationOptions_CtlogOptions.toJSON(message.ctlogOptions);
      }
      if (message.tsaOptions !== undefined) {
        obj.tsaOptions = exports.ArtifactVerificationOptions_TimestampAuthorityOptions.toJSON(message.tsaOptions);
      }
      if (message.integratedTsOptions !== undefined) {
        obj.integratedTsOptions = exports.ArtifactVerificationOptions_TlogIntegratedTimestampOptions.toJSON(message.integratedTsOptions);
      }
      if (message.observerOptions !== undefined) {
        obj.observerOptions = exports.ArtifactVerificationOptions_ObserverTimestampOptions.toJSON(message.observerOptions);
      }
      return obj;
    }
  };
  exports.ArtifactVerificationOptions_TlogOptions = {
    fromJSON(object) {
      return {
        threshold: isSet(object.threshold) ? globalThis.Number(object.threshold) : 0,
        performOnlineVerification: isSet(object.performOnlineVerification) ? globalThis.Boolean(object.performOnlineVerification) : false,
        disable: isSet(object.disable) ? globalThis.Boolean(object.disable) : false
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.threshold !== 0) {
        obj.threshold = Math.round(message.threshold);
      }
      if (message.performOnlineVerification !== false) {
        obj.performOnlineVerification = message.performOnlineVerification;
      }
      if (message.disable !== false) {
        obj.disable = message.disable;
      }
      return obj;
    }
  };
  exports.ArtifactVerificationOptions_CtlogOptions = {
    fromJSON(object) {
      return {
        threshold: isSet(object.threshold) ? globalThis.Number(object.threshold) : 0,
        disable: isSet(object.disable) ? globalThis.Boolean(object.disable) : false
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.threshold !== 0) {
        obj.threshold = Math.round(message.threshold);
      }
      if (message.disable !== false) {
        obj.disable = message.disable;
      }
      return obj;
    }
  };
  exports.ArtifactVerificationOptions_TimestampAuthorityOptions = {
    fromJSON(object) {
      return {
        threshold: isSet(object.threshold) ? globalThis.Number(object.threshold) : 0,
        disable: isSet(object.disable) ? globalThis.Boolean(object.disable) : false
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.threshold !== 0) {
        obj.threshold = Math.round(message.threshold);
      }
      if (message.disable !== false) {
        obj.disable = message.disable;
      }
      return obj;
    }
  };
  exports.ArtifactVerificationOptions_TlogIntegratedTimestampOptions = {
    fromJSON(object) {
      return {
        threshold: isSet(object.threshold) ? globalThis.Number(object.threshold) : 0,
        disable: isSet(object.disable) ? globalThis.Boolean(object.disable) : false
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.threshold !== 0) {
        obj.threshold = Math.round(message.threshold);
      }
      if (message.disable !== false) {
        obj.disable = message.disable;
      }
      return obj;
    }
  };
  exports.ArtifactVerificationOptions_ObserverTimestampOptions = {
    fromJSON(object) {
      return {
        threshold: isSet(object.threshold) ? globalThis.Number(object.threshold) : 0,
        disable: isSet(object.disable) ? globalThis.Boolean(object.disable) : false
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.threshold !== 0) {
        obj.threshold = Math.round(message.threshold);
      }
      if (message.disable !== false) {
        obj.disable = message.disable;
      }
      return obj;
    }
  };
  exports.Artifact = {
    fromJSON(object) {
      return {
        data: isSet(object.artifactUri) ? { $case: "artifactUri", artifactUri: globalThis.String(object.artifactUri) } : isSet(object.artifact) ? { $case: "artifact", artifact: Buffer.from(bytesFromBase64(object.artifact)) } : isSet(object.artifactDigest) ? { $case: "artifactDigest", artifactDigest: sigstore_common_1.HashOutput.fromJSON(object.artifactDigest) } : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.data?.$case === "artifactUri") {
        obj.artifactUri = message.data.artifactUri;
      } else if (message.data?.$case === "artifact") {
        obj.artifact = base64FromBytes(message.data.artifact);
      } else if (message.data?.$case === "artifactDigest") {
        obj.artifactDigest = sigstore_common_1.HashOutput.toJSON(message.data.artifactDigest);
      }
      return obj;
    }
  };
  exports.Input = {
    fromJSON(object) {
      return {
        artifactTrustRoot: isSet(object.artifactTrustRoot) ? sigstore_trustroot_1.TrustedRoot.fromJSON(object.artifactTrustRoot) : undefined,
        artifactVerificationOptions: isSet(object.artifactVerificationOptions) ? exports.ArtifactVerificationOptions.fromJSON(object.artifactVerificationOptions) : undefined,
        bundle: isSet(object.bundle) ? sigstore_bundle_1.Bundle.fromJSON(object.bundle) : undefined,
        artifact: isSet(object.artifact) ? exports.Artifact.fromJSON(object.artifact) : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.artifactTrustRoot !== undefined) {
        obj.artifactTrustRoot = sigstore_trustroot_1.TrustedRoot.toJSON(message.artifactTrustRoot);
      }
      if (message.artifactVerificationOptions !== undefined) {
        obj.artifactVerificationOptions = exports.ArtifactVerificationOptions.toJSON(message.artifactVerificationOptions);
      }
      if (message.bundle !== undefined) {
        obj.bundle = sigstore_bundle_1.Bundle.toJSON(message.bundle);
      }
      if (message.artifact !== undefined) {
        obj.artifact = exports.Artifact.toJSON(message.artifact);
      }
      return obj;
    }
  };
  function bytesFromBase64(b64) {
    return Uint8Array.from(globalThis.Buffer.from(b64, "base64"));
  }
  function base64FromBytes(arr) {
    return globalThis.Buffer.from(arr).toString("base64");
  }
  function isSet(value) {
    return value !== null && value !== undefined;
  }
});

// ../../node_modules/@sigstore/protobuf-specs/dist/index.js
var require_dist = __commonJS((exports) => {
  var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() {
        return m[k];
      } };
    }
    Object.defineProperty(o, k2, desc);
  } : function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    o[k2] = m[k];
  });
  var __exportStar = exports && exports.__exportStar || function(m, exports2) {
    for (var p in m)
      if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p))
        __createBinding(exports2, m, p);
  };
  Object.defineProperty(exports, "__esModule", { value: true });
  __exportStar(require_envelope(), exports);
  __exportStar(require_sigstore_bundle(), exports);
  __exportStar(require_sigstore_common(), exports);
  __exportStar(require_sigstore_rekor(), exports);
  __exportStar(require_sigstore_trustroot(), exports);
  __exportStar(require_sigstore_verification(), exports);
});

// ../../node_modules/@sigstore/bundle/dist/bundle.js
var require_bundle = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.BUNDLE_V03_MEDIA_TYPE = exports.BUNDLE_V03_LEGACY_MEDIA_TYPE = exports.BUNDLE_V02_MEDIA_TYPE = exports.BUNDLE_V01_MEDIA_TYPE = undefined;
  exports.isBundleWithCertificateChain = isBundleWithCertificateChain;
  exports.isBundleWithPublicKey = isBundleWithPublicKey;
  exports.isBundleWithMessageSignature = isBundleWithMessageSignature;
  exports.isBundleWithDsseEnvelope = isBundleWithDsseEnvelope;
  exports.BUNDLE_V01_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle+json;version=0.1";
  exports.BUNDLE_V02_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle+json;version=0.2";
  exports.BUNDLE_V03_LEGACY_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle+json;version=0.3";
  exports.BUNDLE_V03_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";
  function isBundleWithCertificateChain(b) {
    return b.verificationMaterial.content.$case === "x509CertificateChain";
  }
  function isBundleWithPublicKey(b) {
    return b.verificationMaterial.content.$case === "publicKey";
  }
  function isBundleWithMessageSignature(b) {
    return b.content.$case === "messageSignature";
  }
  function isBundleWithDsseEnvelope(b) {
    return b.content.$case === "dsseEnvelope";
  }
});

// ../../node_modules/@sigstore/bundle/dist/build.js
var require_build = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.toMessageSignatureBundle = toMessageSignatureBundle;
  exports.toDSSEBundle = toDSSEBundle;
  var protobuf_specs_1 = require_dist();
  var bundle_1 = require_bundle();
  function toMessageSignatureBundle(options) {
    return {
      mediaType: options.certificateChain ? bundle_1.BUNDLE_V02_MEDIA_TYPE : bundle_1.BUNDLE_V03_MEDIA_TYPE,
      content: {
        $case: "messageSignature",
        messageSignature: {
          messageDigest: {
            algorithm: protobuf_specs_1.HashAlgorithm.SHA2_256,
            digest: options.digest
          },
          signature: options.signature
        }
      },
      verificationMaterial: toVerificationMaterial(options)
    };
  }
  function toDSSEBundle(options) {
    return {
      mediaType: options.certificateChain ? bundle_1.BUNDLE_V02_MEDIA_TYPE : bundle_1.BUNDLE_V03_MEDIA_TYPE,
      content: {
        $case: "dsseEnvelope",
        dsseEnvelope: toEnvelope(options)
      },
      verificationMaterial: toVerificationMaterial(options)
    };
  }
  function toEnvelope(options) {
    return {
      payloadType: options.artifactType,
      payload: options.artifact,
      signatures: [toSignature(options)]
    };
  }
  function toSignature(options) {
    return {
      keyid: options.keyHint || "",
      sig: options.signature
    };
  }
  function toVerificationMaterial(options) {
    return {
      content: toKeyContent(options),
      tlogEntries: [],
      timestampVerificationData: { rfc3161Timestamps: [] }
    };
  }
  function toKeyContent(options) {
    if (options.certificate) {
      if (options.certificateChain) {
        return {
          $case: "x509CertificateChain",
          x509CertificateChain: {
            certificates: [{ rawBytes: options.certificate }]
          }
        };
      } else {
        return {
          $case: "certificate",
          certificate: { rawBytes: options.certificate }
        };
      }
    } else {
      return {
        $case: "publicKey",
        publicKey: {
          hint: options.keyHint || ""
        }
      };
    }
  }
});

// ../../node_modules/@sigstore/bundle/dist/error.js
var require_error = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.ValidationError = undefined;

  class ValidationError extends Error {
    fields;
    constructor(message, fields) {
      super(message);
      this.fields = fields;
    }
  }
  exports.ValidationError = ValidationError;
});

// ../../node_modules/@sigstore/bundle/dist/validate.js
var require_validate = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.assertBundle = assertBundle;
  exports.assertBundleV01 = assertBundleV01;
  exports.isBundleV01 = isBundleV01;
  exports.assertBundleV02 = assertBundleV02;
  exports.assertBundleLatest = assertBundleLatest;
  var error_1 = require_error();
  function assertBundle(b) {
    const invalidValues = validateBundleBase(b);
    if (invalidValues.length > 0) {
      throw new error_1.ValidationError("invalid bundle", invalidValues);
    }
  }
  function assertBundleV01(b) {
    const invalidValues = [];
    invalidValues.push(...validateBundleBase(b));
    invalidValues.push(...validateInclusionPromise(b));
    if (invalidValues.length > 0) {
      throw new error_1.ValidationError("invalid v0.1 bundle", invalidValues);
    }
  }
  function isBundleV01(b) {
    try {
      assertBundleV01(b);
      return true;
    } catch (e) {
      return false;
    }
  }
  function assertBundleV02(b) {
    const invalidValues = [];
    invalidValues.push(...validateBundleBase(b));
    invalidValues.push(...validateInclusionProof(b));
    if (invalidValues.length > 0) {
      throw new error_1.ValidationError("invalid v0.2 bundle", invalidValues);
    }
  }
  function assertBundleLatest(b) {
    const invalidValues = [];
    invalidValues.push(...validateBundleBase(b));
    invalidValues.push(...validateInclusionProof(b));
    invalidValues.push(...validateNoCertificateChain(b));
    if (invalidValues.length > 0) {
      throw new error_1.ValidationError("invalid bundle", invalidValues);
    }
  }
  function validateBundleBase(b) {
    const invalidValues = [];
    if (b.mediaType === undefined || !b.mediaType.match(/^application\/vnd\.dev\.sigstore\.bundle\+json;version=\d\.\d/) && !b.mediaType.match(/^application\/vnd\.dev\.sigstore\.bundle\.v\d\.\d\+json/)) {
      invalidValues.push("mediaType");
    }
    if (b.content === undefined) {
      invalidValues.push("content");
    } else {
      switch (b.content.$case) {
        case "messageSignature":
          if (b.content.messageSignature.messageDigest === undefined) {
            invalidValues.push("content.messageSignature.messageDigest");
          } else {
            if (b.content.messageSignature.messageDigest.digest.length === 0) {
              invalidValues.push("content.messageSignature.messageDigest.digest");
            }
          }
          if (b.content.messageSignature.signature.length === 0) {
            invalidValues.push("content.messageSignature.signature");
          }
          break;
        case "dsseEnvelope":
          if (b.content.dsseEnvelope.payload.length === 0) {
            invalidValues.push("content.dsseEnvelope.payload");
          }
          if (b.content.dsseEnvelope.signatures.length !== 1) {
            invalidValues.push("content.dsseEnvelope.signatures");
          } else {
            if (b.content.dsseEnvelope.signatures[0].sig.length === 0) {
              invalidValues.push("content.dsseEnvelope.signatures[0].sig");
            }
          }
          break;
      }
    }
    if (b.verificationMaterial === undefined) {
      invalidValues.push("verificationMaterial");
    } else {
      if (b.verificationMaterial.content === undefined) {
        invalidValues.push("verificationMaterial.content");
      } else {
        switch (b.verificationMaterial.content.$case) {
          case "x509CertificateChain":
            if (b.verificationMaterial.content.x509CertificateChain.certificates.length === 0) {
              invalidValues.push("verificationMaterial.content.x509CertificateChain.certificates");
            }
            b.verificationMaterial.content.x509CertificateChain.certificates.forEach((cert, i) => {
              if (cert.rawBytes.length === 0) {
                invalidValues.push(`verificationMaterial.content.x509CertificateChain.certificates[${i}].rawBytes`);
              }
            });
            break;
          case "certificate":
            if (b.verificationMaterial.content.certificate.rawBytes.length === 0) {
              invalidValues.push("verificationMaterial.content.certificate.rawBytes");
            }
            break;
        }
      }
      if (b.verificationMaterial.tlogEntries === undefined) {
        invalidValues.push("verificationMaterial.tlogEntries");
      } else {
        if (b.verificationMaterial.tlogEntries.length > 0) {
          b.verificationMaterial.tlogEntries.forEach((entry, i) => {
            if (entry.logId === undefined) {
              invalidValues.push(`verificationMaterial.tlogEntries[${i}].logId`);
            }
            if (entry.kindVersion === undefined) {
              invalidValues.push(`verificationMaterial.tlogEntries[${i}].kindVersion`);
            }
          });
        }
      }
    }
    return invalidValues;
  }
  function validateInclusionPromise(b) {
    const invalidValues = [];
    if (b.verificationMaterial && b.verificationMaterial.tlogEntries?.length > 0) {
      b.verificationMaterial.tlogEntries.forEach((entry, i) => {
        if (entry.inclusionPromise === undefined) {
          invalidValues.push(`verificationMaterial.tlogEntries[${i}].inclusionPromise`);
        }
      });
    }
    return invalidValues;
  }
  function validateInclusionProof(b) {
    const invalidValues = [];
    if (b.verificationMaterial && b.verificationMaterial.tlogEntries?.length > 0) {
      b.verificationMaterial.tlogEntries.forEach((entry, i) => {
        if (entry.inclusionProof === undefined) {
          invalidValues.push(`verificationMaterial.tlogEntries[${i}].inclusionProof`);
        } else {
          if (entry.inclusionProof.checkpoint === undefined) {
            invalidValues.push(`verificationMaterial.tlogEntries[${i}].inclusionProof.checkpoint`);
          }
        }
      });
    }
    return invalidValues;
  }
  function validateNoCertificateChain(b) {
    const invalidValues = [];
    if (b.verificationMaterial?.content?.$case === "x509CertificateChain") {
      invalidValues.push("verificationMaterial.content.$case");
    }
    return invalidValues;
  }
});

// ../../node_modules/@sigstore/bundle/dist/serialized.js
var require_serialized = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.envelopeToJSON = exports.envelopeFromJSON = exports.bundleToJSON = exports.bundleFromJSON = undefined;
  var protobuf_specs_1 = require_dist();
  var bundle_1 = require_bundle();
  var validate_1 = require_validate();
  var bundleFromJSON = (obj) => {
    const bundle = protobuf_specs_1.Bundle.fromJSON(obj);
    switch (bundle.mediaType) {
      case bundle_1.BUNDLE_V01_MEDIA_TYPE:
        (0, validate_1.assertBundleV01)(bundle);
        break;
      case bundle_1.BUNDLE_V02_MEDIA_TYPE:
        (0, validate_1.assertBundleV02)(bundle);
        break;
      default:
        (0, validate_1.assertBundleLatest)(bundle);
        break;
    }
    return bundle;
  };
  exports.bundleFromJSON = bundleFromJSON;
  var bundleToJSON = (bundle) => {
    return protobuf_specs_1.Bundle.toJSON(bundle);
  };
  exports.bundleToJSON = bundleToJSON;
  var envelopeFromJSON = (obj) => {
    return protobuf_specs_1.Envelope.fromJSON(obj);
  };
  exports.envelopeFromJSON = envelopeFromJSON;
  var envelopeToJSON = (envelope) => {
    return protobuf_specs_1.Envelope.toJSON(envelope);
  };
  exports.envelopeToJSON = envelopeToJSON;
});

// ../../node_modules/@sigstore/bundle/dist/index.js
var require_dist2 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.isBundleV01 = exports.assertBundleV02 = exports.assertBundleV01 = exports.assertBundleLatest = exports.assertBundle = exports.envelopeToJSON = exports.envelopeFromJSON = exports.bundleToJSON = exports.bundleFromJSON = exports.ValidationError = exports.isBundleWithPublicKey = exports.isBundleWithMessageSignature = exports.isBundleWithDsseEnvelope = exports.isBundleWithCertificateChain = exports.BUNDLE_V03_MEDIA_TYPE = exports.BUNDLE_V03_LEGACY_MEDIA_TYPE = exports.BUNDLE_V02_MEDIA_TYPE = exports.BUNDLE_V01_MEDIA_TYPE = exports.toMessageSignatureBundle = exports.toDSSEBundle = undefined;
  var build_1 = require_build();
  Object.defineProperty(exports, "toDSSEBundle", { enumerable: true, get: function() {
    return build_1.toDSSEBundle;
  } });
  Object.defineProperty(exports, "toMessageSignatureBundle", { enumerable: true, get: function() {
    return build_1.toMessageSignatureBundle;
  } });
  var bundle_1 = require_bundle();
  Object.defineProperty(exports, "BUNDLE_V01_MEDIA_TYPE", { enumerable: true, get: function() {
    return bundle_1.BUNDLE_V01_MEDIA_TYPE;
  } });
  Object.defineProperty(exports, "BUNDLE_V02_MEDIA_TYPE", { enumerable: true, get: function() {
    return bundle_1.BUNDLE_V02_MEDIA_TYPE;
  } });
  Object.defineProperty(exports, "BUNDLE_V03_LEGACY_MEDIA_TYPE", { enumerable: true, get: function() {
    return bundle_1.BUNDLE_V03_LEGACY_MEDIA_TYPE;
  } });
  Object.defineProperty(exports, "BUNDLE_V03_MEDIA_TYPE", { enumerable: true, get: function() {
    return bundle_1.BUNDLE_V03_MEDIA_TYPE;
  } });
  Object.defineProperty(exports, "isBundleWithCertificateChain", { enumerable: true, get: function() {
    return bundle_1.isBundleWithCertificateChain;
  } });
  Object.defineProperty(exports, "isBundleWithDsseEnvelope", { enumerable: true, get: function() {
    return bundle_1.isBundleWithDsseEnvelope;
  } });
  Object.defineProperty(exports, "isBundleWithMessageSignature", { enumerable: true, get: function() {
    return bundle_1.isBundleWithMessageSignature;
  } });
  Object.defineProperty(exports, "isBundleWithPublicKey", { enumerable: true, get: function() {
    return bundle_1.isBundleWithPublicKey;
  } });
  var error_1 = require_error();
  Object.defineProperty(exports, "ValidationError", { enumerable: true, get: function() {
    return error_1.ValidationError;
  } });
  var serialized_1 = require_serialized();
  Object.defineProperty(exports, "bundleFromJSON", { enumerable: true, get: function() {
    return serialized_1.bundleFromJSON;
  } });
  Object.defineProperty(exports, "bundleToJSON", { enumerable: true, get: function() {
    return serialized_1.bundleToJSON;
  } });
  Object.defineProperty(exports, "envelopeFromJSON", { enumerable: true, get: function() {
    return serialized_1.envelopeFromJSON;
  } });
  Object.defineProperty(exports, "envelopeToJSON", { enumerable: true, get: function() {
    return serialized_1.envelopeToJSON;
  } });
  var validate_1 = require_validate();
  Object.defineProperty(exports, "assertBundle", { enumerable: true, get: function() {
    return validate_1.assertBundle;
  } });
  Object.defineProperty(exports, "assertBundleLatest", { enumerable: true, get: function() {
    return validate_1.assertBundleLatest;
  } });
  Object.defineProperty(exports, "assertBundleV01", { enumerable: true, get: function() {
    return validate_1.assertBundleV01;
  } });
  Object.defineProperty(exports, "assertBundleV02", { enumerable: true, get: function() {
    return validate_1.assertBundleV02;
  } });
  Object.defineProperty(exports, "isBundleV01", { enumerable: true, get: function() {
    return validate_1.isBundleV01;
  } });
});

// ../../node_modules/@sigstore/core/dist/stream.js
var require_stream = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.ByteStream = undefined;

  class StreamError extends Error {
  }

  class ByteStream {
    static BLOCK_SIZE = 1024;
    buf;
    view;
    start = 0;
    constructor(buffer) {
      if (buffer) {
        this.buf = buffer;
        this.view = Buffer.from(buffer);
      } else {
        this.buf = Buffer.alloc(0);
        this.view = Buffer.from(this.buf);
      }
    }
    get buffer() {
      return this.view.subarray(0, this.start);
    }
    get length() {
      return this.view.byteLength;
    }
    get position() {
      return this.start;
    }
    seek(position) {
      this.start = position;
    }
    slice(start, len) {
      const end = start + len;
      if (end > this.length) {
        throw new StreamError("request past end of buffer");
      }
      return this.view.subarray(start, end);
    }
    appendChar(char) {
      this.ensureCapacity(1);
      this.view[this.start] = char;
      this.start += 1;
    }
    appendUint16(num) {
      this.ensureCapacity(2);
      const value = new Uint16Array([num]);
      const view = new Uint8Array(value.buffer);
      this.view[this.start] = view[1];
      this.view[this.start + 1] = view[0];
      this.start += 2;
    }
    appendUint24(num) {
      this.ensureCapacity(3);
      const value = new Uint32Array([num]);
      const view = new Uint8Array(value.buffer);
      this.view[this.start] = view[2];
      this.view[this.start + 1] = view[1];
      this.view[this.start + 2] = view[0];
      this.start += 3;
    }
    appendView(view) {
      this.ensureCapacity(view.length);
      this.view.set(view, this.start);
      this.start += view.length;
    }
    getBlock(size) {
      if (size <= 0) {
        return Buffer.alloc(0);
      }
      if (this.start + size > this.view.length) {
        throw new Error("request past end of buffer");
      }
      const result = this.view.subarray(this.start, this.start + size);
      this.start += size;
      return result;
    }
    getUint8() {
      return this.getBlock(1)[0];
    }
    getUint16() {
      const block = this.getBlock(2);
      return block[0] << 8 | block[1];
    }
    ensureCapacity(size) {
      if (this.start + size > this.view.byteLength) {
        const blockSize = ByteStream.BLOCK_SIZE + (size > ByteStream.BLOCK_SIZE ? size : 0);
        this.realloc(this.view.byteLength + blockSize);
      }
    }
    realloc(size) {
      const newArray = Buffer.alloc(size);
      const newView = Buffer.from(newArray);
      newView.set(this.view);
      this.buf = newArray;
      this.view = newView;
    }
  }
  exports.ByteStream = ByteStream;
});

// ../../node_modules/@sigstore/core/dist/asn1/error.js
var require_error2 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.ASN1TypeError = exports.ASN1ParseError = undefined;

  class ASN1ParseError extends Error {
  }
  exports.ASN1ParseError = ASN1ParseError;

  class ASN1TypeError extends Error {
  }
  exports.ASN1TypeError = ASN1TypeError;
});

// ../../node_modules/@sigstore/core/dist/asn1/length.js
var require_length = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.decodeLength = decodeLength;
  exports.encodeLength = encodeLength;
  var error_1 = require_error2();
  function decodeLength(stream) {
    const buf = stream.getUint8();
    if ((buf & 128) === 0) {
      return buf;
    }
    const byteCount = buf & 127;
    if (byteCount > 6) {
      throw new error_1.ASN1ParseError("length exceeds 6 byte limit");
    }
    let len = 0;
    for (let i = 0;i < byteCount; i++) {
      const byte = stream.getUint8();
      if (i === 0 && byte === 0) {
        throw new error_1.ASN1ParseError("non-minimal length encoding");
      }
      len = len * 256 + byte;
    }
    if (len === 0) {
      throw new error_1.ASN1ParseError("indefinite length encoding not supported");
    }
    if (len < 128) {
      throw new error_1.ASN1ParseError("non-minimal length encoding");
    }
    return len;
  }
  function encodeLength(len) {
    if (len < 128) {
      return Buffer.from([len]);
    }
    let val = BigInt(len);
    const bytes = [];
    while (val > 0n) {
      bytes.unshift(Number(val & 255n));
      val = val >> 8n;
    }
    return Buffer.from([128 | bytes.length, ...bytes]);
  }
});

// ../../node_modules/@sigstore/core/dist/asn1/parse.js
var require_parse = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.parseInteger = parseInteger;
  exports.parseStringASCII = parseStringASCII;
  exports.parseTime = parseTime;
  exports.parseOID = parseOID;
  exports.parseBoolean = parseBoolean;
  exports.parseBitString = parseBitString;
  var error_1 = require_error2();
  var RE_TIME_SHORT_YEAR = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d{3})?Z$/;
  var RE_TIME_LONG_YEAR = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d{3})?Z$/;
  function parseInteger(buf) {
    let pos = 0;
    const end = buf.length;
    let val = buf[pos];
    const neg = val > 127;
    const pad = neg ? 255 : 0;
    while (val == pad && ++pos < end) {
      val = buf[pos];
    }
    const len = end - pos;
    if (len === 0)
      return BigInt(neg ? -1 : 0);
    val = neg ? val - 256 : val;
    let n = BigInt(val);
    for (let i = pos + 1;i < end; ++i) {
      n = n * BigInt(256) + BigInt(buf[i]);
    }
    return n;
  }
  function parseStringASCII(buf) {
    return buf.toString("ascii");
  }
  function parseTime(buf, shortYear) {
    const timeStr = parseStringASCII(buf);
    const m = shortYear ? RE_TIME_SHORT_YEAR.exec(timeStr) : RE_TIME_LONG_YEAR.exec(timeStr);
    if (!m) {
      throw new Error("invalid time");
    }
    if (shortYear) {
      let year = Number(m[1]);
      year += year >= 50 ? 1900 : 2000;
      m[1] = year.toString();
    }
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  }
  function parseOID(buf) {
    let pos = 0;
    const end = buf.length;
    let n = buf[pos++];
    const first = Math.floor(n / 40);
    const second = n % 40;
    let oid = `${first}.${second}`;
    let val = 0n;
    for (;pos < end; ++pos) {
      n = buf[pos];
      val = (val << 7n) + BigInt(n & 127);
      if ((n & 128) === 0) {
        oid += `.${val}`;
        val = 0n;
      }
    }
    return oid;
  }
  function parseBoolean(buf) {
    if (buf.length !== 1) {
      throw new error_1.ASN1ParseError("invalid boolean");
    }
    switch (buf[0]) {
      case 0:
        return false;
      case 255:
        return true;
      default:
        throw new error_1.ASN1ParseError("invalid boolean");
    }
  }
  function parseBitString(buf) {
    const unused = buf[0];
    if (unused > 7) {
      throw new error_1.ASN1ParseError("invalid bit string");
    }
    const start = 1;
    const end = buf.length;
    const bits = [];
    for (let i = start;i < end; ++i) {
      const byte = buf[i];
      const skip = i === end - 1 ? unused : 0;
      for (let j = 7;j >= skip; --j) {
        bits.push(byte >> j & 1);
      }
    }
    return bits;
  }
});

// ../../node_modules/@sigstore/core/dist/asn1/tag.js
var require_tag = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.ASN1Tag = undefined;
  var error_1 = require_error2();
  var UNIVERSAL_TAG = {
    BOOLEAN: 1,
    INTEGER: 2,
    BIT_STRING: 3,
    OCTET_STRING: 4,
    OBJECT_IDENTIFIER: 6,
    SEQUENCE: 16,
    SET: 17,
    PRINTABLE_STRING: 19,
    UTC_TIME: 23,
    GENERALIZED_TIME: 24
  };
  var TAG_CLASS = {
    UNIVERSAL: 0,
    APPLICATION: 1,
    CONTEXT_SPECIFIC: 2,
    PRIVATE: 3
  };

  class ASN1Tag {
    number;
    constructed;
    class;
    constructor(enc) {
      this.number = enc & 31;
      this.constructed = (enc & 32) === 32;
      this.class = enc >> 6;
      if (this.number === 31) {
        throw new error_1.ASN1ParseError("long form tags not supported");
      }
      if (this.class === TAG_CLASS.UNIVERSAL && this.number === 0) {
        throw new error_1.ASN1ParseError("unsupported tag 0x00");
      }
    }
    isUniversal() {
      return this.class === TAG_CLASS.UNIVERSAL;
    }
    isContextSpecific(num) {
      const res = this.class === TAG_CLASS.CONTEXT_SPECIFIC;
      return num !== undefined ? res && this.number === num : res;
    }
    isBoolean() {
      return this.isUniversal() && this.number === UNIVERSAL_TAG.BOOLEAN;
    }
    isInteger() {
      return this.isUniversal() && this.number === UNIVERSAL_TAG.INTEGER;
    }
    isBitString() {
      return this.isUniversal() && this.number === UNIVERSAL_TAG.BIT_STRING;
    }
    isOctetString() {
      return this.isUniversal() && this.number === UNIVERSAL_TAG.OCTET_STRING;
    }
    isOID() {
      return this.isUniversal() && this.number === UNIVERSAL_TAG.OBJECT_IDENTIFIER;
    }
    isUTCTime() {
      return this.isUniversal() && this.number === UNIVERSAL_TAG.UTC_TIME;
    }
    isGeneralizedTime() {
      return this.isUniversal() && this.number === UNIVERSAL_TAG.GENERALIZED_TIME;
    }
    toDER() {
      return this.number | (this.constructed ? 32 : 0) | this.class << 6;
    }
  }
  exports.ASN1Tag = ASN1Tag;
});

// ../../node_modules/@sigstore/core/dist/asn1/obj.js
var require_obj = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.ASN1Obj = undefined;
  var stream_1 = require_stream();
  var error_1 = require_error2();
  var length_1 = require_length();
  var parse_1 = require_parse();
  var tag_1 = require_tag();

  class ASN1Obj {
    tag;
    subs;
    value;
    constructor(tag, value, subs) {
      this.tag = tag;
      this.value = value;
      this.subs = subs;
    }
    static parseBuffer(buf) {
      const stream = new stream_1.ByteStream(buf);
      const obj = parseStream(stream);
      if (stream.position !== stream.length) {
        throw new error_1.ASN1ParseError("invalid trailing data");
      }
      return obj;
    }
    toDER() {
      const valueStream = new stream_1.ByteStream;
      if (this.subs.length > 0) {
        for (const sub of this.subs) {
          valueStream.appendView(sub.toDER());
        }
      } else {
        valueStream.appendView(this.value);
      }
      const value = valueStream.buffer;
      const obj = new stream_1.ByteStream;
      obj.appendChar(this.tag.toDER());
      obj.appendView((0, length_1.encodeLength)(value.length));
      obj.appendView(value);
      return obj.buffer;
    }
    toBoolean() {
      if (!this.tag.isBoolean()) {
        throw new error_1.ASN1TypeError("not a boolean");
      }
      return (0, parse_1.parseBoolean)(this.value);
    }
    toInteger() {
      if (!this.tag.isInteger()) {
        throw new error_1.ASN1TypeError("not an integer");
      }
      return (0, parse_1.parseInteger)(this.value);
    }
    toOID() {
      if (!this.tag.isOID()) {
        throw new error_1.ASN1TypeError("not an OID");
      }
      return (0, parse_1.parseOID)(this.value);
    }
    toDate() {
      switch (true) {
        case this.tag.isUTCTime():
          return (0, parse_1.parseTime)(this.value, true);
        case this.tag.isGeneralizedTime():
          return (0, parse_1.parseTime)(this.value, false);
        default:
          throw new error_1.ASN1TypeError("not a date");
      }
    }
    toBitString() {
      if (!this.tag.isBitString()) {
        throw new error_1.ASN1TypeError("not a bit string");
      }
      return (0, parse_1.parseBitString)(this.value);
    }
  }
  exports.ASN1Obj = ASN1Obj;
  var MAX_DEPTH = 100;
  function parseStream(stream, depth = 0) {
    if (depth > MAX_DEPTH) {
      throw new error_1.ASN1ParseError("maximum nesting depth exceeded");
    }
    const tag = new tag_1.ASN1Tag(stream.getUint8());
    const len = (0, length_1.decodeLength)(stream);
    const value = stream.slice(stream.position, len);
    const start = stream.position;
    let subs = [];
    if (tag.constructed) {
      subs = collectSubs(stream, len, depth);
    } else if (tag.isOctetString()) {
      try {
        subs = collectSubs(stream, len, depth);
      } catch (e) {}
    }
    if (subs.length === 0) {
      stream.seek(start + len);
    }
    return new ASN1Obj(tag, value, subs);
  }
  function collectSubs(stream, len, depth) {
    const end = stream.position + len;
    if (end > stream.length) {
      throw new error_1.ASN1ParseError("invalid length");
    }
    const subs = [];
    while (stream.position < end) {
      subs.push(parseStream(stream, depth + 1));
    }
    if (stream.position !== end) {
      throw new error_1.ASN1ParseError("invalid length");
    }
    return subs;
  }
});

// ../../node_modules/@sigstore/core/dist/asn1/index.js
var require_asn1 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.ASN1Obj = undefined;
  var obj_1 = require_obj();
  Object.defineProperty(exports, "ASN1Obj", { enumerable: true, get: function() {
    return obj_1.ASN1Obj;
  } });
});

// ../../node_modules/@sigstore/core/dist/crypto.js
var require_crypto = __commonJS((exports) => {
  var __importDefault = exports && exports.__importDefault || function(mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.createPublicKey = createPublicKey;
  exports.digest = digest;
  exports.verify = verify;
  exports.bufferEqual = bufferEqual;
  var crypto_1 = __importDefault(__require("crypto"));
  function createPublicKey(key, type = "spki") {
    if (typeof key === "string") {
      if (key.startsWith("-----")) {
        return crypto_1.default.createPublicKey(key);
      } else {
        return crypto_1.default.createPublicKey({
          key: Buffer.from(key, "base64"),
          format: "der",
          type
        });
      }
    } else {
      return crypto_1.default.createPublicKey({ key, format: "der", type });
    }
  }
  function digest(algorithm, ...data) {
    const hash = crypto_1.default.createHash(algorithm);
    for (const d of data) {
      hash.update(d);
    }
    return hash.digest();
  }
  function verify(data, key, signature, algorithm) {
    try {
      return crypto_1.default.verify(algorithm, data, key, signature);
    } catch (e) {
      return false;
    }
  }
  function bufferEqual(a, b) {
    try {
      return crypto_1.default.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
});

// ../../node_modules/@sigstore/core/dist/dsse.js
var require_dsse = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.preAuthEncoding = preAuthEncoding;
  var PAE_PREFIX = "DSSEv1";
  function preAuthEncoding(payloadType, payload) {
    const typeBytes = Buffer.from(payloadType, "utf-8");
    return Buffer.concat([
      Buffer.from(`${PAE_PREFIX} ${typeBytes.length} `, "ascii"),
      typeBytes,
      Buffer.from(` ${payload.length} `, "ascii"),
      payload
    ]);
  }
});

// ../../node_modules/@sigstore/core/dist/encoding.js
var require_encoding = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.base64Encode = base64Encode;
  exports.base64Decode = base64Decode;
  var BASE64_ENCODING = "base64";
  var UTF8_ENCODING = "utf-8";
  function base64Encode(str) {
    return Buffer.from(str, UTF8_ENCODING).toString(BASE64_ENCODING);
  }
  function base64Decode(str) {
    return Buffer.from(str, BASE64_ENCODING).toString(UTF8_ENCODING);
  }
});

// ../../node_modules/@sigstore/core/dist/json.js
var require_json = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.canonicalize = canonicalize;
  function canonicalize(object) {
    let buffer = "";
    if (object === null || typeof object !== "object" || object.toJSON != null) {
      buffer += JSON.stringify(object);
    } else if (Array.isArray(object)) {
      buffer += "[";
      let first = true;
      object.forEach((element) => {
        if (!first) {
          buffer += ",";
        }
        first = false;
        buffer += canonicalize(element);
      });
      buffer += "]";
    } else {
      buffer += "{";
      let first = true;
      Object.keys(object).sort().forEach((property) => {
        if (!first) {
          buffer += ",";
        }
        first = false;
        buffer += JSON.stringify(property);
        buffer += ":";
        buffer += canonicalize(object[property]);
      });
      buffer += "}";
    }
    return buffer;
  }
});

// ../../node_modules/@sigstore/core/dist/pem.js
var require_pem = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.toDER = toDER;
  exports.fromDER = fromDER;
  var PEM_HEADER = /-----BEGIN (.*)-----/;
  var PEM_FOOTER = /-----END (.*)-----/;
  function toDER(certificate) {
    let der = "";
    certificate.split(`
`).forEach((line) => {
      if (line.match(PEM_HEADER) || line.match(PEM_FOOTER)) {
        return;
      }
      der += line;
    });
    return Buffer.from(der, "base64");
  }
  function fromDER(certificate, type = "CERTIFICATE") {
    const der = certificate.toString("base64");
    const lines = der.match(/.{1,64}/g) || "";
    return [`-----BEGIN ${type}-----`, ...lines, `-----END ${type}-----`].join(`
`).concat(`
`);
  }
});

// ../../node_modules/@sigstore/core/dist/oid.js
var require_oid = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.SHA2_HASH_ALGOS = exports.RSA_SIGNATURE_ALGOS = exports.ECDSA_SIGNATURE_ALGOS = undefined;
  exports.ECDSA_SIGNATURE_ALGOS = {
    "1.2.840.10045.4.3.1": "sha224",
    "1.2.840.10045.4.3.2": "sha256",
    "1.2.840.10045.4.3.3": "sha384",
    "1.2.840.10045.4.3.4": "sha512"
  };
  exports.RSA_SIGNATURE_ALGOS = {
    "1.2.840.113549.1.1.14": "sha224",
    "1.2.840.113549.1.1.11": "sha256",
    "1.2.840.113549.1.1.12": "sha384",
    "1.2.840.113549.1.1.13": "sha512"
  };
  exports.SHA2_HASH_ALGOS = {
    "2.16.840.1.101.3.4.2.1": "sha256",
    "2.16.840.1.101.3.4.2.2": "sha384",
    "2.16.840.1.101.3.4.2.3": "sha512"
  };
});

// ../../node_modules/@sigstore/core/dist/rfc3161/error.js
var require_error3 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.RFC3161TimestampVerificationError = undefined;

  class RFC3161TimestampVerificationError extends Error {
  }
  exports.RFC3161TimestampVerificationError = RFC3161TimestampVerificationError;
});

// ../../node_modules/@sigstore/core/dist/rfc3161/tstinfo.js
var require_tstinfo = __commonJS((exports) => {
  var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() {
        return m[k];
      } };
    }
    Object.defineProperty(o, k2, desc);
  } : function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    o[k2] = m[k];
  });
  var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
  } : function(o, v) {
    o["default"] = v;
  });
  var __importStar = exports && exports.__importStar || function() {
    var ownKeys = function(o) {
      ownKeys = Object.getOwnPropertyNames || function(o2) {
        var ar = [];
        for (var k in o2)
          if (Object.prototype.hasOwnProperty.call(o2, k))
            ar[ar.length] = k;
        return ar;
      };
      return ownKeys(o);
    };
    return function(mod) {
      if (mod && mod.__esModule)
        return mod;
      var result = {};
      if (mod != null) {
        for (var k = ownKeys(mod), i = 0;i < k.length; i++)
          if (k[i] !== "default")
            __createBinding(result, mod, k[i]);
      }
      __setModuleDefault(result, mod);
      return result;
    };
  }();
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.TSTInfo = undefined;
  var crypto3 = __importStar(require_crypto());
  var oid_1 = require_oid();
  var error_1 = require_error3();

  class TSTInfo {
    root;
    constructor(asn1) {
      this.root = asn1;
    }
    get version() {
      return this.root.subs[0].toInteger();
    }
    get genTime() {
      return this.root.subs[4].toDate();
    }
    get messageImprintHashAlgorithm() {
      const oid = this.messageImprintObj.subs[0].subs[0].toOID();
      return oid_1.SHA2_HASH_ALGOS[oid];
    }
    get messageImprintHashedMessage() {
      return this.messageImprintObj.subs[1].value;
    }
    get raw() {
      return this.root.toDER();
    }
    verify(data) {
      const digest = crypto3.digest(this.messageImprintHashAlgorithm, data);
      if (!crypto3.bufferEqual(digest, this.messageImprintHashedMessage)) {
        throw new error_1.RFC3161TimestampVerificationError("message imprint does not match artifact");
      }
    }
    get messageImprintObj() {
      return this.root.subs[2];
    }
  }
  exports.TSTInfo = TSTInfo;
});

// ../../node_modules/@sigstore/core/dist/rfc3161/timestamp.js
var require_timestamp2 = __commonJS((exports) => {
  var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() {
        return m[k];
      } };
    }
    Object.defineProperty(o, k2, desc);
  } : function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    o[k2] = m[k];
  });
  var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
  } : function(o, v) {
    o["default"] = v;
  });
  var __importStar = exports && exports.__importStar || function() {
    var ownKeys = function(o) {
      ownKeys = Object.getOwnPropertyNames || function(o2) {
        var ar = [];
        for (var k in o2)
          if (Object.prototype.hasOwnProperty.call(o2, k))
            ar[ar.length] = k;
        return ar;
      };
      return ownKeys(o);
    };
    return function(mod) {
      if (mod && mod.__esModule)
        return mod;
      var result = {};
      if (mod != null) {
        for (var k = ownKeys(mod), i = 0;i < k.length; i++)
          if (k[i] !== "default")
            __createBinding(result, mod, k[i]);
      }
      __setModuleDefault(result, mod);
      return result;
    };
  }();
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.RFC3161Timestamp = undefined;
  var asn1_1 = require_asn1();
  var crypto3 = __importStar(require_crypto());
  var oid_1 = require_oid();
  var error_1 = require_error3();
  var tstinfo_1 = require_tstinfo();
  var OID_PKCS9_CONTENT_TYPE_SIGNED_DATA = "1.2.840.113549.1.7.2";
  var OID_PKCS9_CONTENT_TYPE_TSTINFO = "1.2.840.113549.1.9.16.1.4";
  var OID_PKCS9_MESSAGE_DIGEST_KEY = "1.2.840.113549.1.9.4";

  class RFC3161Timestamp {
    root;
    constructor(asn1) {
      this.root = asn1;
    }
    static parse(der) {
      const asn1 = asn1_1.ASN1Obj.parseBuffer(der);
      return new RFC3161Timestamp(asn1);
    }
    get status() {
      return this.pkiStatusInfoObj.subs[0].toInteger();
    }
    get contentType() {
      return this.contentTypeObj.toOID();
    }
    get eContentType() {
      return this.eContentTypeObj.toOID();
    }
    get signingTime() {
      return this.tstInfo.genTime;
    }
    get signerIssuer() {
      return this.signerSidObj.subs[0].value;
    }
    get signerSerialNumber() {
      return this.signerSidObj.subs[1].value;
    }
    get signerDigestAlgorithm() {
      const oid = this.signerDigestAlgorithmObj.subs[0].toOID();
      return oid_1.SHA2_HASH_ALGOS[oid];
    }
    get signatureAlgorithm() {
      const oid = this.signatureAlgorithmObj.subs[0].toOID();
      return oid_1.ECDSA_SIGNATURE_ALGOS[oid];
    }
    get signatureValue() {
      return this.signatureValueObj.value;
    }
    get tstInfo() {
      return new tstinfo_1.TSTInfo(this.eContentObj.subs[0].subs[0]);
    }
    verify(data, publicKey) {
      if (!this.timeStampTokenObj) {
        throw new error_1.RFC3161TimestampVerificationError("timeStampToken is missing");
      }
      if (this.contentType !== OID_PKCS9_CONTENT_TYPE_SIGNED_DATA) {
        throw new error_1.RFC3161TimestampVerificationError(`incorrect content type: ${this.contentType}`);
      }
      if (this.eContentType !== OID_PKCS9_CONTENT_TYPE_TSTINFO) {
        throw new error_1.RFC3161TimestampVerificationError(`incorrect encapsulated content type: ${this.eContentType}`);
      }
      this.tstInfo.verify(data);
      this.verifyMessageDigest();
      this.verifySignature(publicKey);
    }
    verifyMessageDigest() {
      const tstInfoDigest = crypto3.digest(this.signerDigestAlgorithm, this.tstInfo.raw);
      const expectedDigest = this.messageDigestAttributeObj.subs[1].subs[0].value;
      if (!crypto3.bufferEqual(tstInfoDigest, expectedDigest)) {
        throw new error_1.RFC3161TimestampVerificationError("signed data does not match tstInfo");
      }
    }
    verifySignature(key) {
      const signedAttrs = this.signedAttrsObj.toDER();
      signedAttrs[0] = 49;
      const verified = crypto3.verify(signedAttrs, key, this.signatureValue, this.signatureAlgorithm);
      if (!verified) {
        throw new error_1.RFC3161TimestampVerificationError("signature verification failed");
      }
    }
    get pkiStatusInfoObj() {
      return this.root.subs[0];
    }
    get timeStampTokenObj() {
      return this.root.subs[1];
    }
    get contentTypeObj() {
      return this.timeStampTokenObj.subs[0];
    }
    get signedDataObj() {
      const obj = this.timeStampTokenObj.subs.find((sub) => sub.tag.isContextSpecific(0));
      return obj.subs[0];
    }
    get encapContentInfoObj() {
      return this.signedDataObj.subs[2];
    }
    get signerInfosObj() {
      const sd = this.signedDataObj;
      return sd.subs[sd.subs.length - 1];
    }
    get signerInfoObj() {
      return this.signerInfosObj.subs[0];
    }
    get eContentTypeObj() {
      return this.encapContentInfoObj.subs[0];
    }
    get eContentObj() {
      return this.encapContentInfoObj.subs[1];
    }
    get signedAttrsObj() {
      const signedAttrs = this.signerInfoObj.subs.find((sub) => sub.tag.isContextSpecific(0));
      return signedAttrs;
    }
    get messageDigestAttributeObj() {
      const messageDigest = this.signedAttrsObj.subs.find((sub) => sub.subs[0].tag.isOID() && sub.subs[0].toOID() === OID_PKCS9_MESSAGE_DIGEST_KEY);
      return messageDigest;
    }
    get signerSidObj() {
      return this.signerInfoObj.subs[1];
    }
    get signerDigestAlgorithmObj() {
      return this.signerInfoObj.subs[2];
    }
    get signatureAlgorithmObj() {
      return this.signerInfoObj.subs[4];
    }
    get signatureValueObj() {
      return this.signerInfoObj.subs[5];
    }
  }
  exports.RFC3161Timestamp = RFC3161Timestamp;
});

// ../../node_modules/@sigstore/core/dist/rfc3161/index.js
var require_rfc3161 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.RFC3161Timestamp = undefined;
  var timestamp_1 = require_timestamp2();
  Object.defineProperty(exports, "RFC3161Timestamp", { enumerable: true, get: function() {
    return timestamp_1.RFC3161Timestamp;
  } });
});

// ../../node_modules/@sigstore/core/dist/x509/sct.js
var require_sct = __commonJS((exports) => {
  var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() {
        return m[k];
      } };
    }
    Object.defineProperty(o, k2, desc);
  } : function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    o[k2] = m[k];
  });
  var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
  } : function(o, v) {
    o["default"] = v;
  });
  var __importStar = exports && exports.__importStar || function() {
    var ownKeys = function(o) {
      ownKeys = Object.getOwnPropertyNames || function(o2) {
        var ar = [];
        for (var k in o2)
          if (Object.prototype.hasOwnProperty.call(o2, k))
            ar[ar.length] = k;
        return ar;
      };
      return ownKeys(o);
    };
    return function(mod) {
      if (mod && mod.__esModule)
        return mod;
      var result = {};
      if (mod != null) {
        for (var k = ownKeys(mod), i = 0;i < k.length; i++)
          if (k[i] !== "default")
            __createBinding(result, mod, k[i]);
      }
      __setModuleDefault(result, mod);
      return result;
    };
  }();
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.SignedCertificateTimestamp = undefined;
  var crypto3 = __importStar(require_crypto());
  var stream_1 = require_stream();

  class SignedCertificateTimestamp {
    version;
    logID;
    timestamp;
    extensions;
    hashAlgorithm;
    signatureAlgorithm;
    signature;
    constructor(options) {
      this.version = options.version;
      this.logID = options.logID;
      this.timestamp = options.timestamp;
      this.extensions = options.extensions;
      this.hashAlgorithm = options.hashAlgorithm;
      this.signatureAlgorithm = options.signatureAlgorithm;
      this.signature = options.signature;
    }
    get datetime() {
      return new Date(Number(this.timestamp.readBigInt64BE()));
    }
    get algorithm() {
      switch (this.hashAlgorithm) {
        case 0:
          return "none";
        case 1:
          return "md5";
        case 2:
          return "sha1";
        case 3:
          return "sha224";
        case 4:
          return "sha256";
        case 5:
          return "sha384";
        case 6:
          return "sha512";
        default:
          return "unknown";
      }
    }
    verify(preCert, key) {
      const stream = new stream_1.ByteStream;
      stream.appendChar(this.version);
      stream.appendChar(0);
      stream.appendView(this.timestamp);
      stream.appendUint16(1);
      stream.appendView(preCert);
      stream.appendUint16(this.extensions.byteLength);
      if (this.extensions.byteLength > 0) {
        stream.appendView(this.extensions);
      }
      return crypto3.verify(stream.buffer, key, this.signature, this.algorithm);
    }
    static parse(buf) {
      const stream = new stream_1.ByteStream(buf);
      const version = stream.getUint8();
      const logID = stream.getBlock(32);
      const timestamp = stream.getBlock(8);
      const extenstionLength = stream.getUint16();
      const extensions = stream.getBlock(extenstionLength);
      const hashAlgorithm = stream.getUint8();
      const signatureAlgorithm = stream.getUint8();
      const sigLength = stream.getUint16();
      const signature = stream.getBlock(sigLength);
      if (stream.position !== buf.length) {
        throw new Error("SCT buffer length mismatch");
      }
      return new SignedCertificateTimestamp({
        version,
        logID,
        timestamp,
        extensions,
        hashAlgorithm,
        signatureAlgorithm,
        signature
      });
    }
  }
  exports.SignedCertificateTimestamp = SignedCertificateTimestamp;
});

// ../../node_modules/@sigstore/core/dist/x509/ext.js
var require_ext = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.X509SCTExtension = exports.X509SubjectKeyIDExtension = exports.X509AuthorityKeyIDExtension = exports.X509SubjectAlternativeNameExtension = exports.X509KeyUsageExtension = exports.X509BasicConstraintsExtension = exports.X509Extension = undefined;
  var stream_1 = require_stream();
  var sct_1 = require_sct();

  class X509Extension {
    root;
    constructor(asn1) {
      this.root = asn1;
    }
    get oid() {
      return this.root.subs[0].toOID();
    }
    get critical() {
      return this.root.subs.length === 3 ? this.root.subs[1].toBoolean() : false;
    }
    get value() {
      return this.extnValueObj.value;
    }
    get valueObj() {
      return this.extnValueObj;
    }
    get extnValueObj() {
      return this.root.subs[this.root.subs.length - 1];
    }
  }
  exports.X509Extension = X509Extension;

  class X509BasicConstraintsExtension extends X509Extension {
    get isCA() {
      return this.sequence.subs[0]?.toBoolean() ?? false;
    }
    get pathLenConstraint() {
      return this.sequence.subs.length > 1 ? this.sequence.subs[1].toInteger() : undefined;
    }
    get sequence() {
      return this.extnValueObj.subs[0];
    }
  }
  exports.X509BasicConstraintsExtension = X509BasicConstraintsExtension;

  class X509KeyUsageExtension extends X509Extension {
    get digitalSignature() {
      return this.bitString[0] === 1;
    }
    get keyCertSign() {
      return this.bitString[5] === 1;
    }
    get crlSign() {
      return this.bitString[6] === 1;
    }
    get bitString() {
      return this.extnValueObj.subs[0].toBitString();
    }
  }
  exports.X509KeyUsageExtension = X509KeyUsageExtension;

  class X509SubjectAlternativeNameExtension extends X509Extension {
    get rfc822Name() {
      return this.findGeneralName(1)?.value.toString("ascii");
    }
    get uri() {
      return this.findGeneralName(6)?.value.toString("ascii");
    }
    otherName(oid) {
      const otherName = this.findGeneralName(0);
      if (otherName === undefined) {
        return;
      }
      const otherNameOID = otherName.subs[0].toOID();
      if (otherNameOID !== oid) {
        return;
      }
      const otherNameValue = otherName.subs[1];
      return otherNameValue.subs[0].value.toString("ascii");
    }
    findGeneralName(tag) {
      return this.generalNames.find((gn) => gn.tag.isContextSpecific(tag));
    }
    get generalNames() {
      return this.extnValueObj.subs[0].subs;
    }
  }
  exports.X509SubjectAlternativeNameExtension = X509SubjectAlternativeNameExtension;

  class X509AuthorityKeyIDExtension extends X509Extension {
    get keyIdentifier() {
      return this.findSequenceMember(0)?.value;
    }
    findSequenceMember(tag) {
      return this.sequence.subs.find((el) => el.tag.isContextSpecific(tag));
    }
    get sequence() {
      return this.extnValueObj.subs[0];
    }
  }
  exports.X509AuthorityKeyIDExtension = X509AuthorityKeyIDExtension;

  class X509SubjectKeyIDExtension extends X509Extension {
    get keyIdentifier() {
      return this.extnValueObj.subs[0].value;
    }
  }
  exports.X509SubjectKeyIDExtension = X509SubjectKeyIDExtension;

  class X509SCTExtension extends X509Extension {
    constructor(asn1) {
      super(asn1);
    }
    get signedCertificateTimestamps() {
      const buf = this.extnValueObj.subs[0].value;
      const stream = new stream_1.ByteStream(buf);
      const end = stream.getUint16() + 2;
      const sctList = [];
      while (stream.position < end) {
        const sctLength = stream.getUint16();
        const sct = stream.getBlock(sctLength);
        sctList.push(sct_1.SignedCertificateTimestamp.parse(sct));
      }
      if (stream.position !== end) {
        throw new Error("SCT list length does not match actual length");
      }
      return sctList;
    }
  }
  exports.X509SCTExtension = X509SCTExtension;
});

// ../../node_modules/@sigstore/core/dist/x509/cert.js
var require_cert = __commonJS((exports) => {
  var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() {
        return m[k];
      } };
    }
    Object.defineProperty(o, k2, desc);
  } : function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    o[k2] = m[k];
  });
  var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
  } : function(o, v) {
    o["default"] = v;
  });
  var __importStar = exports && exports.__importStar || function() {
    var ownKeys = function(o) {
      ownKeys = Object.getOwnPropertyNames || function(o2) {
        var ar = [];
        for (var k in o2)
          if (Object.prototype.hasOwnProperty.call(o2, k))
            ar[ar.length] = k;
        return ar;
      };
      return ownKeys(o);
    };
    return function(mod) {
      if (mod && mod.__esModule)
        return mod;
      var result = {};
      if (mod != null) {
        for (var k = ownKeys(mod), i = 0;i < k.length; i++)
          if (k[i] !== "default")
            __createBinding(result, mod, k[i]);
      }
      __setModuleDefault(result, mod);
      return result;
    };
  }();
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.X509Certificate = exports.EXTENSION_OID_SCT = undefined;
  var asn1_1 = require_asn1();
  var crypto3 = __importStar(require_crypto());
  var oid_1 = require_oid();
  var pem = __importStar(require_pem());
  var ext_1 = require_ext();
  var EXTENSION_OID_SUBJECT_KEY_ID = "2.5.29.14";
  var EXTENSION_OID_KEY_USAGE = "2.5.29.15";
  var EXTENSION_OID_SUBJECT_ALT_NAME = "2.5.29.17";
  var EXTENSION_OID_BASIC_CONSTRAINTS = "2.5.29.19";
  var EXTENSION_OID_AUTHORITY_KEY_ID = "2.5.29.35";
  exports.EXTENSION_OID_SCT = "1.3.6.1.4.1.11129.2.4.2";

  class X509Certificate {
    root;
    constructor(asn1) {
      this.root = asn1;
    }
    static parse(cert) {
      const der = typeof cert === "string" ? pem.toDER(cert) : cert;
      const asn1 = asn1_1.ASN1Obj.parseBuffer(der);
      return new X509Certificate(asn1);
    }
    get tbsCertificate() {
      return this.tbsCertificateObj;
    }
    get version() {
      const ver = this.versionObj.subs[0].toInteger();
      return `v${(ver + BigInt(1)).toString()}`;
    }
    get serialNumber() {
      return this.serialNumberObj.value;
    }
    get notBefore() {
      return this.validityObj.subs[0].toDate();
    }
    get notAfter() {
      return this.validityObj.subs[1].toDate();
    }
    get issuer() {
      return this.issuerObj.value;
    }
    get subject() {
      return this.subjectObj.value;
    }
    get publicKey() {
      return this.subjectPublicKeyInfoObj.toDER();
    }
    get signatureAlgorithm() {
      const oid = this.signatureAlgorithmObj.subs[0].toOID();
      if (oid_1.RSA_SIGNATURE_ALGOS[oid]) {
        return oid_1.RSA_SIGNATURE_ALGOS[oid];
      }
      return oid_1.ECDSA_SIGNATURE_ALGOS[oid];
    }
    get signatureValue() {
      return this.signatureValueObj.value.subarray(1);
    }
    get subjectAltName() {
      const ext = this.extSubjectAltName;
      return ext?.uri || ext?.rfc822Name;
    }
    get extensions() {
      const extSeq = this.extensionsObj?.subs[0];
      return extSeq?.subs || [];
    }
    get extKeyUsage() {
      const ext = this.findExtension(EXTENSION_OID_KEY_USAGE);
      return ext ? new ext_1.X509KeyUsageExtension(ext) : undefined;
    }
    get extBasicConstraints() {
      const ext = this.findExtension(EXTENSION_OID_BASIC_CONSTRAINTS);
      return ext ? new ext_1.X509BasicConstraintsExtension(ext) : undefined;
    }
    get extSubjectAltName() {
      const ext = this.findExtension(EXTENSION_OID_SUBJECT_ALT_NAME);
      return ext ? new ext_1.X509SubjectAlternativeNameExtension(ext) : undefined;
    }
    get extAuthorityKeyID() {
      const ext = this.findExtension(EXTENSION_OID_AUTHORITY_KEY_ID);
      return ext ? new ext_1.X509AuthorityKeyIDExtension(ext) : undefined;
    }
    get extSubjectKeyID() {
      const ext = this.findExtension(EXTENSION_OID_SUBJECT_KEY_ID);
      return ext ? new ext_1.X509SubjectKeyIDExtension(ext) : undefined;
    }
    get extSCT() {
      const ext = this.findExtension(exports.EXTENSION_OID_SCT);
      return ext ? new ext_1.X509SCTExtension(ext) : undefined;
    }
    get isCA() {
      const ca = this.extBasicConstraints?.isCA || false;
      if (this.extKeyUsage) {
        return ca && this.extKeyUsage.keyCertSign;
      }
      return ca;
    }
    extension(oid) {
      const ext = this.findExtension(oid);
      return ext ? new ext_1.X509Extension(ext) : undefined;
    }
    verify(issuerCertificate) {
      const publicKey = issuerCertificate?.publicKey || this.publicKey;
      const key = crypto3.createPublicKey(publicKey);
      return crypto3.verify(this.tbsCertificate.toDER(), key, this.signatureValue, this.signatureAlgorithm);
    }
    validForDate(date) {
      return this.notBefore <= date && date <= this.notAfter;
    }
    equals(other) {
      return this.root.toDER().equals(other.root.toDER());
    }
    clone() {
      const der = this.root.toDER();
      const clone = Buffer.alloc(der.length);
      der.copy(clone);
      return X509Certificate.parse(clone);
    }
    findExtension(oid) {
      return this.extensions.find((ext) => ext.subs[0].toOID() === oid);
    }
    get tbsCertificateObj() {
      return this.root.subs[0];
    }
    get signatureAlgorithmObj() {
      return this.root.subs[1];
    }
    get signatureValueObj() {
      return this.root.subs[2];
    }
    get versionObj() {
      return this.tbsCertificateObj.subs[0];
    }
    get serialNumberObj() {
      return this.tbsCertificateObj.subs[1];
    }
    get issuerObj() {
      return this.tbsCertificateObj.subs[3];
    }
    get validityObj() {
      return this.tbsCertificateObj.subs[4];
    }
    get subjectObj() {
      return this.tbsCertificateObj.subs[5];
    }
    get subjectPublicKeyInfoObj() {
      return this.tbsCertificateObj.subs[6];
    }
    get extensionsObj() {
      return this.tbsCertificateObj.subs.find((sub) => sub.tag.isContextSpecific(3));
    }
  }
  exports.X509Certificate = X509Certificate;
});

// ../../node_modules/@sigstore/core/dist/x509/index.js
var require_x509 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.X509SCTExtension = exports.X509Certificate = exports.EXTENSION_OID_SCT = undefined;
  var cert_1 = require_cert();
  Object.defineProperty(exports, "EXTENSION_OID_SCT", { enumerable: true, get: function() {
    return cert_1.EXTENSION_OID_SCT;
  } });
  Object.defineProperty(exports, "X509Certificate", { enumerable: true, get: function() {
    return cert_1.X509Certificate;
  } });
  var ext_1 = require_ext();
  Object.defineProperty(exports, "X509SCTExtension", { enumerable: true, get: function() {
    return ext_1.X509SCTExtension;
  } });
});

// ../../node_modules/@sigstore/core/dist/index.js
var require_dist3 = __commonJS((exports) => {
  var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() {
        return m[k];
      } };
    }
    Object.defineProperty(o, k2, desc);
  } : function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    o[k2] = m[k];
  });
  var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
  } : function(o, v) {
    o["default"] = v;
  });
  var __importStar = exports && exports.__importStar || function() {
    var ownKeys = function(o) {
      ownKeys = Object.getOwnPropertyNames || function(o2) {
        var ar = [];
        for (var k in o2)
          if (Object.prototype.hasOwnProperty.call(o2, k))
            ar[ar.length] = k;
        return ar;
      };
      return ownKeys(o);
    };
    return function(mod) {
      if (mod && mod.__esModule)
        return mod;
      var result = {};
      if (mod != null) {
        for (var k = ownKeys(mod), i = 0;i < k.length; i++)
          if (k[i] !== "default")
            __createBinding(result, mod, k[i]);
      }
      __setModuleDefault(result, mod);
      return result;
    };
  }();
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.X509SCTExtension = exports.X509Certificate = exports.EXTENSION_OID_SCT = exports.ByteStream = exports.RFC3161Timestamp = exports.pem = exports.json = exports.encoding = exports.dsse = exports.crypto = exports.ASN1Obj = undefined;
  var asn1_1 = require_asn1();
  Object.defineProperty(exports, "ASN1Obj", { enumerable: true, get: function() {
    return asn1_1.ASN1Obj;
  } });
  exports.crypto = __importStar(require_crypto());
  exports.dsse = __importStar(require_dsse());
  exports.encoding = __importStar(require_encoding());
  exports.json = __importStar(require_json());
  exports.pem = __importStar(require_pem());
  var rfc3161_1 = require_rfc3161();
  Object.defineProperty(exports, "RFC3161Timestamp", { enumerable: true, get: function() {
    return rfc3161_1.RFC3161Timestamp;
  } });
  var stream_1 = require_stream();
  Object.defineProperty(exports, "ByteStream", { enumerable: true, get: function() {
    return stream_1.ByteStream;
  } });
  var x509_1 = require_x509();
  Object.defineProperty(exports, "EXTENSION_OID_SCT", { enumerable: true, get: function() {
    return x509_1.EXTENSION_OID_SCT;
  } });
  Object.defineProperty(exports, "X509Certificate", { enumerable: true, get: function() {
    return x509_1.X509Certificate;
  } });
  Object.defineProperty(exports, "X509SCTExtension", { enumerable: true, get: function() {
    return x509_1.X509SCTExtension;
  } });
});

// ../../node_modules/@sigstore/verify/dist/bundle/dsse.js
var require_dsse2 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.DSSESignatureContent = undefined;
  var core_1 = require_dist3();

  class DSSESignatureContent {
    env;
    constructor(env) {
      this.env = env;
    }
    compareDigest(digest) {
      return core_1.crypto.bufferEqual(digest, core_1.crypto.digest("sha256", this.env.payload));
    }
    compareSignedDigest(digest) {
      return core_1.crypto.bufferEqual(digest, core_1.crypto.digest("sha256", this.preAuthEncoding));
    }
    compareSignature(signature) {
      return core_1.crypto.bufferEqual(signature, this.signature);
    }
    verifySignature(key) {
      return core_1.crypto.verify(this.preAuthEncoding, key, this.signature);
    }
    get signature() {
      return this.env.signatures.length > 0 ? this.env.signatures[0].sig : Buffer.from("");
    }
    get preAuthEncoding() {
      return core_1.dsse.preAuthEncoding(this.env.payloadType, this.env.payload);
    }
  }
  exports.DSSESignatureContent = DSSESignatureContent;
});

// ../../node_modules/@sigstore/verify/dist/bundle/message.js
var require_message = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.MessageSignatureContent = undefined;
  var core_1 = require_dist3();
  var protobuf_specs_1 = require_dist();
  var HASH_ALGORITHM_MAP = {
    [protobuf_specs_1.HashAlgorithm.HASH_ALGORITHM_UNSPECIFIED]: "sha256",
    [protobuf_specs_1.HashAlgorithm.SHA2_256]: "sha256",
    [protobuf_specs_1.HashAlgorithm.SHA2_384]: "sha384",
    [protobuf_specs_1.HashAlgorithm.SHA2_512]: "sha512",
    [protobuf_specs_1.HashAlgorithm.SHA3_256]: "sha3-256",
    [protobuf_specs_1.HashAlgorithm.SHA3_384]: "sha3-384"
  };

  class MessageSignatureContent {
    signature;
    messageDigest;
    artifact;
    hashAlgorithm;
    constructor(messageSignature, artifact) {
      this.signature = messageSignature.signature;
      this.messageDigest = messageSignature.messageDigest.digest;
      this.artifact = artifact;
      this.hashAlgorithm = HASH_ALGORITHM_MAP[messageSignature.messageDigest.algorithm] ?? "sha256";
    }
    compareSignature(signature) {
      return core_1.crypto.bufferEqual(signature, this.signature);
    }
    compareDigest(digest) {
      return core_1.crypto.bufferEqual(digest, this.messageDigest);
    }
    compareSignedDigest(digest) {
      return this.compareDigest(digest);
    }
    verifySignature(key) {
      return core_1.crypto.verify(this.artifact, key, this.signature, this.hashAlgorithm);
    }
  }
  exports.MessageSignatureContent = MessageSignatureContent;
});

// ../../node_modules/@sigstore/verify/dist/bundle/index.js
var require_bundle2 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.toSignedEntity = toSignedEntity;
  exports.signatureContent = signatureContent;
  var core_1 = require_dist3();
  var dsse_1 = require_dsse2();
  var message_1 = require_message();
  function toSignedEntity(bundle, artifact) {
    const { tlogEntries, timestampVerificationData } = bundle.verificationMaterial;
    const timestamps = [];
    for (const entry of tlogEntries) {
      if (entry.integratedTime && entry.integratedTime !== "0") {
        timestamps.push({
          $case: "transparency-log",
          tlogEntry: entry
        });
      }
    }
    for (const ts of timestampVerificationData?.rfc3161Timestamps ?? []) {
      timestamps.push({
        $case: "timestamp-authority",
        timestamp: core_1.RFC3161Timestamp.parse(Buffer.from(ts.signedTimestamp))
      });
    }
    return {
      signature: signatureContent(bundle, artifact),
      key: key(bundle),
      tlogEntries,
      timestamps
    };
  }
  function signatureContent(bundle, artifact) {
    switch (bundle.content.$case) {
      case "dsseEnvelope":
        return new dsse_1.DSSESignatureContent(bundle.content.dsseEnvelope);
      case "messageSignature":
        return new message_1.MessageSignatureContent(bundle.content.messageSignature, artifact);
    }
  }
  function key(bundle) {
    switch (bundle.verificationMaterial.content.$case) {
      case "publicKey":
        return {
          $case: "public-key",
          hint: bundle.verificationMaterial.content.publicKey.hint
        };
      case "x509CertificateChain":
        return {
          $case: "certificate",
          certificate: core_1.X509Certificate.parse(Buffer.from(bundle.verificationMaterial.content.x509CertificateChain.certificates[0].rawBytes))
        };
      case "certificate":
        return {
          $case: "certificate",
          certificate: core_1.X509Certificate.parse(Buffer.from(bundle.verificationMaterial.content.certificate.rawBytes))
        };
    }
  }
});

// ../../node_modules/@sigstore/verify/dist/error.js
var require_error4 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.PolicyError = exports.VerificationError = undefined;

  class BaseError extends Error {
    code;
    cause;
    constructor({ code, message, cause }) {
      super(message);
      this.code = code;
      this.cause = cause;
      this.name = this.constructor.name;
    }
  }

  class VerificationError extends BaseError {
  }
  exports.VerificationError = VerificationError;

  class PolicyError extends BaseError {
  }
  exports.PolicyError = PolicyError;
});

// ../../node_modules/@sigstore/verify/dist/trust/filter.js
var require_filter = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.filterCertAuthorities = filterCertAuthorities;
  exports.filterTLogAuthorities = filterTLogAuthorities;
  function filterCertAuthorities(certAuthorities, timestamp) {
    return certAuthorities.filter((ca) => {
      return ca.validFor.start <= timestamp && ca.validFor.end >= timestamp;
    });
  }
  function filterTLogAuthorities(tlogAuthorities, criteria) {
    return tlogAuthorities.filter((tlog) => {
      if (criteria.logID && !tlog.logID.equals(criteria.logID)) {
        return false;
      }
      return tlog.validFor.start <= criteria.targetDate && criteria.targetDate <= tlog.validFor.end;
    });
  }
});

// ../../node_modules/@sigstore/verify/dist/trust/index.js
var require_trust = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.filterTLogAuthorities = exports.filterCertAuthorities = undefined;
  exports.toTrustMaterial = toTrustMaterial;
  var core_1 = require_dist3();
  var protobuf_specs_1 = require_dist();
  var error_1 = require_error4();
  var BEGINNING_OF_TIME = new Date(0);
  var END_OF_TIME = new Date(8640000000000000);
  var filter_1 = require_filter();
  Object.defineProperty(exports, "filterCertAuthorities", { enumerable: true, get: function() {
    return filter_1.filterCertAuthorities;
  } });
  Object.defineProperty(exports, "filterTLogAuthorities", { enumerable: true, get: function() {
    return filter_1.filterTLogAuthorities;
  } });
  function toTrustMaterial(root, keys) {
    const keyFinder = typeof keys === "function" ? keys : keyLocator(keys);
    return {
      certificateAuthorities: root.certificateAuthorities.map(createCertAuthority),
      timestampAuthorities: root.timestampAuthorities.map(createCertAuthority),
      tlogs: root.tlogs.map(createTLogAuthority),
      ctlogs: root.ctlogs.map(createTLogAuthority),
      publicKey: keyFinder
    };
  }
  function createTLogAuthority(tlogInstance) {
    const keyDetails = tlogInstance.publicKey.keyDetails;
    const keyType = keyDetails === protobuf_specs_1.PublicKeyDetails.PKCS1_RSA_PKCS1V5 || keyDetails === protobuf_specs_1.PublicKeyDetails.PKIX_RSA_PKCS1V5 || keyDetails === protobuf_specs_1.PublicKeyDetails.PKIX_RSA_PKCS1V15_2048_SHA256 || keyDetails === protobuf_specs_1.PublicKeyDetails.PKIX_RSA_PKCS1V15_3072_SHA256 || keyDetails === protobuf_specs_1.PublicKeyDetails.PKIX_RSA_PKCS1V15_4096_SHA256 ? "pkcs1" : "spki";
    return {
      baseURL: tlogInstance.baseUrl,
      logID: tlogInstance.checkpointKeyId ? tlogInstance.checkpointKeyId.keyId : tlogInstance.logId.keyId,
      publicKey: core_1.crypto.createPublicKey(tlogInstance.publicKey.rawBytes, keyType),
      validFor: {
        start: tlogInstance.publicKey.validFor?.start || BEGINNING_OF_TIME,
        end: tlogInstance.publicKey.validFor?.end || END_OF_TIME
      }
    };
  }
  function createCertAuthority(ca) {
    return {
      certChain: ca.certChain.certificates.map((cert) => {
        return core_1.X509Certificate.parse(Buffer.from(cert.rawBytes));
      }),
      validFor: {
        start: ca.validFor?.start || BEGINNING_OF_TIME,
        end: ca.validFor?.end || END_OF_TIME
      }
    };
  }
  function keyLocator(keys) {
    return (hint) => {
      const key = (keys || {})[hint];
      if (!key) {
        throw new error_1.VerificationError({
          code: "PUBLIC_KEY_ERROR",
          message: `key not found: ${hint}`
        });
      }
      return {
        publicKey: core_1.crypto.createPublicKey(key.rawBytes),
        validFor: (date) => {
          return (key.validFor?.start || BEGINNING_OF_TIME) <= date && (key.validFor?.end || END_OF_TIME) >= date;
        }
      };
    };
  }
});

// ../../node_modules/@sigstore/verify/dist/key/certificate.js
var require_certificate = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.CertificateChainVerifier = undefined;
  exports.verifyCertificateChain = verifyCertificateChain;
  var error_1 = require_error4();
  var trust_1 = require_trust();
  function verifyCertificateChain(timestamp, leaf, certificateAuthorities) {
    const cas = (0, trust_1.filterCertAuthorities)(certificateAuthorities, timestamp);
    let error;
    for (const ca of cas) {
      try {
        const verifier = new CertificateChainVerifier({
          trustedCerts: ca.certChain,
          untrustedCert: leaf,
          timestamp
        });
        return verifier.verify();
      } catch (err) {
        error = err;
      }
    }
    throw new error_1.VerificationError({
      code: "CERTIFICATE_ERROR",
      message: "Failed to verify certificate chain",
      cause: error
    });
  }

  class CertificateChainVerifier {
    untrustedCert;
    trustedCerts;
    localCerts;
    timestamp;
    constructor(opts) {
      this.untrustedCert = opts.untrustedCert;
      this.trustedCerts = opts.trustedCerts;
      this.localCerts = dedupeCertificates([
        ...opts.trustedCerts,
        opts.untrustedCert
      ]);
      this.timestamp = opts.timestamp;
    }
    verify() {
      const certificatePath = this.sort();
      this.checkPath(certificatePath);
      const validForDate = certificatePath.every((cert) => cert.validForDate(this.timestamp));
      if (!validForDate) {
        throw new error_1.VerificationError({
          code: "CERTIFICATE_ERROR",
          message: "certificate is not valid or expired at the specified date"
        });
      }
      return certificatePath;
    }
    sort() {
      const leafCert = this.untrustedCert;
      let paths = this.buildPaths(leafCert);
      paths = paths.filter((path2) => path2.some((cert) => this.trustedCerts.includes(cert)));
      if (paths.length === 0) {
        throw new error_1.VerificationError({
          code: "CERTIFICATE_ERROR",
          message: "no trusted certificate path found"
        });
      }
      const path = paths.reduce((prev, curr) => prev.length < curr.length ? prev : curr);
      return [leafCert, ...path].slice(0, -1);
    }
    buildPaths(certificate) {
      const paths = [];
      const issuers = this.findIssuer(certificate);
      if (issuers.length === 0) {
        throw new error_1.VerificationError({
          code: "CERTIFICATE_ERROR",
          message: "no valid certificate path found"
        });
      }
      for (let i = 0;i < issuers.length; i++) {
        const issuer = issuers[i];
        if (issuer.equals(certificate)) {
          paths.push([certificate]);
          continue;
        }
        const subPaths = this.buildPaths(issuer);
        for (let j = 0;j < subPaths.length; j++) {
          paths.push([issuer, ...subPaths[j]]);
        }
      }
      return paths;
    }
    findIssuer(certificate) {
      let issuers = [];
      let keyIdentifier;
      if (certificate.subject.equals(certificate.issuer)) {
        if (certificate.verify()) {
          return [certificate];
        }
      }
      if (certificate.extAuthorityKeyID) {
        keyIdentifier = certificate.extAuthorityKeyID.keyIdentifier;
      }
      this.localCerts.forEach((possibleIssuer) => {
        if (keyIdentifier) {
          if (possibleIssuer.extSubjectKeyID) {
            if (possibleIssuer.extSubjectKeyID.keyIdentifier.equals(keyIdentifier)) {
              issuers.push(possibleIssuer);
            }
            return;
          }
        }
        if (possibleIssuer.subject.equals(certificate.issuer)) {
          issuers.push(possibleIssuer);
        }
      });
      issuers = issuers.filter((issuer) => {
        try {
          return certificate.verify(issuer);
        } catch (ex) {
          return false;
        }
      });
      return issuers;
    }
    checkPath(path) {
      if (path.length < 1) {
        throw new error_1.VerificationError({
          code: "CERTIFICATE_ERROR",
          message: "certificate chain must contain at least one certificate"
        });
      }
      const validCAs = path.slice(1).every((cert) => cert.isCA);
      if (!validCAs) {
        throw new error_1.VerificationError({
          code: "CERTIFICATE_ERROR",
          message: "intermediate certificate is not a CA"
        });
      }
      for (let i = path.length - 2;i >= 0; i--) {
        if (!path[i].issuer.equals(path[i + 1].subject)) {
          throw new error_1.VerificationError({
            code: "CERTIFICATE_ERROR",
            message: "incorrect certificate name chaining"
          });
        }
      }
      for (let i = 0;i < path.length; i++) {
        const cert = path[i];
        if (cert.extBasicConstraints?.isCA) {
          const pathLength = cert.extBasicConstraints.pathLenConstraint;
          if (pathLength !== undefined && pathLength < i - 1) {
            throw new error_1.VerificationError({
              code: "CERTIFICATE_ERROR",
              message: "path length constraint exceeded"
            });
          }
        }
      }
    }
  }
  exports.CertificateChainVerifier = CertificateChainVerifier;
  function dedupeCertificates(certs) {
    for (let i = 0;i < certs.length; i++) {
      for (let j = i + 1;j < certs.length; j++) {
        if (certs[i].equals(certs[j])) {
          certs.splice(j, 1);
          j--;
        }
      }
    }
    return certs;
  }
});

// ../../node_modules/@sigstore/verify/dist/key/sct.js
var require_sct2 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.verifySCTs = verifySCTs;
  var core_1 = require_dist3();
  var error_1 = require_error4();
  var trust_1 = require_trust();
  function verifySCTs(cert, issuer, ctlogs) {
    let extSCT;
    const clone = cert.clone();
    for (let i = 0;i < clone.extensions.length; i++) {
      const ext = clone.extensions[i];
      if (ext.subs[0].toOID() === core_1.EXTENSION_OID_SCT) {
        extSCT = new core_1.X509SCTExtension(ext);
        clone.extensions.splice(i, 1);
        break;
      }
    }
    if (!extSCT) {
      return [];
    }
    if (extSCT.signedCertificateTimestamps.length === 0) {
      return [];
    }
    const preCert = new core_1.ByteStream;
    const issuerId = core_1.crypto.digest("sha256", issuer.publicKey);
    preCert.appendView(issuerId);
    const tbs = clone.tbsCertificate.toDER();
    preCert.appendUint24(tbs.length);
    preCert.appendView(tbs);
    return extSCT.signedCertificateTimestamps.map((sct) => {
      const validCTLogs = (0, trust_1.filterTLogAuthorities)(ctlogs, {
        logID: sct.logID,
        targetDate: sct.datetime
      });
      const verified = validCTLogs.some((log) => sct.verify(preCert.buffer, log.publicKey));
      if (!verified) {
        throw new error_1.VerificationError({
          code: "CERTIFICATE_ERROR",
          message: "SCT verification failed"
        });
      }
      return sct.logID;
    });
  }
});

// ../../node_modules/@sigstore/verify/dist/key/index.js
var require_key = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.verifyPublicKey = verifyPublicKey;
  exports.verifyCertificate = verifyCertificate;
  var core_1 = require_dist3();
  var error_1 = require_error4();
  var certificate_1 = require_certificate();
  var sct_1 = require_sct2();
  var OID_FULCIO_ISSUER_V1 = "1.3.6.1.4.1.57264.1.1";
  var OID_FULCIO_ISSUER_V2 = "1.3.6.1.4.1.57264.1.8";
  function verifyPublicKey(hint, timestamps, trustMaterial) {
    const key = trustMaterial.publicKey(hint);
    timestamps.forEach((timestamp) => {
      if (!key.validFor(timestamp)) {
        throw new error_1.VerificationError({
          code: "PUBLIC_KEY_ERROR",
          message: `Public key is not valid for timestamp: ${timestamp.toISOString()}`
        });
      }
    });
    return { key: key.publicKey };
  }
  function verifyCertificate(leaf, timestamps, trustMaterial) {
    let path = [];
    timestamps.forEach((timestamp) => {
      path = (0, certificate_1.verifyCertificateChain)(timestamp, leaf, trustMaterial.certificateAuthorities);
    });
    return {
      scts: (0, sct_1.verifySCTs)(path[0], path[1], trustMaterial.ctlogs),
      signer: getSigner(path[0])
    };
  }
  function getSigner(cert) {
    let issuer;
    const issuerExtension = cert.extension(OID_FULCIO_ISSUER_V2);
    if (issuerExtension) {
      issuer = issuerExtension.valueObj.subs?.[0]?.value.toString("ascii");
    } else {
      issuer = cert.extension(OID_FULCIO_ISSUER_V1)?.value.toString("ascii");
    }
    const oids = cert.extensions.map((ext) => {
      const oid = ext.subs[0].toOID();
      return {
        oid: { id: oid.split(".").map(Number) },
        value: ext.subs[ext.subs.length - 1].value
      };
    });
    const identity = {
      extensions: { issuer },
      subjectAlternativeName: cert.subjectAltName,
      oids
    };
    return {
      key: core_1.crypto.createPublicKey(cert.publicKey),
      identity
    };
  }
});

// ../../node_modules/@sigstore/verify/dist/policy.js
var require_policy = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.verifySubjectAlternativeName = verifySubjectAlternativeName;
  exports.verifyExtensions = verifyExtensions;
  exports.verifyOIDs = verifyOIDs;
  var error_1 = require_error4();
  function verifySubjectAlternativeName(policyIdentity, signerIdentity) {
    if (signerIdentity === undefined || !signerIdentity.match(policyIdentity)) {
      throw new error_1.PolicyError({
        code: "UNTRUSTED_SIGNER_ERROR",
        message: `certificate identity error - expected ${policyIdentity}, got ${signerIdentity}`
      });
    }
  }
  function verifyExtensions(policyExtensions, signerExtensions = {}) {
    let key;
    for (key in policyExtensions) {
      if (signerExtensions[key] !== policyExtensions[key]) {
        throw new error_1.PolicyError({
          code: "UNTRUSTED_SIGNER_ERROR",
          message: `invalid certificate extension - expected ${key}=${policyExtensions[key]}, got ${key}=${signerExtensions[key]}`
        });
      }
    }
  }
  function verifyOIDs(policyOIDs, signerOIDs = []) {
    for (const policyOID of policyOIDs) {
      const match = signerOIDs.find((signerOID) => oidEquals(policyOID.oid?.id, signerOID.oid?.id) && policyOID.value.equals(signerOID.value));
      if (!match) {
        const oid = policyOID.oid?.id.join(".") ?? "<unknown>";
        throw new error_1.PolicyError({
          code: "UNTRUSTED_SIGNER_ERROR",
          message: `invalid certificate extension - missing OID ${oid}`
        });
      }
    }
  }
  function oidEquals(a, b) {
    if (a === undefined || b === undefined) {
      return false;
    }
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
});

// ../../node_modules/@sigstore/verify/dist/timestamp/tsa.js
var require_tsa = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.verifyRFC3161Timestamp = verifyRFC3161Timestamp;
  var core_1 = require_dist3();
  var error_1 = require_error4();
  var certificate_1 = require_certificate();
  var trust_1 = require_trust();
  function verifyRFC3161Timestamp(timestamp, data, timestampAuthorities) {
    const signingTime = timestamp.signingTime;
    timestampAuthorities = (0, trust_1.filterCertAuthorities)(timestampAuthorities, signingTime);
    timestampAuthorities = filterCAsBySerialAndIssuer(timestampAuthorities, {
      serialNumber: timestamp.signerSerialNumber,
      issuer: timestamp.signerIssuer
    });
    const verified = timestampAuthorities.some((ca) => {
      try {
        verifyTimestampForCA(timestamp, data, ca);
        return true;
      } catch (e) {
        return false;
      }
    });
    if (!verified) {
      throw new error_1.VerificationError({
        code: "TIMESTAMP_ERROR",
        message: "timestamp could not be verified"
      });
    }
  }
  function verifyTimestampForCA(timestamp, data, ca) {
    const [leaf, ...cas] = ca.certChain;
    const signingKey = core_1.crypto.createPublicKey(leaf.publicKey);
    const signingTime = timestamp.signingTime;
    try {
      new certificate_1.CertificateChainVerifier({
        untrustedCert: leaf,
        trustedCerts: cas,
        timestamp: signingTime
      }).verify();
    } catch (e) {
      throw new error_1.VerificationError({
        code: "TIMESTAMP_ERROR",
        message: "invalid certificate chain"
      });
    }
    timestamp.verify(data, signingKey);
  }
  function filterCAsBySerialAndIssuer(timestampAuthorities, criteria) {
    return timestampAuthorities.filter((ca) => ca.certChain.length > 0 && core_1.crypto.bufferEqual(ca.certChain[0].serialNumber, criteria.serialNumber) && core_1.crypto.bufferEqual(ca.certChain[0].issuer, criteria.issuer));
  }
});

// ../../node_modules/@sigstore/verify/dist/timestamp/index.js
var require_timestamp3 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.getTSATimestamp = getTSATimestamp;
  exports.getTLogTimestamp = getTLogTimestamp;
  var tsa_1 = require_tsa();
  function getTSATimestamp(timestamp, data, timestampAuthorities) {
    (0, tsa_1.verifyRFC3161Timestamp)(timestamp, data, timestampAuthorities);
    return {
      type: "timestamp-authority",
      logID: timestamp.signerSerialNumber,
      timestamp: timestamp.signingTime
    };
  }
  function getTLogTimestamp(entry) {
    if (!entry.inclusionPromise) {
      return;
    }
    return {
      type: "transparency-log",
      logID: entry.logId.keyId,
      timestamp: new Date(Number(entry.integratedTime) * 1000)
    };
  }
});

// ../../node_modules/@sigstore/protobuf-specs/dist/__generated__/rekor/v2/verifier.js
var require_verifier = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.Signature = exports.Verifier = exports.PublicKey = undefined;
  var sigstore_common_1 = require_sigstore_common();
  exports.PublicKey = {
    fromJSON(object) {
      return { rawBytes: isSet(object.rawBytes) ? Buffer.from(bytesFromBase64(object.rawBytes)) : Buffer.alloc(0) };
    },
    toJSON(message) {
      const obj = {};
      if (message.rawBytes.length !== 0) {
        obj.rawBytes = base64FromBytes(message.rawBytes);
      }
      return obj;
    }
  };
  exports.Verifier = {
    fromJSON(object) {
      return {
        verifier: isSet(object.publicKey) ? { $case: "publicKey", publicKey: exports.PublicKey.fromJSON(object.publicKey) } : isSet(object.x509Certificate) ? { $case: "x509Certificate", x509Certificate: sigstore_common_1.X509Certificate.fromJSON(object.x509Certificate) } : undefined,
        keyDetails: isSet(object.keyDetails) ? (0, sigstore_common_1.publicKeyDetailsFromJSON)(object.keyDetails) : 0
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.verifier?.$case === "publicKey") {
        obj.publicKey = exports.PublicKey.toJSON(message.verifier.publicKey);
      } else if (message.verifier?.$case === "x509Certificate") {
        obj.x509Certificate = sigstore_common_1.X509Certificate.toJSON(message.verifier.x509Certificate);
      }
      if (message.keyDetails !== 0) {
        obj.keyDetails = (0, sigstore_common_1.publicKeyDetailsToJSON)(message.keyDetails);
      }
      return obj;
    }
  };
  exports.Signature = {
    fromJSON(object) {
      return {
        content: isSet(object.content) ? Buffer.from(bytesFromBase64(object.content)) : Buffer.alloc(0),
        verifier: isSet(object.verifier) ? exports.Verifier.fromJSON(object.verifier) : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.content.length !== 0) {
        obj.content = base64FromBytes(message.content);
      }
      if (message.verifier !== undefined) {
        obj.verifier = exports.Verifier.toJSON(message.verifier);
      }
      return obj;
    }
  };
  function bytesFromBase64(b64) {
    return Uint8Array.from(globalThis.Buffer.from(b64, "base64"));
  }
  function base64FromBytes(arr) {
    return globalThis.Buffer.from(arr).toString("base64");
  }
  function isSet(value) {
    return value !== null && value !== undefined;
  }
});

// ../../node_modules/@sigstore/protobuf-specs/dist/__generated__/rekor/v2/dsse.js
var require_dsse3 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.DSSELogEntryV002 = exports.DSSERequestV002 = undefined;
  var envelope_1 = require_envelope();
  var sigstore_common_1 = require_sigstore_common();
  var verifier_1 = require_verifier();
  exports.DSSERequestV002 = {
    fromJSON(object) {
      return {
        envelope: isSet(object.envelope) ? envelope_1.Envelope.fromJSON(object.envelope) : undefined,
        verifiers: globalThis.Array.isArray(object?.verifiers) ? object.verifiers.map((e) => verifier_1.Verifier.fromJSON(e)) : []
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.envelope !== undefined) {
        obj.envelope = envelope_1.Envelope.toJSON(message.envelope);
      }
      if (message.verifiers?.length) {
        obj.verifiers = message.verifiers.map((e) => verifier_1.Verifier.toJSON(e));
      }
      return obj;
    }
  };
  exports.DSSELogEntryV002 = {
    fromJSON(object) {
      return {
        payloadHash: isSet(object.payloadHash) ? sigstore_common_1.HashOutput.fromJSON(object.payloadHash) : undefined,
        signatures: globalThis.Array.isArray(object?.signatures) ? object.signatures.map((e) => verifier_1.Signature.fromJSON(e)) : []
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.payloadHash !== undefined) {
        obj.payloadHash = sigstore_common_1.HashOutput.toJSON(message.payloadHash);
      }
      if (message.signatures?.length) {
        obj.signatures = message.signatures.map((e) => verifier_1.Signature.toJSON(e));
      }
      return obj;
    }
  };
  function isSet(value) {
    return value !== null && value !== undefined;
  }
});

// ../../node_modules/@sigstore/protobuf-specs/dist/__generated__/rekor/v2/hashedrekord.js
var require_hashedrekord = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.HashedRekordLogEntryV002 = exports.HashedRekordRequestV002 = undefined;
  var sigstore_common_1 = require_sigstore_common();
  var verifier_1 = require_verifier();
  exports.HashedRekordRequestV002 = {
    fromJSON(object) {
      return {
        digest: isSet(object.digest) ? Buffer.from(bytesFromBase64(object.digest)) : Buffer.alloc(0),
        signature: isSet(object.signature) ? verifier_1.Signature.fromJSON(object.signature) : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.digest.length !== 0) {
        obj.digest = base64FromBytes(message.digest);
      }
      if (message.signature !== undefined) {
        obj.signature = verifier_1.Signature.toJSON(message.signature);
      }
      return obj;
    }
  };
  exports.HashedRekordLogEntryV002 = {
    fromJSON(object) {
      return {
        data: isSet(object.data) ? sigstore_common_1.HashOutput.fromJSON(object.data) : undefined,
        signature: isSet(object.signature) ? verifier_1.Signature.fromJSON(object.signature) : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.data !== undefined) {
        obj.data = sigstore_common_1.HashOutput.toJSON(message.data);
      }
      if (message.signature !== undefined) {
        obj.signature = verifier_1.Signature.toJSON(message.signature);
      }
      return obj;
    }
  };
  function bytesFromBase64(b64) {
    return Uint8Array.from(globalThis.Buffer.from(b64, "base64"));
  }
  function base64FromBytes(arr) {
    return globalThis.Buffer.from(arr).toString("base64");
  }
  function isSet(value) {
    return value !== null && value !== undefined;
  }
});

// ../../node_modules/@sigstore/protobuf-specs/dist/__generated__/rekor/v2/entry.js
var require_entry = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.CreateEntryRequest = exports.Spec = exports.Entry = undefined;
  var dsse_1 = require_dsse3();
  var hashedrekord_1 = require_hashedrekord();
  exports.Entry = {
    fromJSON(object) {
      return {
        kind: isSet(object.kind) ? globalThis.String(object.kind) : "",
        apiVersion: isSet(object.apiVersion) ? globalThis.String(object.apiVersion) : "",
        spec: isSet(object.spec) ? exports.Spec.fromJSON(object.spec) : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.kind !== "") {
        obj.kind = message.kind;
      }
      if (message.apiVersion !== "") {
        obj.apiVersion = message.apiVersion;
      }
      if (message.spec !== undefined) {
        obj.spec = exports.Spec.toJSON(message.spec);
      }
      return obj;
    }
  };
  exports.Spec = {
    fromJSON(object) {
      return {
        spec: isSet(object.hashedRekordV002) ? { $case: "hashedRekordV002", hashedRekordV002: hashedrekord_1.HashedRekordLogEntryV002.fromJSON(object.hashedRekordV002) } : isSet(object.dsseV002) ? { $case: "dsseV002", dsseV002: dsse_1.DSSELogEntryV002.fromJSON(object.dsseV002) } : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.spec?.$case === "hashedRekordV002") {
        obj.hashedRekordV002 = hashedrekord_1.HashedRekordLogEntryV002.toJSON(message.spec.hashedRekordV002);
      } else if (message.spec?.$case === "dsseV002") {
        obj.dsseV002 = dsse_1.DSSELogEntryV002.toJSON(message.spec.dsseV002);
      }
      return obj;
    }
  };
  exports.CreateEntryRequest = {
    fromJSON(object) {
      return {
        spec: isSet(object.hashedRekordRequestV002) ? {
          $case: "hashedRekordRequestV002",
          hashedRekordRequestV002: hashedrekord_1.HashedRekordRequestV002.fromJSON(object.hashedRekordRequestV002)
        } : isSet(object.dsseRequestV002) ? { $case: "dsseRequestV002", dsseRequestV002: dsse_1.DSSERequestV002.fromJSON(object.dsseRequestV002) } : undefined
      };
    },
    toJSON(message) {
      const obj = {};
      if (message.spec?.$case === "hashedRekordRequestV002") {
        obj.hashedRekordRequestV002 = hashedrekord_1.HashedRekordRequestV002.toJSON(message.spec.hashedRekordRequestV002);
      } else if (message.spec?.$case === "dsseRequestV002") {
        obj.dsseRequestV002 = dsse_1.DSSERequestV002.toJSON(message.spec.dsseRequestV002);
      }
      return obj;
    }
  };
  function isSet(value) {
    return value !== null && value !== undefined;
  }
});

// ../../node_modules/@sigstore/protobuf-specs/dist/rekor/v2/index.js
var require_v2 = __commonJS((exports) => {
  var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() {
        return m[k];
      } };
    }
    Object.defineProperty(o, k2, desc);
  } : function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    o[k2] = m[k];
  });
  var __exportStar = exports && exports.__exportStar || function(m, exports2) {
    for (var p in m)
      if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p))
        __createBinding(exports2, m, p);
  };
  Object.defineProperty(exports, "__esModule", { value: true });
  __exportStar(require_dsse3(), exports);
  __exportStar(require_entry(), exports);
  __exportStar(require_hashedrekord(), exports);
  __exportStar(require_verifier(), exports);
});

// ../../node_modules/@sigstore/verify/dist/tlog/dsse.js
var require_dsse4 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.DSSE_API_VERSION_V1 = undefined;
  exports.verifyDSSETLogBody = verifyDSSETLogBody;
  exports.verifyDSSETLogBodyV2 = verifyDSSETLogBodyV2;
  var error_1 = require_error4();
  exports.DSSE_API_VERSION_V1 = "0.0.1";
  function verifyDSSETLogBody(tlogEntry, content) {
    switch (tlogEntry.apiVersion) {
      case exports.DSSE_API_VERSION_V1:
        return verifyDSSE001TLogBody(tlogEntry, content);
      default:
        throw new error_1.VerificationError({
          code: "TLOG_BODY_ERROR",
          message: `unsupported dsse version: ${tlogEntry.apiVersion}`
        });
    }
  }
  function verifyDSSETLogBodyV2(tlogEntry, content) {
    const spec = tlogEntry.spec?.spec;
    if (!spec) {
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: `missing dsse spec`
      });
    }
    switch (spec.$case) {
      case "dsseV002":
        return verifyDSSE002TLogBody(spec.dsseV002, content);
      default:
        throw new error_1.VerificationError({
          code: "TLOG_BODY_ERROR",
          message: `unsupported version: ${spec.$case}`
        });
    }
  }
  function verifyDSSE001TLogBody(tlogEntry, content) {
    if (tlogEntry.spec.signatures?.length !== 1) {
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: "signature count mismatch"
      });
    }
    const tlogSig = tlogEntry.spec.signatures[0].signature;
    if (!content.compareSignature(Buffer.from(tlogSig, "base64")))
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: "tlog entry signature mismatch"
      });
    const tlogHash = tlogEntry.spec.payloadHash?.value || "";
    if (!content.compareDigest(Buffer.from(tlogHash, "hex"))) {
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: "DSSE payload hash mismatch"
      });
    }
  }
  function verifyDSSE002TLogBody(spec, content) {
    if (spec.signatures?.length !== 1) {
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: "signature count mismatch"
      });
    }
    const tlogSig = spec.signatures[0].content;
    if (!content.compareSignature(tlogSig))
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: "tlog entry signature mismatch"
      });
    const tlogHash = spec.payloadHash?.digest || Buffer.from("");
    if (!content.compareDigest(tlogHash)) {
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: "DSSE payload hash mismatch"
      });
    }
  }
});

// ../../node_modules/@sigstore/verify/dist/tlog/hashedrekord.js
var require_hashedrekord2 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.HASHEDREKORD_API_VERSION_V1 = undefined;
  exports.verifyHashedRekordTLogBody = verifyHashedRekordTLogBody;
  exports.verifyHashedRekordTLogBodyV2 = verifyHashedRekordTLogBodyV2;
  var error_1 = require_error4();
  exports.HASHEDREKORD_API_VERSION_V1 = "0.0.1";
  function verifyHashedRekordTLogBody(tlogEntry, content) {
    switch (tlogEntry.apiVersion) {
      case exports.HASHEDREKORD_API_VERSION_V1:
        return verifyHashedrekord001TLogBody(tlogEntry, content);
      default:
        throw new error_1.VerificationError({
          code: "TLOG_BODY_ERROR",
          message: `unsupported hashedrekord version: ${tlogEntry.apiVersion}`
        });
    }
  }
  function verifyHashedRekordTLogBodyV2(tlogEntry, content) {
    const spec = tlogEntry.spec?.spec;
    if (!spec) {
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: `missing dsse spec`
      });
    }
    switch (spec.$case) {
      case "hashedRekordV002":
        return verifyHashedrekord002TLogBody(spec.hashedRekordV002, content);
      default:
        throw new error_1.VerificationError({
          code: "TLOG_BODY_ERROR",
          message: `unsupported version: ${spec.$case}`
        });
    }
  }
  function verifyHashedrekord001TLogBody(tlogEntry, content) {
    const tlogSig = tlogEntry.spec.signature.content || "";
    if (!content.compareSignature(Buffer.from(tlogSig, "base64"))) {
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: "signature mismatch"
      });
    }
    const tlogDigest = tlogEntry.spec.data.hash?.value || "";
    if (!content.compareSignedDigest(Buffer.from(tlogDigest, "hex"))) {
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: "digest mismatch"
      });
    }
  }
  function verifyHashedrekord002TLogBody(spec, content) {
    const tlogSig = spec.signature?.content || Buffer.from("");
    if (!content.compareSignature(tlogSig)) {
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: "signature mismatch"
      });
    }
    const tlogHash = spec.data?.digest || Buffer.from("");
    if (!content.compareSignedDigest(tlogHash)) {
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: "digest mismatch"
      });
    }
  }
});

// ../../node_modules/@sigstore/verify/dist/tlog/intoto.js
var require_intoto = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.verifyIntotoTLogBody = verifyIntotoTLogBody;
  var error_1 = require_error4();
  function verifyIntotoTLogBody(tlogEntry, content) {
    switch (tlogEntry.apiVersion) {
      case "0.0.2":
        return verifyIntoto002TLogBody(tlogEntry, content);
      default:
        throw new error_1.VerificationError({
          code: "TLOG_BODY_ERROR",
          message: `unsupported intoto version: ${tlogEntry.apiVersion}`
        });
    }
  }
  function verifyIntoto002TLogBody(tlogEntry, content) {
    if (tlogEntry.spec.content.envelope.signatures?.length !== 1) {
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: "signature count mismatch"
      });
    }
    const tlogSig = base64Decode(tlogEntry.spec.content.envelope.signatures[0].sig);
    if (!content.compareSignature(Buffer.from(tlogSig, "base64"))) {
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: "tlog entry signature mismatch"
      });
    }
    const tlogHash = tlogEntry.spec.content.payloadHash?.value || "";
    if (!content.compareDigest(Buffer.from(tlogHash, "hex"))) {
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: "DSSE payload hash mismatch"
      });
    }
  }
  function base64Decode(str) {
    return Buffer.from(str, "base64").toString("utf-8");
  }
});

// ../../node_modules/@sigstore/verify/dist/tlog/checkpoint.js
var require_checkpoint = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.LogCheckpoint = undefined;
  exports.verifyCheckpoint = verifyCheckpoint;
  var core_1 = require_dist3();
  var error_1 = require_error4();
  var CHECKPOINT_SEPARATOR = `

`;
  var SIGNATURE_REGEX = /\u2014 (\S+) (\S+)\n/g;
  function verifyCheckpoint(entry, tlogs) {
    const inclusionProof = entry.inclusionProof;
    const signedNote = SignedNote.fromString(inclusionProof.checkpoint.envelope);
    const checkpoint = LogCheckpoint.fromString(signedNote.note);
    if (!verifySignedNote(signedNote, tlogs)) {
      throw new error_1.VerificationError({
        code: "TLOG_INCLUSION_PROOF_ERROR",
        message: "invalid checkpoint signature"
      });
    }
    return checkpoint;
  }
  function verifySignedNote(signedNote, tlogs) {
    const data = Buffer.from(signedNote.note, "utf-8");
    return signedNote.signatures.some((signature) => {
      const tlog = tlogs.find((tlog2) => core_1.crypto.bufferEqual(tlog2.logID.subarray(0, 4), signature.keyHint) && tlog2.baseURL.includes(signature.name));
      if (!tlog) {
        return false;
      }
      return core_1.crypto.verify(data, tlog.publicKey, signature.signature);
    });
  }

  class SignedNote {
    note;
    signatures;
    constructor(note, signatures) {
      this.note = note;
      this.signatures = signatures;
    }
    static fromString(envelope) {
      if (!envelope.includes(CHECKPOINT_SEPARATOR)) {
        throw new error_1.VerificationError({
          code: "TLOG_INCLUSION_PROOF_ERROR",
          message: "missing checkpoint separator"
        });
      }
      const split = envelope.indexOf(CHECKPOINT_SEPARATOR);
      const header = envelope.slice(0, split + 1);
      const data = envelope.slice(split + CHECKPOINT_SEPARATOR.length);
      const matches = data.matchAll(SIGNATURE_REGEX);
      const signatures = Array.from(matches, (match) => {
        const [, name, signature] = match;
        const sigBytes = Buffer.from(signature, "base64");
        if (sigBytes.length < 5) {
          throw new error_1.VerificationError({
            code: "TLOG_INCLUSION_PROOF_ERROR",
            message: "malformed checkpoint signature"
          });
        }
        return {
          name,
          keyHint: sigBytes.subarray(0, 4),
          signature: sigBytes.subarray(4)
        };
      });
      if (signatures.length === 0) {
        throw new error_1.VerificationError({
          code: "TLOG_INCLUSION_PROOF_ERROR",
          message: "no signatures found in checkpoint"
        });
      }
      return new SignedNote(header, signatures);
    }
  }

  class LogCheckpoint {
    origin;
    logSize;
    logHash;
    rest;
    constructor(origin, logSize, logHash, rest) {
      this.origin = origin;
      this.logSize = logSize;
      this.logHash = logHash;
      this.rest = rest;
    }
    static fromString(note) {
      const lines = note.trimEnd().split(`
`);
      if (lines.length < 3) {
        throw new error_1.VerificationError({
          code: "TLOG_INCLUSION_PROOF_ERROR",
          message: "too few lines in checkpoint header"
        });
      }
      const origin = lines[0];
      let logSize;
      try {
        logSize = BigInt(lines[1]);
      } catch {
        throw new error_1.VerificationError({
          code: "TLOG_INCLUSION_PROOF_ERROR",
          message: "invalid checkpoint log size"
        });
      }
      const rootHash = Buffer.from(lines[2], "base64");
      const rest = lines.slice(3);
      return new LogCheckpoint(origin, logSize, rootHash, rest);
    }
  }
  exports.LogCheckpoint = LogCheckpoint;
});

// ../../node_modules/@sigstore/verify/dist/tlog/merkle.js
var require_merkle = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.verifyMerkleInclusion = verifyMerkleInclusion;
  var core_1 = require_dist3();
  var error_1 = require_error4();
  var RFC6962_LEAF_HASH_PREFIX = Buffer.from([0]);
  var RFC6962_NODE_HASH_PREFIX = Buffer.from([1]);
  function verifyMerkleInclusion(entry, checkpoint) {
    const inclusionProof = entry.inclusionProof;
    let logIndex;
    try {
      logIndex = BigInt(inclusionProof.logIndex);
    } catch {
      throw new error_1.VerificationError({
        code: "TLOG_INCLUSION_PROOF_ERROR",
        message: "invalid inclusion proof log index"
      });
    }
    const treeSize = BigInt(checkpoint.logSize);
    if (logIndex < 0n || logIndex >= treeSize) {
      throw new error_1.VerificationError({
        code: "TLOG_INCLUSION_PROOF_ERROR",
        message: `invalid index: ${logIndex}`
      });
    }
    const { inner, border } = decompInclProof(logIndex, treeSize);
    if (inclusionProof.hashes.length !== inner + border) {
      throw new error_1.VerificationError({
        code: "TLOG_INCLUSION_PROOF_ERROR",
        message: "invalid hash count"
      });
    }
    const innerHashes = inclusionProof.hashes.slice(0, inner);
    const borderHashes = inclusionProof.hashes.slice(inner);
    const leafHash = hashLeaf(entry.canonicalizedBody);
    const calculatedHash = chainBorderRight(chainInner(leafHash, innerHashes, logIndex), borderHashes);
    if (!core_1.crypto.bufferEqual(calculatedHash, checkpoint.logHash)) {
      throw new error_1.VerificationError({
        code: "TLOG_INCLUSION_PROOF_ERROR",
        message: "calculated root hash does not match inclusion proof"
      });
    }
  }
  function decompInclProof(index, size) {
    const inner = innerProofSize(index, size);
    const border = onesCount(index >> BigInt(inner));
    return { inner, border };
  }
  function chainInner(seed, hashes, index) {
    return hashes.reduce((acc, h, i) => {
      if (index >> BigInt(i) & BigInt(1)) {
        return hashChildren(h, acc);
      } else {
        return hashChildren(acc, h);
      }
    }, seed);
  }
  function chainBorderRight(seed, hashes) {
    return hashes.reduce((acc, h) => hashChildren(h, acc), seed);
  }
  function innerProofSize(index, size) {
    return bitLength(index ^ size - BigInt(1));
  }
  function onesCount(num) {
    return num.toString(2).split("1").length - 1;
  }
  function bitLength(n) {
    if (n === 0n) {
      return 0;
    }
    return n.toString(2).length;
  }
  function hashChildren(left, right) {
    return core_1.crypto.digest("sha256", RFC6962_NODE_HASH_PREFIX, left, right);
  }
  function hashLeaf(leaf) {
    return core_1.crypto.digest("sha256", RFC6962_LEAF_HASH_PREFIX, leaf);
  }
});

// ../../node_modules/@sigstore/verify/dist/tlog/set.js
var require_set = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.verifyTLogSET = verifyTLogSET;
  var core_1 = require_dist3();
  var error_1 = require_error4();
  var trust_1 = require_trust();
  function verifyTLogSET(entry, tlogs) {
    const validTLogs = (0, trust_1.filterTLogAuthorities)(tlogs, {
      logID: entry.logId.keyId,
      targetDate: new Date(Number(entry.integratedTime) * 1000)
    });
    const verified = validTLogs.some((tlog) => {
      const payload = toVerificationPayload(entry);
      const data = Buffer.from(core_1.json.canonicalize(payload), "utf8");
      const signature = entry.inclusionPromise.signedEntryTimestamp;
      return core_1.crypto.verify(data, tlog.publicKey, signature);
    });
    if (!verified) {
      throw new error_1.VerificationError({
        code: "TLOG_INCLUSION_PROMISE_ERROR",
        message: "inclusion promise could not be verified"
      });
    }
  }
  function toVerificationPayload(entry) {
    const { integratedTime, logIndex, logId, canonicalizedBody } = entry;
    return {
      body: canonicalizedBody.toString("base64"),
      integratedTime: Number(integratedTime),
      logIndex: Number(logIndex),
      logID: logId.keyId.toString("hex")
    };
  }
});

// ../../node_modules/@sigstore/verify/dist/tlog/index.js
var require_tlog = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.verifyTLogBody = verifyTLogBody;
  exports.verifyTLogInclusion = verifyTLogInclusion;
  var v2_1 = require_v2();
  var error_1 = require_error4();
  var dsse_1 = require_dsse4();
  var hashedrekord_1 = require_hashedrekord2();
  var intoto_1 = require_intoto();
  var checkpoint_1 = require_checkpoint();
  var merkle_1 = require_merkle();
  var set_1 = require_set();
  function verifyTLogBody(entry, sigContent) {
    const { kind, version } = entry.kindVersion;
    let body;
    try {
      body = JSON.parse(entry.canonicalizedBody.toString("utf8"));
    } catch {
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: "invalid canonicalized body"
      });
    }
    if (kind !== body.kind || version !== body.apiVersion) {
      throw new error_1.VerificationError({
        code: "TLOG_BODY_ERROR",
        message: `kind/version mismatch - expected: ${kind}/${version}, received: ${body.kind}/${body.apiVersion}`
      });
    }
    switch (kind) {
      case "dsse":
        if (version == dsse_1.DSSE_API_VERSION_V1) {
          return (0, dsse_1.verifyDSSETLogBody)(body, sigContent);
        } else {
          const entryRekorV2 = v2_1.Entry.fromJSON(body);
          return (0, dsse_1.verifyDSSETLogBodyV2)(entryRekorV2, sigContent);
        }
      case "intoto":
        return (0, intoto_1.verifyIntotoTLogBody)(body, sigContent);
      case "hashedrekord":
        if (version == hashedrekord_1.HASHEDREKORD_API_VERSION_V1) {
          return (0, hashedrekord_1.verifyHashedRekordTLogBody)(body, sigContent);
        } else {
          const entryRekorV2 = v2_1.Entry.fromJSON(body);
          return (0, hashedrekord_1.verifyHashedRekordTLogBodyV2)(entryRekorV2, sigContent);
        }
      default:
        throw new error_1.VerificationError({
          code: "TLOG_BODY_ERROR",
          message: `unsupported kind: ${kind}`
        });
    }
  }
  function verifyTLogInclusion(entry, tlogAuthorities) {
    let inclusionVerified = false;
    if (isTLogEntryWithInclusionPromise(entry)) {
      (0, set_1.verifyTLogSET)(entry, tlogAuthorities);
      inclusionVerified = true;
    }
    if (isTLogEntryWithInclusionProof(entry)) {
      const checkpoint = (0, checkpoint_1.verifyCheckpoint)(entry, tlogAuthorities);
      (0, merkle_1.verifyMerkleInclusion)(entry, checkpoint);
      inclusionVerified = true;
    }
    if (!inclusionVerified) {
      throw new error_1.VerificationError({
        code: "TLOG_MISSING_INCLUSION_ERROR",
        message: "inclusion could not be verified"
      });
    }
    return;
  }
  function isTLogEntryWithInclusionPromise(entry) {
    return entry.inclusionPromise !== undefined;
  }
  function isTLogEntryWithInclusionProof(entry) {
    return entry.inclusionProof !== undefined;
  }
});

// ../../node_modules/@sigstore/verify/dist/verifier.js
var require_verifier2 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.Verifier = undefined;
  var util_1 = __require("util");
  var error_1 = require_error4();
  var key_1 = require_key();
  var policy_1 = require_policy();
  var timestamp_1 = require_timestamp3();
  var tlog_1 = require_tlog();

  class Verifier {
    trustMaterial;
    options;
    constructor(trustMaterial, options = {}) {
      this.trustMaterial = trustMaterial;
      this.options = {
        ctlogThreshold: options.ctlogThreshold ?? 1,
        tlogThreshold: options.tlogThreshold ?? 1,
        timestampThreshold: options.timestampThreshold ?? options.tsaThreshold ?? 1,
        tsaThreshold: 0
      };
    }
    verify(entity, policy) {
      const timestamps = this.verifyTimestamps(entity);
      const signer = this.verifySigningKey(entity, timestamps);
      this.verifyTLogs(entity);
      this.verifySignature(entity, signer);
      if (policy) {
        this.verifyPolicy(policy, signer.identity || {});
      }
      return signer;
    }
    verifyTimestamps(entity) {
      const timestamps = [];
      for (const timestamp of entity.timestamps) {
        switch (timestamp.$case) {
          case "timestamp-authority":
            timestamps.push((0, timestamp_1.getTSATimestamp)(timestamp.timestamp, entity.signature.signature, this.trustMaterial.timestampAuthorities));
            break;
          case "transparency-log": {
            const result = (0, timestamp_1.getTLogTimestamp)(timestamp.tlogEntry);
            if (result) {
              timestamps.push(result);
            }
            break;
          }
        }
      }
      if (containsDupes(timestamps)) {
        throw new error_1.VerificationError({
          code: "TIMESTAMP_ERROR",
          message: "duplicate timestamp"
        });
      }
      if (timestamps.length < this.options.timestampThreshold) {
        throw new error_1.VerificationError({
          code: "TIMESTAMP_ERROR",
          message: `expected ${this.options.timestampThreshold} timestamps, got ${timestamps.length}`
        });
      }
      return timestamps.map((t) => t.timestamp);
    }
    verifySigningKey({ key }, timestamps) {
      switch (key.$case) {
        case "public-key": {
          return (0, key_1.verifyPublicKey)(key.hint, timestamps, this.trustMaterial);
        }
        case "certificate": {
          const result = (0, key_1.verifyCertificate)(key.certificate, timestamps, this.trustMaterial);
          if (containsDupes(result.scts)) {
            throw new error_1.VerificationError({
              code: "CERTIFICATE_ERROR",
              message: "duplicate SCT"
            });
          }
          if (result.scts.length < this.options.ctlogThreshold) {
            throw new error_1.VerificationError({
              code: "CERTIFICATE_ERROR",
              message: `expected ${this.options.ctlogThreshold} SCTs, got ${result.scts.length}`
            });
          }
          return result.signer;
        }
      }
    }
    verifyTLogs({ signature: content, tlogEntries }) {
      const entryIDs = [];
      tlogEntries.forEach((entry) => {
        (0, tlog_1.verifyTLogInclusion)(entry, this.trustMaterial.tlogs);
        (0, tlog_1.verifyTLogBody)(entry, content);
        entryIDs.push({ logID: entry.logId.keyId, logIndex: entry.logIndex });
      });
      if (containsDupes(entryIDs)) {
        throw new error_1.VerificationError({
          code: "TLOG_ERROR",
          message: "duplicate tlog entry"
        });
      }
      if (entryIDs.length < this.options.tlogThreshold) {
        throw new error_1.VerificationError({
          code: "TLOG_ERROR",
          message: `expected ${this.options.tlogThreshold} tlog entries, got ${entryIDs.length}`
        });
      }
    }
    verifySignature(entity, signer) {
      if (!entity.signature.verifySignature(signer.key)) {
        throw new error_1.VerificationError({
          code: "SIGNATURE_ERROR",
          message: "signature verification failed"
        });
      }
    }
    verifyPolicy(policy, identity) {
      if (policy.subjectAlternativeName) {
        (0, policy_1.verifySubjectAlternativeName)(policy.subjectAlternativeName, identity.subjectAlternativeName);
      }
      if (policy.extensions) {
        (0, policy_1.verifyExtensions)(policy.extensions, identity.extensions);
      }
      if (policy.oids) {
        (0, policy_1.verifyOIDs)(policy.oids, identity.oids);
      }
    }
  }
  exports.Verifier = Verifier;
  function containsDupes(arr) {
    for (let i = 0;i < arr.length; i++) {
      for (let j = i + 1;j < arr.length; j++) {
        if ((0, util_1.isDeepStrictEqual)(arr[i], arr[j])) {
          return true;
        }
      }
    }
    return false;
  }
});

// ../../node_modules/@sigstore/verify/dist/index.js
var require_dist4 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.Verifier = exports.toTrustMaterial = exports.VerificationError = exports.PolicyError = exports.toSignedEntity = undefined;
  var bundle_1 = require_bundle2();
  Object.defineProperty(exports, "toSignedEntity", { enumerable: true, get: function() {
    return bundle_1.toSignedEntity;
  } });
  var error_1 = require_error4();
  Object.defineProperty(exports, "PolicyError", { enumerable: true, get: function() {
    return error_1.PolicyError;
  } });
  Object.defineProperty(exports, "VerificationError", { enumerable: true, get: function() {
    return error_1.VerificationError;
  } });
  var trust_1 = require_trust();
  Object.defineProperty(exports, "toTrustMaterial", { enumerable: true, get: function() {
    return trust_1.toTrustMaterial;
  } });
  var verifier_1 = require_verifier2();
  Object.defineProperty(exports, "Verifier", { enumerable: true, get: function() {
    return verifier_1.Verifier;
  } });
});

// src/index.ts
import { spawn as spawn2 } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod as chmod3, readFile as readFile3, realpath, rename as rename2, unlink, writeFile as writeFile3 } from "node:fs/promises";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

// src/client.ts
var DEFAULT_API_URL = "https://api.alpha.candle.tv";
function trimTrailingSlashes(url) {
  return url.trim().replace(/\/+$/, "");
}
function resolveApiUrl(configuredApiUrl, env = process.env) {
  const fromEnv = env.CANDLE_API_URL?.trim();
  const resolved = fromEnv || configuredApiUrl?.trim() || DEFAULT_API_URL;
  return trimTrailingSlashes(resolved);
}
function buildHeaders(opts) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (opts.auth === "device" && opts.credentials.deviceToken) {
    headers.authorization = `Bearer ${opts.credentials.deviceToken}`;
  } else if (opts.auth === "key" && opts.credentials.apiKey) {
    headers["x-api-key"] = opts.credentials.apiKey;
  }
  return headers;
}
function buildUrl(apiUrl, path) {
  const base = trimTrailingSlashes(apiUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}
function parseBody(text) {
  if (text.length === 0)
    return;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function classifyError(status, raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw;
    if (typeof obj.error === "string") {
      const description = typeof obj.error_description === "string" ? obj.error_description : obj.error;
      return { rfcError: obj.error, message: description };
    }
    if (obj.error && typeof obj.error === "object") {
      const errorObj = obj.error;
      const code = typeof errorObj.code === "string" ? errorObj.code : undefined;
      const message = typeof errorObj.message === "string" ? errorObj.message : `Request failed with status ${status}`;
      const uiHint = typeof errorObj.uiHint === "string" ? errorObj.uiHint : undefined;
      const docsPath = typeof errorObj.docsPath === "string" ? errorObj.docsPath : undefined;
      return { code, message, ...uiHint ? { uiHint } : {}, ...docsPath ? { docsPath } : {} };
    }
  }
  return { message: `Request failed with status ${status}` };
}
async function apiRequest(path, opts) {
  const url = buildUrl(opts.apiUrl, path);
  const headers = buildHeaders(opts);
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const doFetch = opts.fetch ?? fetch;
  let response;
  try {
    response = await doFetch(url, {
      method: opts.method ?? "GET",
      headers,
      body
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const env = opts.env ?? process.env;
    const envOverride = env.CANDLE_API_URL?.trim();
    return {
      ok: false,
      status: 0,
      message: `Could not reach ${url}: ${reason} (set CANDLE_API_URL to override; ${envOverride ? `currently "${envOverride}"` : "currently unset"})`,
      raw: undefined
    };
  }
  const text = await response.text();
  const raw = parseBody(text);
  if (response.ok) {
    return { ok: true, status: response.status, body: raw };
  }
  const classified = classifyError(response.status, raw);
  return { ok: false, status: response.status, raw, ...classified };
}

// src/commands/auth.ts
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// src/account.ts
async function fetchAccount(deps, apiUrl, apiKey) {
  const identity = await apiRequest("/api/v1/agent/wallets/embedded", {
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  const account = identity.ok ? identity.body.account : undefined;
  if (account)
    return { account };
  return { failure: identity.ok ? "no account in the response" : identity.message };
}

// src/args.ts
function parseArgs(args, spec) {
  const valueFlags = new Set(spec.valueFlags ?? []);
  const booleanFlags = new Set(spec.booleanFlags ?? []);
  const values = {};
  const booleans = new Set;
  const positionals = [];
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined)
      continue;
    if (valueFlags.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("-"))
        return { error: `${arg} requires a value` };
      values[arg] = value;
    } else if (booleanFlags.has(arg)) {
      booleans.add(arg);
    } else if (arg.startsWith("-")) {
      return { error: `Unknown flag: ${arg}` };
    } else {
      positionals.push(arg);
    }
  }
  return { values, booleans, positionals };
}
function parseScopesList(raw) {
  return raw.split(",").map((scope) => scope.trim()).filter(Boolean);
}
function parseUsdToMicros(raw) {
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (cleaned.length === 0)
    return { ok: false, message: "--tx-limit requires a dollar amount, for example 100." };
  const usd = Number(cleaned);
  if (!Number.isFinite(usd))
    return { ok: false, message: `--tx-limit is not a dollar amount: ${raw}` };
  const usdMicros = Math.round(usd * 1e6);
  if (usdMicros <= 0)
    return { ok: false, message: "--tx-limit must be greater than $0." };
  return { ok: true, usdMicros };
}
var TX_LIMIT_RESETS = ["daily", "weekly", "monthly", "never"];
function parseExpiresInDays(raw) {
  const days = Number(raw.trim());
  if (!Number.isInteger(days) || days <= 0) {
    return { ok: false, message: `--expires-in must be a positive whole number of days, got: ${raw}` };
  }
  return { ok: true, days };
}

// src/render.ts
var ALL_AGENT_SCOPES = [
  "launch:write",
  "launch:read",
  "activity:write",
  "swap:write",
  "transfer:write"
];
var DEFAULT_AGENT_SCOPES = ALL_AGENT_SCOPES.filter((scope) => scope !== "swap:write" && scope !== "transfer:write");
var SWAP_WRITE_NOTE = "moves funds -- this key can execute swaps on your behalf";
var TRANSFER_WRITE_NOTE = "moves funds -- this key can transfer assets between your wallets";
function formatScopesForSummary(scopes) {
  return scopes.map((scope) => scope === "swap:write" ? `${scope} (${SWAP_WRITE_NOTE})` : scope === "transfer:write" ? `${scope} (${TRANSFER_WRITE_NOTE})` : scope).join(", ");
}
function renderTable(headers, rows) {
  const widths = headers.map((header, col) => Math.max(header.length, ...rows.map((row) => (row[col] ?? "").length)));
  const line = (cells) => cells.map((cell, col) => col === cells.length - 1 ? cell ?? "" : (cell ?? "").padEnd(widths[col] ?? 0)).join("  ");
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [line(headers), separator, ...rows.map(line)].join(`
`);
}
function formatTimestamp(ms, whenAbsent = "never") {
  return ms === undefined ? whenAbsent : new Date(ms).toISOString();
}
function renderError(result, ctx) {
  if (result.code === "DEVICE_TOKEN_INVALID") {
    return "This device was revoked or its token is stale. Run: candle auth login";
  }
  if (result.status === 403 && result.code === "SCOPE_MISSING") {
    return `${result.message}. Mint one that has it with: candle keys create --scopes <a,b,c>, or check an existing key's scopes with: candle keys list`;
  }
  if (result.status === 401 && ctx.authType === "key") {
    return "API key invalid or revoked. Run: candle keys create";
  }
  if (result.status === 0) {
    return `Could not reach ${ctx.apiUrl}. Set CANDLE_API_URL to override the API endpoint.`;
  }
  return result.message;
}
function suggestionFor(result, ctx) {
  if (result.code === "DEVICE_TOKEN_INVALID")
    return "Run: candle auth login";
  if (result.status === 403 && result.code === "SCOPE_MISSING") {
    return "Mint a key that has it: candle keys create --scopes <a,b,c>, or check an existing key's scopes: candle keys list";
  }
  if (result.status === 401 && ctx.authType === "key")
    return "Run: candle keys create";
  if (result.status === 0)
    return "Set CANDLE_API_URL to override the API endpoint.";
  return result.uiHint;
}
function errorEnvelope(result, ctx) {
  const code = result.code ?? result.rfcError ?? (result.status === 0 ? "NETWORK_UNREACHABLE" : `HTTP_${result.status}`);
  const message = result.status === 0 ? `Could not reach ${ctx.apiUrl}.` : result.message;
  const suggestion = suggestionFor(result, ctx);
  const docsUrl = result.docsPath ? `https://docs.candle.tv/${result.docsPath}` : undefined;
  return {
    ok: false,
    code,
    status: result.status,
    message,
    ...suggestion ? { suggestion } : {},
    ...docsUrl ? { docsUrl } : {}
  };
}
function writeFailure(deps, result, ctx, json) {
  if (json)
    deps.stdout.write(`${JSON.stringify(errorEnvelope(result, ctx))}
`);
  else
    deps.stderr.write(`${renderError(result, ctx)}
`);
}
function writeLocalFailure(deps, failure, json) {
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ok: false, ...failure })}
`);
    return;
  }
  const separator = failure.suggestion?.includes(`
`) ? `
` : " ";
  deps.stderr.write(`${failure.suggestion ? `${failure.message}${separator}${failure.suggestion}` : failure.message}
`);
}
function writeUsageFailure(deps, message, json) {
  if (json)
    deps.stdout.write(`${JSON.stringify({ ok: false, code: "USAGE", message })}
`);
  else
    deps.stderr.write(`${message}
`);
}
function portalDeviceUrl(apiUrl, portalOrigin) {
  if (portalOrigin) {
    try {
      return `${new URL(portalOrigin).origin}/dev/agent`;
    } catch {}
  }
  try {
    const url = new URL(apiUrl);
    const labels = url.hostname.split(".");
    const apiLabel = labels.indexOf("api");
    if (apiLabel !== -1 && labels.length > 1) {
      labels.splice(apiLabel, 1);
      url.hostname = labels.join(".");
    }
    return `${url.origin}/dev/agent`;
  } catch {
    return `${apiUrl}/dev/agent`;
  }
}

// src/checks.ts
async function runLiveCheck(params) {
  const { deps, apiUrl, path, auth, credential, check, passDetail } = params;
  const result = await apiRequest(path, {
    auth,
    credentials: auth === "device" ? { deviceToken: credential } : { apiKey: credential },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  return result.ok ? { check, state: "PASS", detail: passDetail } : { check, state: "FAIL", detail: renderError(result, { apiUrl, authType: auth }) };
}

// src/profiles.ts
function profileSecretRef(name, kind) {
  return `profile:${name}:${kind === "deviceToken" ? "device_token" : "api_key"}`;
}
function isValidProfileName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name);
}
function listForHumans(profiles, active) {
  return Object.entries(profiles).map(([name, p]) => `  ${name}${name === active ? " (active)" : ""}${p.account ? `  ${p.account}` : ""}${p.apiUrl ? `  ${p.apiUrl}` : ""}`).join(`
`);
}
function resolveProfileName(config, opts) {
  const profiles = config.profiles ?? {};
  const names = Object.keys(profiles);
  const requested = opts.flag?.trim() || opts.env.CANDLE_PROFILE?.trim() || undefined;
  if (requested !== undefined) {
    if (!isValidProfileName(requested))
      return { ok: false, message: `Invalid profile name: ${requested}` };
    if (!(requested in profiles)) {
      return {
        ok: false,
        message: `No profile named "${requested}".${names.length ? `
Profiles on this machine:
${listForHumans(profiles, config.activeProfile)}` : " Run: candle auth login --profile " + requested}`
      };
    }
    return { ok: true, name: requested };
  }
  if (config.activeProfile && config.activeProfile in profiles)
    return { ok: true, name: config.activeProfile };
  if (names.length === 0)
    return { ok: true, name: undefined };
  if (names.length === 1)
    return { ok: true, name: names[0] };
  return {
    ok: false,
    message: `Several profiles exist and none is selected. Pick one with --profile <name> or CANDLE_PROFILE=<name>:
${listForHumans(profiles, config.activeProfile)}`
  };
}
function resolveProfileNameForLogin(config, opts) {
  const profiles = config.profiles ?? {};
  const requested = opts.flag?.trim() || opts.env.CANDLE_PROFILE?.trim() || undefined;
  if (requested !== undefined) {
    if (!isValidProfileName(requested))
      return { ok: false, message: `Invalid profile name: ${requested}` };
    return { ok: true, name: requested };
  }
  if (config.activeProfile && config.activeProfile in profiles)
    return { ok: true, name: config.activeProfile };
  const names = Object.keys(profiles);
  return { ok: true, name: names.length === 1 ? names[0] : undefined };
}
var PRE_PROFILE_FIELDS = ["apiUrl", "keyPrefix", "deviceTokenPrefix", "scopes", "label", "portalOrigin"];
function migratedConfig(config) {
  if (config.profiles !== undefined)
    return { config, migrated: false };
  const legacy = {};
  for (const field of PRE_PROFILE_FIELDS) {
    const value = config[field];
    if (value !== undefined)
      legacy[field] = value;
  }
  if (Object.keys(legacy).length === 0)
    return { config, migrated: false };
  return { config: { ...config, profiles: { default: legacy }, activeProfile: "default" }, migrated: true };
}
function effectiveProfileFields(config, profile) {
  if (profile !== undefined)
    return config.profiles?.[profile] ?? {};
  const legacy = {};
  for (const field of PRE_PROFILE_FIELDS) {
    const value = config[field];
    if (value !== undefined)
      legacy[field] = value;
  }
  return legacy;
}
function defaultProfileNameFor(apiUrl, existing) {
  let host = "profile";
  try {
    host = new URL(apiUrl).hostname;
  } catch {}
  let base;
  if (host === "staging.api.candle.tv")
    base = "staging";
  else if (host === "api.candle.tv" || host === "api.alpha.candle.tv")
    base = "production";
  else
    base = host.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\./g, "-").slice(0, 28) || "profile";
  if (!isValidProfileName(base))
    base = "profile";
  const taken = new Set(Object.keys(existing ?? {}));
  if (!taken.has(base))
    return base;
  for (let n = 2;; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate))
      return candidate;
  }
}
function credentialEnvOverrides(env) {
  return ["CANDLE_API_KEY", "CANDLE_DEVICE_TOKEN"].filter((name) => env[name]?.trim());
}
function identityLine(profile, account, apiUrl, overrides) {
  const shown = overrides?.length ? `unknown (${overrides.join(", ")} override)` : account ?? "unknown";
  return `Profile: ${profile ?? "none"}   Account: ${shown} at ${apiUrl}`;
}
async function printIdentity(ctx) {
  if (ctx.json)
    return;
  const config = await ctx.deps.readConfig();
  const account = effectiveProfileFields(config, ctx.profile).account;
  ctx.deps.stdout.write(`${identityLine(ctx.profile, account, ctx.apiUrl, credentialEnvOverrides(ctx.deps.env))}
`);
}
function formatCacheAge(now, cachedAt) {
  if (cachedAt === undefined)
    return "not cached";
  const seconds = Math.max(0, Math.floor((now - cachedAt) / 1000));
  if (seconds < 60)
    return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
function profileTable(config, now) {
  return Object.entries(config.profiles ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, p]) => ({
    name,
    active: config.activeProfile === name,
    account: p.account,
    cachedAge: p.account !== undefined && p.accountCachedAt === undefined ? "age unknown" : formatCacheAge(now, p.accountCachedAt),
    apiUrl: p.apiUrl,
    keyPrefix: p.keyPrefix
  }));
}

// src/secret-store.ts
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var SECRET_REFS = {
  deviceToken: "device_token",
  apiKey: "api_key"
};
function walletSignerRef(walletId) {
  return `wallet_signer_${walletId}`;
}
function pemToStoredSigner(pem) {
  return pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
}
function configDir() {
  return process.env.CANDLE_CONFIG_DIR?.trim() || join(homedir(), ".config", "candle");
}
function defaultCredentialsPath() {
  return join(configDir(), "credentials.enc");
}
var PBKDF2_ITERATIONS = 210000;
var SALT_LENGTH_BYTES = 16;
var IV_LENGTH_BYTES = 12;
async function deriveKey(passphrase, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey"
  ]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

class EncryptedFileSecretStore {
  path;
  iterations;
  cachedPassphrase;
  constructor(options = {}) {
    this.path = options.path ?? defaultCredentialsPath();
    this.iterations = options.iterations ?? PBKDF2_ITERATIONS;
  }
  async get(ref) {
    const passphrase = await this.resolvePassphrase();
    const contents = await this.readContents();
    const entry = contents[ref];
    if (!entry)
      return null;
    const salt = fromBase64(entry.salt);
    const key = await deriveKey(passphrase, salt, entry.iterations);
    const iv = fromBase64(entry.iv);
    const ciphertext = fromBase64(entry.ciphertext);
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    } catch {
      throw new Error(`Could not decrypt the credential for "${ref}" in ${this.path}. CANDLE_KEYRING_PASSPHRASE is likely wrong for this file.`);
    }
    return new TextDecoder().decode(plaintext);
  }
  async set(ref, value) {
    const passphrase = await this.resolvePassphrase();
    const contents = await this.readContents();
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
    const key = await deriveKey(passphrase, salt, this.iterations);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
    contents[ref] = {
      salt: toBase64(salt),
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
      iterations: this.iterations
    };
    await this.writeContents(contents);
  }
  async delete(ref) {
    await this.resolvePassphrase();
    const contents = await this.readContents();
    if (!(ref in contents))
      return;
    delete contents[ref];
    await this.writeContents(contents);
  }
  async resolvePassphrase() {
    if (this.cachedPassphrase !== undefined)
      return this.cachedPassphrase;
    const fromEnv = process.env.CANDLE_KEYRING_PASSPHRASE;
    if (fromEnv) {
      this.cachedPassphrase = fromEnv;
      return fromEnv;
    }
    if (process.stdin.isTTY) {
      const prompted = await promptHiddenPassphrase("Passphrase for Candle credential store: ");
      this.cachedPassphrase = prompted;
      return prompted;
    }
    throw new Error("No keychain available and no CANDLE_KEYRING_PASSPHRASE set; set it to use the encrypted file store on this machine");
  }
  async readContents() {
    let raw;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if (err.code === "ENOENT")
        return {};
      throw err;
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`The credentials file at ${this.path} is not valid JSON and cannot be read. Delete it and re-run ` + "the command that stores your device token / API key to recreate it.");
    }
  }
  async writeContents(contents) {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 448);
    const tmpPath = `${this.path}.tmp`;
    await writeFile(tmpPath, JSON.stringify(contents, null, 2), { encoding: "utf8", mode: 384 });
    await chmod(tmpPath, 384);
    await rename(tmpPath, this.path);
  }
}
async function promptHiddenSecret(promptText) {
  if (!process.stdin.isTTY) {
    throw new Error("No TTY available for interactive input; pass --key-file instead");
  }
  return promptHiddenPassphrase(promptText);
}
async function promptHiddenPassphrase(promptText) {
  const readline = await import("node:readline");
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const rlInternals = rl;
    rlInternals._writeToOutput = (text) => {
      if (text === promptText)
        process.stdout.write(text);
    };
    rl.question(promptText, (answer) => {
      rl.close();
      process.stdout.write(`
`);
      resolve(answer);
    });
  });
}
function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}
function fromBase64(base64) {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

// src/deps.ts
async function resolveDeviceToken(deps, profile) {
  const fromEnv = deps.env.CANDLE_DEVICE_TOKEN?.trim();
  if (fromEnv)
    return fromEnv;
  const ref = profile ? profileSecretRef(profile, "deviceToken") : SECRET_REFS.deviceToken;
  const stored = await deps.store.get(ref);
  return stored ?? undefined;
}
async function resolveApiKey(deps, profile) {
  const fromEnv = deps.env.CANDLE_API_KEY?.trim();
  if (fromEnv)
    return fromEnv;
  const ref = profile ? profileSecretRef(profile, "apiKey") : SECRET_REFS.apiKey;
  const stored = await deps.store.get(ref);
  return stored ?? undefined;
}

// src/version.ts
var CLI_VERSION = "0.5.0";

// src/commands/auth.ts
var DEVICE_CODE_PATH = "/api/v1/agent/device/code";
var DEVICE_TOKEN_PATH = "/api/v1/agent/device/token";
var MAX_CLIENT_NAME_LENGTH = 64;
async function authLogin(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, { valueFlags: ["--scopes", "--label"], booleanFlags: ["--no-browser"] });
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  if (ctx.profileFlag !== undefined && !isValidProfileName(ctx.profileFlag)) {
    writeUsageFailure(deps, `Invalid profile name: ${ctx.profileFlag}. Run: candle auth login --profile <name>`, json);
    return 2;
  }
  const scopes = parsed.values["--scopes"] ? parseScopesList(parsed.values["--scopes"]) : undefined;
  const label = parsed.values["--label"];
  const noBrowser = parsed.booleans.has("--no-browser");
  if (label !== undefined && label.length > MAX_CLIENT_NAME_LENGTH) {
    deps.stderr.write(`--label must be at most ${MAX_CLIENT_NAME_LENGTH} characters (got ${label.length}). Shorten it and run: candle auth login --label <name>
`);
    return 2;
  }
  const clientName = (label ?? `candle-cli/${CLI_VERSION}@${deps.hostname}`).slice(0, MAX_CLIENT_NAME_LENGTH);
  const codeResult = await apiRequest(DEVICE_CODE_PATH, {
    method: "POST",
    auth: "none",
    credentials: {},
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
    body: { clientName, ...scopes ? { scopes } : {} }
  });
  if (!codeResult.ok) {
    writeFailure(deps, codeResult, { apiUrl, authType: "none" }, json);
    return 1;
  }
  const code = codeResult.body;
  const progress = json ? deps.stderr : deps.stdout;
  progress.write(`Your device code: ${code.userCode}
`);
  progress.write(`Open this URL to approve: ${code.verificationUriComplete}
`);
  if (!noBrowser) {
    try {
      deps.openBrowser(code.verificationUriComplete);
    } catch {}
  }
  const expiresAtMs = deps.now() + code.expiresIn * 1000;
  let interval = code.interval;
  while (deps.now() < expiresAtMs) {
    await deps.sleep(interval * 1000);
    const tokenResult = await apiRequest(DEVICE_TOKEN_PATH, {
      method: "POST",
      auth: "none",
      credentials: {},
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
      body: { deviceCode: code.deviceCode }
    });
    if (tokenResult.ok) {
      return finishLogin(tokenResult.body, ctx, { scopes, label, verificationUri: code.verificationUri });
    }
    if (tokenResult.rfcError === "authorization_pending")
      continue;
    if (tokenResult.rfcError === "slow_down") {
      interval += 5;
      continue;
    }
    if (tokenResult.rfcError === "access_denied" || tokenResult.rfcError === "expired_token" || tokenResult.rfcError === "invalid_grant") {
      if (json)
        deps.stderr.write(`${JSON.stringify(tokenResult)}
`);
      else
        deps.stderr.write(`${terminalRfcMessage(tokenResult.rfcError)}
`);
      return 1;
    }
    writeFailure(deps, tokenResult, { apiUrl, authType: "none" }, json);
    return 1;
  }
  if (json)
    deps.stderr.write(`${JSON.stringify({ ok: false, reason: "expired_token" })}
`);
  else
    deps.stderr.write(`${terminalRfcMessage("expired_token")}
`);
  return 1;
}
function terminalRfcMessage(rfcError) {
  if (rfcError === "access_denied")
    return "Authorization was denied.";
  if (rfcError === "expired_token")
    return "The device code expired before it was approved. Run: candle auth login";
  return "This device code is unknown or was already used. Run: candle auth login";
}
function portalOriginFrom(verificationUri) {
  if (!verificationUri)
    return;
  try {
    return new URL(verificationUri).origin;
  } catch {
    return;
  }
}
async function finishLogin(rawBody, ctx, requested) {
  const { deps, json } = ctx;
  const body = rawBody;
  const config = await deps.readConfig();
  const profileName = ctx.profileFlag ?? ctx.profile ?? defaultProfileNameFor(ctx.apiUrl, config.profiles);
  await deps.store.set(profileSecretRef(profileName, "deviceToken"), body.deviceToken);
  if (body.apiKey)
    await deps.store.set(profileSecretRef(profileName, "apiKey"), body.apiKey.key);
  let account;
  if (body.apiKey)
    account = (await fetchAccount(deps, ctx.apiUrl, body.apiKey.key)).account;
  const portalOrigin = portalOriginFrom(requested.verificationUri);
  await deps.updateProfile(profileName, {
    apiUrl: ctx.apiUrl,
    deviceTokenPrefix: body.tokenPrefix,
    ...body.apiKey ? { keyPrefix: body.apiKey.keyPrefix, scopes: body.apiKey.scopes } : {},
    ...requested.label ? { label: requested.label } : {},
    ...portalOrigin ? { portalOrigin } : {},
    ...account ? { account, accountCachedAt: deps.now() } : {}
  });
  if (!config.activeProfile)
    await deps.writeConfig({ activeProfile: profileName });
  if (json) {
    deps.stdout.write(`${JSON.stringify({
      backend: deps.backend,
      profile: profileName,
      account,
      deviceTokenPrefix: body.tokenPrefix,
      apiKeyPrefix: body.apiKey?.keyPrefix,
      scopes: body.apiKey?.scopes,
      apiKeyError: body.apiKeyError
    })}
`);
    return 0;
  }
  deps.stdout.write(`Profile: ${profileName}
`);
  deps.stdout.write(`Device authorized. Credentials stored in the ${deps.backend} backend.
`);
  deps.stdout.write(`Device token prefix: ${body.tokenPrefix}
`);
  if (body.apiKey) {
    deps.stdout.write(`API key prefix: ${body.apiKey.keyPrefix}
`);
    deps.stdout.write(`Granted scopes: ${formatScopesForSummary(body.apiKey.scopes)}
`);
  } else if (body.apiKeyError) {
    const authorizedScopes = requested.scopes ?? [...ALL_AGENT_SCOPES];
    deps.stdout.write(`Authorized scopes (no key issued yet): ${formatScopesForSummary(authorizedScopes)}
`);
    deps.stdout.write(`${body.apiKeyError}
`);
    deps.stdout.write(`Run: candle keys create
`);
  }
  return 0;
}
async function authLogout(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, { booleanFlags: ["--keep-key"] });
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const keepKey = parsed.booleans.has("--keep-key");
  await printIdentity(ctx);
  const config = await deps.readConfig();
  const { keyPrefix, portalOrigin } = effectiveProfileFields(config, ctx.profile);
  const deviceToken = await resolveDeviceToken(deps, ctx.profile);
  let revokedKey;
  if (!keepKey && deviceToken && keyPrefix) {
    const result = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}`, {
      method: "DELETE",
      auth: "device",
      credentials: { deviceToken },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env
    });
    if (result.ok) {
      revokedKey = keyPrefix;
    } else if (!json) {
      deps.stdout.write(`Could not revoke the stored API key remotely (clearing it locally anyway).
`);
    }
  }
  if (ctx.profile) {
    await deps.store.delete(profileSecretRef(ctx.profile, "deviceToken"));
    await deps.store.delete(profileSecretRef(ctx.profile, "apiKey"));
    await deps.store.delete(SECRET_REFS.deviceToken);
    await deps.store.delete(SECRET_REFS.apiKey);
    const profiles = { ...config.profiles ?? {} };
    delete profiles[ctx.profile];
    await deps.writeConfig({
      profiles,
      keyPrefix: undefined,
      deviceTokenPrefix: undefined,
      scopes: undefined,
      ...config.activeProfile === ctx.profile ? { activeProfile: undefined } : {}
    });
  } else {
    await deps.store.delete(SECRET_REFS.deviceToken);
    await deps.store.delete(SECRET_REFS.apiKey);
    await deps.clearConfig();
  }
  const portalUrl = portalDeviceUrl(apiUrl, portalOrigin);
  const liveEnvOverrides = credentialEnvOverrides(deps.env);
  if (json) {
    deps.stdout.write(`${JSON.stringify({ success: true, revokedKey: revokedKey ?? null, portalUrl, envOverrides: liveEnvOverrides })}
`);
    return 0;
  }
  deps.stdout.write(`Local credentials cleared.
`);
  if (liveEnvOverrides.length > 0) {
    deps.stdout.write(`Still set in this shell: ${liveEnvOverrides.join(", ")}. Those beat the store, so they remain live until you unset them.
`);
  }
  deps.stdout.write(`The device token itself is session-only to revoke -- that is intentional (a stolen token cannot read device metadata or revoke a sibling device). Sign in to the portal to revoke it there.
`);
  deps.stdout.write(`Portal: ${portalUrl}
`);
  return 0;
}
function configFilePathForDisplay(env) {
  const dir = env.CANDLE_CONFIG_DIR?.trim() || join2(homedir2(), ".config", "candle");
  return join2(dir, "config.json");
}
async function authStatus(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const config = await deps.readConfig();
  const deviceToken = await resolveDeviceToken(deps, ctx.profile);
  const apiKey = await resolveApiKey(deps, ctx.profile);
  const rows = [];
  if (!deviceToken) {
    rows.push({ check: "Device token", state: "SKIP", detail: "not set. Run: candle auth login" });
  } else {
    rows.push(await runLiveCheck({
      deps,
      apiUrl,
      path: "/api/v1/agent/keys",
      auth: "device",
      credential: deviceToken,
      check: "Device token",
      passDetail: "valid"
    }));
  }
  if (!apiKey) {
    rows.push({ check: "API key", state: "SKIP", detail: "not set. Run: candle keys create" });
  } else {
    rows.push(await runLiveCheck({
      deps,
      apiUrl,
      path: "/api/v1/agent/tier",
      auth: "key",
      credential: apiKey,
      check: "API key",
      passDetail: "valid"
    }));
  }
  let account;
  if (apiKey)
    account = (await fetchAccount(deps, apiUrl, apiKey)).account;
  const exitCode = rows.some((row) => row.state === "FAIL") ? 1 : 0;
  const configPath = configFilePathForDisplay(deps.env);
  const fields = effectiveProfileFields(config, ctx.profile);
  const cachedAccount = ctx.profile !== undefined ? fields.account : undefined;
  const mismatch = ctx.profile !== undefined && account !== undefined && cachedAccount !== undefined && account !== cachedAccount && credentialEnvOverrides(deps.env).length === 0;
  if (json) {
    deps.stdout.write(`${JSON.stringify({
      backend: deps.backend,
      profile: ctx.profile,
      deviceTokenPrefix: fields.deviceTokenPrefix,
      keyPrefix: fields.keyPrefix,
      account,
      cachedAccount,
      apiUrl,
      configPath,
      rows
    })}
`);
    return exitCode;
  }
  deps.stdout.write(`${identityLine(ctx.profile, account ?? fields.account, apiUrl)}
`);
  if (mismatch) {
    deps.stdout.write(`Profile ${ctx.profile} recorded ${cachedAccount}; this key belongs to ${account}. Run: candle profile use ${ctx.profile}
`);
  }
  deps.stdout.write(`Backend: ${deps.backend}
`);
  deps.stdout.write(`Device token prefix: ${fields.deviceTokenPrefix ?? "not set"}
`);
  deps.stdout.write(`API key prefix: ${fields.keyPrefix ?? "not set"}
`);
  deps.stdout.write(`Config file: ${configPath}

`);
  deps.stdout.write(`${renderTable(["Check", "Status", "Detail"], rows.map((row) => [row.check, row.state, row.detail]))}
`);
  return exitCode;
}

// src/release.ts
var RELEASE_BASE_URL = "https://github.com/candledottv/agentic";
var RELEASE_ISSUER = "https://token.actions.githubusercontent.com";
var VERSION = /^\d+\.\d+\.\d+$/;
function releaseIdentityUri(version) {
  if (!VERSION.test(version))
    throw new Error(`invalid release version: ${version}`);
  return `https://github.com/candledottv/agentic/.github/workflows/release.yaml@refs/tags/cli-v${version}`;
}
function compareVersions(a, b) {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0;i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y)
      return -1;
    if (x > y)
      return 1;
  }
  return 0;
}
function platformKey(platform, arch) {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!os || !cpu)
    return null;
  return `${os}-${cpu}`;
}
function detectInstall(execPath, realExecPath) {
  const base = execPath.split("/").pop() ?? "";
  if (base === "node" || base === "bun" || base === "node.exe" || base === "bun.exe")
    return "script";
  if (/\/Cellar\/candle\//.test(realExecPath))
    return "homebrew";
  return "binary";
}
function latestUrl(baseUrl) {
  return `${baseUrl}/releases/latest/download/latest.json`;
}
function assetUrl(baseUrl, tag, name) {
  return `${baseUrl}/releases/download/${tag}/${name}`;
}
async function fetchLatest(deps, baseUrl) {
  let res;
  try {
    res = await deps.fetch(latestUrl(baseUrl), { redirect: "follow" });
  } catch (error) {
    return {
      ok: false,
      kind: "unreachable",
      message: `Could not reach ${latestUrl(baseUrl)}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!res.ok)
    return { ok: false, kind: "unreachable", message: `${latestUrl(baseUrl)} answered ${res.status}` };
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, kind: "invalid", message: "The release manifest is not JSON" };
  }
  const manifest = body;
  if (typeof manifest.version !== "string" || typeof manifest.tag !== "string" || typeof manifest.assets !== "object" || manifest.assets === null) {
    return { ok: false, kind: "invalid", message: "The release manifest has no version, tag or assets" };
  }
  return { ok: true, manifest };
}
function releaseBaseUrl(env) {
  const override = env.CANDLE_RELEASE_BASE_URL?.trim();
  return override ? override.replace(/\/$/, "") : RELEASE_BASE_URL;
}

// src/commands/doctor.ts
var MIN_NODE_MAJOR = 18;
var API_KEY_CHECK = "API key valid (launch:write)";
async function doctor(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const rows = [];
  const fields = effectiveProfileFields(await deps.readConfig(), ctx.profile);
  const nodeMajor = Number(deps.nodeVersion.split(".")[0]);
  rows.push(Number.isFinite(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR ? { check: "Runtime version", state: "PASS", detail: `node ${deps.nodeVersion}` } : {
    check: "Runtime version",
    state: "FAIL",
    detail: `node ${deps.nodeVersion} is below the minimum (${MIN_NODE_MAJOR}). Fix: upgrade Node.js to ${MIN_NODE_MAJOR} or later.`
  });
  rows.push({ check: "Keychain backend", state: "PASS", detail: deps.backend });
  const deviceToken = await resolveDeviceToken(deps, ctx.profile);
  const apiKey = await resolveApiKey(deps, ctx.profile);
  rows.push(deviceToken ? {
    check: "Credentials present",
    state: "PASS",
    detail: apiKey ? "device token and API key" : "device token only (no API key yet)"
  } : { check: "Credentials present", state: "FAIL", detail: "No device token found. Fix: run candle auth login." });
  const statusResult = await apiRequest("/api/v1/status", {
    auth: "none",
    credentials: {},
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  rows.push(statusResult.ok ? { check: "API reachable", state: "PASS", detail: apiUrl } : { check: "API reachable", state: "FAIL", detail: renderError(statusResult, { apiUrl, authType: "none" }) });
  if (!deviceToken) {
    rows.push({ check: "Device token valid", state: "SKIP", detail: "no device token to check" });
  } else {
    rows.push(await runLiveCheck({
      deps,
      apiUrl,
      path: "/api/v1/agent/keys",
      auth: "device",
      credential: deviceToken,
      check: "Device token valid",
      passDetail: "valid"
    }));
  }
  if (!apiKey) {
    rows.push({ check: API_KEY_CHECK, state: "SKIP", detail: "no API key to check" });
  } else {
    const scopes = fields.scopes;
    const passDetail = scopes ? `scopes: ${scopes.join(", ")}` : "valid";
    rows.push(await runLiveCheck({
      deps,
      apiUrl,
      path: "/api/v1/agent/tier",
      auth: "key",
      credential: apiKey,
      check: API_KEY_CHECK,
      passDetail
    }));
  }
  let account;
  if (!apiKey) {
    rows.push({ check: "Launch wallet delegated", state: "SKIP", detail: "no API key to check" });
  } else {
    const result = await apiRequest("/api/v1/agent/wallets/embedded", {
      auth: "key",
      credentials: { apiKey },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env
    });
    if (!result.ok) {
      rows.push({
        check: "Launch wallet delegated",
        state: "FAIL",
        detail: renderError(result, { apiUrl, authType: "key" })
      });
    } else {
      const body = result.body;
      account = body.account;
      const delegated = Boolean(body.wallets.solana?.delegated || body.wallets.evm?.delegated);
      rows.push(delegated ? { check: "Launch wallet delegated", state: "PASS", detail: "delegated" } : {
        check: "Launch wallet delegated",
        state: "FAIL",
        detail: "No launch wallet is delegated. Fix: delegate one in the portal."
      });
    }
  }
  const cachedAccount = ctx.profile !== undefined ? fields.account : undefined;
  const mismatch = account !== undefined && cachedAccount !== undefined && account !== cachedAccount && credentialEnvOverrides(deps.env).length === 0;
  rows.push(account === undefined ? { check: "Account", state: "SKIP", detail: "could not resolve which account these credentials act as" } : {
    check: "Account",
    state: "PASS",
    detail: mismatch ? `${account} (profile ${ctx.profile} recorded ${cachedAccount}. Fix: run candle profile use ${ctx.profile})` : account
  });
  const realExec = await deps.realpath(deps.execPath).catch(() => deps.execPath);
  const method = detectInstall(deps.execPath, realExec);
  const installDetail = method === "binary" ? `binary at ${deps.execPath}` : method === "homebrew" ? `Homebrew (${realExec})` : `script (${deps.execPath}); update with npm`;
  rows.push({ check: "Install", state: "PASS", detail: installDetail });
  const latest = await fetchLatest(deps, releaseBaseUrl(deps.env));
  const updateBody = latest.ok ? {
    current: CLI_VERSION,
    latest: latest.manifest.version,
    available: compareVersions(CLI_VERSION, latest.manifest.version) < 0
  } : { current: CLI_VERSION, latest: null, available: null };
  rows.push(latest.ok ? {
    check: "Update",
    state: "PASS",
    detail: updateBody.available ? `${latest.manifest.version} available: ${method === "homebrew" ? "brew upgrade candle" : method === "script" ? "npm i -g @candledottv/cli@latest" : "candle update"}` : `up to date (${CLI_VERSION})`
  } : { check: "Update", state: "SKIP", detail: `could not check: ${latest.message}` });
  const exitCode = rows.some((row) => row.state === "FAIL") ? 1 : 0;
  await printIdentity(ctx);
  if (json) {
    deps.stdout.write(`${JSON.stringify({
      rows,
      ...account !== undefined ? { account } : {},
      ...cachedAccount !== undefined ? { cachedAccount } : {},
      install: { method, path: method === "homebrew" ? realExec : deps.execPath },
      update: updateBody
    })}
`);
    return exitCode;
  }
  deps.stdout.write(`${renderTable(["Check", "Status", "Detail"], rows.map((row) => [row.check, row.state, row.detail]))}
`);
  return exitCode;
}

// src/commands/keys.ts
var KEYS_PATH = "/api/v1/agent/keys";
var NO_DEVICE_TOKEN = {
  code: "NO_DEVICE_TOKEN",
  message: "No device token available.",
  suggestion: "Run: candle auth login"
};
function mintedByLabel(mintedBy, ownDeviceTokenPrefix) {
  if (!mintedBy)
    return "browser session";
  if (mintedBy === ownDeviceTokenPrefix)
    return "this device";
  return mintedBy;
}
async function keysList(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  await printIdentity(ctx);
  const deviceToken = await resolveDeviceToken(deps, ctx.profile);
  if (!deviceToken) {
    writeLocalFailure(deps, NO_DEVICE_TOKEN, json);
    return 1;
  }
  const result = await apiRequest(KEYS_PATH, {
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!result.ok) {
    writeFailure(deps, result, { apiUrl, authType: "device" }, json);
    return 1;
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify(result.body)}
`);
    return 0;
  }
  const body = result.body;
  const config = await deps.readConfig();
  const ownDevicePrefix = effectiveProfileFields(config, ctx.profile).deviceTokenPrefix;
  const rows = body.keys.map((key) => [
    key.keyPrefix,
    key.scopes.join(","),
    key.environment,
    formatTimestamp(key.createdAt),
    formatTimestamp(key.lastUsedAt),
    key.revokedAt ? formatTimestamp(key.revokedAt) : "no",
    mintedByLabel(key.mintedByDevicePrefix, ownDevicePrefix)
  ]);
  deps.stdout.write(`${renderTable(["Prefix", "Scopes", "Environment", "Created", "Last used", "Revoked", "Minted by"], rows)}
`);
  return 0;
}
async function keysCreate(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {
    valueFlags: ["--scopes", "--environment", "--label", "--expires-in", "--tx-limit", "--reset"]
  });
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const requestedScopes = parsed.values["--scopes"] ? parseScopesList(parsed.values["--scopes"]) : undefined;
  const environment = parsed.values["--environment"];
  const label = parsed.values["--label"]?.trim();
  if (parsed.values["--label"] !== undefined && (label === undefined || label.length < 1 || label.length > 64)) {
    writeUsageFailure(deps, "--label must be 1 to 64 characters.", json);
    return 2;
  }
  let expiresInDays;
  if (parsed.values["--expires-in"] !== undefined) {
    const parsedDays = parseExpiresInDays(parsed.values["--expires-in"]);
    if (!parsedDays.ok) {
      writeUsageFailure(deps, parsedDays.message, json);
      return 2;
    }
    expiresInDays = parsedDays.days;
  }
  if (parsed.values["--reset"] !== undefined && parsed.values["--tx-limit"] === undefined) {
    writeUsageFailure(deps, "--reset requires --tx-limit.", json);
    return 2;
  }
  let txLimit;
  if (parsed.values["--tx-limit"] !== undefined) {
    const parsedUsd = parseUsdToMicros(parsed.values["--tx-limit"]);
    if (!parsedUsd.ok) {
      writeUsageFailure(deps, parsedUsd.message, json);
      return 2;
    }
    const reset = parsed.values["--reset"] ?? "daily";
    if (!TX_LIMIT_RESETS.includes(reset)) {
      writeUsageFailure(deps, `--reset must be one of: ${TX_LIMIT_RESETS.join(", ")}.`, json);
      return 2;
    }
    txLimit = { usdMicros: parsedUsd.usdMicros, reset };
  }
  await printIdentity(ctx);
  const deviceToken = await resolveDeviceToken(deps, ctx.profile);
  if (!deviceToken) {
    writeLocalFailure(deps, NO_DEVICE_TOKEN, json);
    return 1;
  }
  const result = await apiRequest(KEYS_PATH, {
    method: "POST",
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
    body: {
      ...requestedScopes ? { scopes: requestedScopes } : {},
      ...environment ? { environment } : {},
      ...label ? { label } : {},
      ...expiresInDays !== undefined ? { expiresInDays } : {},
      ...txLimit ? { txLimit } : {}
    }
  });
  if (!result.ok) {
    writeFailure(deps, result, { apiUrl, authType: "device" }, json);
    return 1;
  }
  const body = result.body;
  const apiKeyRef = ctx.profile ? profileSecretRef(ctx.profile, "apiKey") : SECRET_REFS.apiKey;
  const existingKey = await deps.store.get(apiKeyRef);
  let stored = false;
  if (!existingKey) {
    await deps.store.set(apiKeyRef, body.key);
    if (ctx.profile) {
      await deps.updateProfile(ctx.profile, { keyPrefix: body.keyPrefix, scopes: body.scopes });
    } else {
      await deps.writeConfig({ keyPrefix: body.keyPrefix, scopes: body.scopes });
    }
    stored = true;
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...body, stored })}
`);
    return 0;
  }
  deps.stdout.write(`API key: ${body.key}
`);
  deps.stdout.write(`This is the only time the plaintext key is shown; store it now.
`);
  deps.stdout.write(`Prefix: ${body.keyPrefix}
`);
  deps.stdout.write(`Scopes: ${formatScopesForSummary(body.scopes)}
`);
  if (!requestedScopes) {
    deps.stdout.write(`No --scopes given: the server granted the default scopes (swap:write excluded).
`);
  }
  deps.stdout.write(stored ? `Stored in the ${deps.backend} backend as the CLI's working key.
` : `Not stored: the CLI already manages a different working key. This key belongs to whichever agent it was minted for.
`);
  return 0;
}
async function keysRevoke(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length !== 1) {
    deps.stderr.write(`Usage: candle keys revoke <prefix>
`);
    return 2;
  }
  const prefix = parsed.positionals[0];
  await printIdentity(ctx);
  const deviceToken = await resolveDeviceToken(deps, ctx.profile);
  if (!deviceToken) {
    writeLocalFailure(deps, NO_DEVICE_TOKEN, json);
    return 1;
  }
  const result = await apiRequest(`${KEYS_PATH}/${encodeURIComponent(prefix)}`, {
    method: "DELETE",
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!result.ok) {
    writeFailure(deps, result, { apiUrl, authType: "device" }, json);
    return 1;
  }
  const config = await deps.readConfig();
  const storedPrefix = effectiveProfileFields(config, ctx.profile).keyPrefix;
  let clearedLocal = false;
  if (storedPrefix === prefix) {
    const apiKeyRef = ctx.profile ? profileSecretRef(ctx.profile, "apiKey") : SECRET_REFS.apiKey;
    await deps.store.delete(apiKeyRef);
    if (ctx.profile) {
      await deps.updateProfile(ctx.profile, { keyPrefix: undefined });
    } else {
      await deps.writeConfig({ keyPrefix: undefined });
    }
    clearedLocal = true;
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify({ success: true, keyPrefix: prefix, clearedLocal })}
`);
    return 0;
  }
  deps.stdout.write(`Revoked key ${prefix}.
`);
  if (clearedLocal) {
    deps.stdout.write(`This was the CLI's stored working key; also cleared it locally.
`);
  }
  return 0;
}

// src/commands/mcp.ts
var MCP_TOOL_NAMES = [
  "candle_launch_token",
  "candle_launch_and_seed",
  "candle_get_market",
  "candle_get_feed",
  "candle_token_forensics",
  "candle_get_agent_profile",
  "candle_report_activity",
  "candle_trade",
  "candle_swap",
  "candle_transfer",
  "candle_sweep"
];
var READ_ONLY_TOOL_NAMES = [
  "candle_get_market",
  "candle_get_feed",
  "candle_token_forensics",
  "candle_get_agent_profile"
];
function mcpActsAsIdentity(args) {
  return !args.includes("--read-only");
}
async function mcpCommandForHost(deps) {
  const real = await deps.realpath(deps.execPath).catch(() => deps.execPath);
  const method = detectInstall(deps.execPath, real);
  if (method === "script")
    return { command: deps.execPath, prefixArgs: [deps.argv1] };
  if (method === "homebrew") {
    const opt = real.replace(/\/Cellar\/candle\/[^/]+\/bin\/candle$/, "/opt/candle/bin/candle");
    return { command: opt, prefixArgs: [] };
  }
  return { command: real, prefixArgs: [] };
}
async function mcpClientConfig(args, deps) {
  const { command, prefixArgs } = await mcpCommandForHost(deps);
  return JSON.stringify({ mcpServers: { candle: { command, args: [...prefixArgs, "mcp", ...args] } } }, null, 2);
}
async function mcp(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {
    valueFlags: ["--tools"],
    booleanFlags: ["--read-only", "--print-config"]
  });
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const readOnly = parsed.booleans.has("--read-only");
  const toolsFlag = parsed.values["--tools"];
  if (readOnly && toolsFlag !== undefined) {
    writeUsageFailure(deps, "--read-only and --tools are mutually exclusive; --read-only IS a tool selection.", json);
    return 2;
  }
  let toolAllowlist;
  if (readOnly) {
    toolAllowlist = READ_ONLY_TOOL_NAMES.join(",");
  } else if (toolsFlag !== undefined) {
    const requested = toolsFlag.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
    const unknown = requested.filter((name) => !MCP_TOOL_NAMES.includes(name));
    if (requested.length === 0 || unknown.length > 0) {
      writeUsageFailure(deps, `--tools must be a comma-separated list of: ${MCP_TOOL_NAMES.join(", ")}${unknown.length > 0 ? ` (unknown: ${unknown.join(", ")})` : ""}`, json);
      return 2;
    }
    toolAllowlist = requested.join(",");
  }
  const identityConfig = await deps.readConfig();
  const identityAccount = effectiveProfileFields(identityConfig, ctx.profile).account;
  deps.stderr.write(`${identityLine(ctx.profile, identityAccount, apiUrl, credentialEnvOverrides(deps.env))}
`);
  if (parsed.booleans.has("--print-config")) {
    const launchArgs = [
      ...readOnly ? ["--read-only"] : [],
      ...toolsFlag !== undefined ? ["--tools", toolsFlag] : []
    ];
    deps.stdout.write(`${await mcpClientConfig(launchArgs, deps)}
`);
    return 0;
  }
  const apiKey = readOnly ? undefined : await resolveApiKey(deps, ctx.profile);
  if (!readOnly && !apiKey) {
    writeLocalFailure(deps, { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle auth login" }, json);
    return 1;
  }
  const childEnv = {
    ...deps.env,
    CANDLE_API_URL: apiUrl,
    ...apiKey ? { CANDLE_AGENT_API_KEY: apiKey } : {},
    ...toolAllowlist ? { CANDLE_MCP_TOOLS: toolAllowlist } : {}
  };
  deps.stderr.write(`Starting @candledottv/mcp against ${apiUrl}${toolAllowlist ? ` (tools: ${toolAllowlist})` : ""}
`);
  return deps.runChild("npx", ["--yes", "@candledottv/mcp"], childEnv);
}

// src/commands/profile.ts
async function profileList(args, ctx) {
  const { deps, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  const rows = profileTable(await deps.readConfig(), deps.now());
  if (json) {
    deps.stdout.write(`${JSON.stringify(rows)}
`);
    return 0;
  }
  if (rows.length === 0) {
    deps.stdout.write(`No profiles on this machine. Run: candle auth login
`);
    return 0;
  }
  deps.stdout.write(renderTable(["Profile", "Account", "Cached", "Host", "Key"], rows.map((r) => [
    r.active ? `${r.name} (active)` : r.name,
    r.account ?? "unknown",
    r.cachedAge,
    r.apiUrl ?? "-",
    r.keyPrefix ?? "-"
  ])));
  return 0;
}
var NEEDS_SCHEME = (value) => `It needs a scheme, such as https://${value}`;
var BAD_SCHEME = "The scheme must be http or https.";
function apiUrlFault(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return NEEDS_SCHEME(value);
  }
  if (url.host === "")
    return NEEDS_SCHEME(value);
  return url.protocol === "http:" || url.protocol === "https:" ? undefined : BAD_SCHEME;
}
async function profileAdd(args, ctx) {
  const { deps, json, apiUrlFlag } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  const name = parsed.positionals[0];
  if (!name || parsed.positionals.length !== 1) {
    writeUsageFailure(deps, "Usage: candle profile add <name> --api-url <url>", json);
    return 2;
  }
  if (!isValidProfileName(name)) {
    writeUsageFailure(deps, `Invalid profile name: ${name}`, json);
    return 2;
  }
  if (!apiUrlFlag) {
    writeUsageFailure(deps, "profile add needs --api-url <url>: the host this profile authenticates against", json);
    return 2;
  }
  const fault = apiUrlFault(apiUrlFlag);
  if (fault) {
    writeUsageFailure(deps, `Invalid --api-url: ${apiUrlFlag}. ${fault}`, json);
    return 2;
  }
  const config = await deps.readConfig();
  if (config.profiles?.[name]) {
    writeLocalFailure(deps, {
      code: "PROFILE_EXISTS",
      message: `Profile "${name}" already exists.`,
      suggestion: `Run: candle profile use ${name}`
    }, json);
    return 1;
  }
  await deps.updateProfile(name, { apiUrl: apiUrlFlag });
  if (!config.activeProfile)
    await deps.writeConfig({ activeProfile: name });
  if (json)
    deps.stdout.write(`${JSON.stringify({ name, apiUrl: apiUrlFlag })}
`);
  else
    deps.stdout.write(`Created profile ${name} for ${apiUrlFlag}. Run: candle auth login --profile ${name}
`);
  return 0;
}
async function profileUse(args, ctx) {
  const { deps, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  const name = parsed.positionals[0];
  if (!name || parsed.positionals.length !== 1) {
    writeUsageFailure(deps, "Usage: candle profile use <name>", json);
    return 2;
  }
  const config = await deps.readConfig();
  const profile = config.profiles?.[name];
  if (!profile) {
    const names = Object.keys(config.profiles ?? {}).join(", ") || "(none)";
    writeLocalFailure(deps, {
      code: "NO_SUCH_PROFILE",
      message: `No profile named "${name}".`,
      suggestion: `Profiles on this machine: ${names}`
    }, json);
    return 1;
  }
  await deps.writeConfig({ activeProfile: name });
  const envProfile = deps.env.CANDLE_PROFILE?.trim();
  if (envProfile && envProfile !== name) {
    deps.stderr.write(`CANDLE_PROFILE=${envProfile} is set and takes precedence over the active profile.
`);
  }
  const apiUrl = ctx.apiUrlFlag ?? resolveApiUrl(profile.apiUrl, deps.env);
  const apiKey = await deps.store.get(profileSecretRef(name, "apiKey"));
  let account = profile.account;
  if (apiKey) {
    const { account: live, failure } = await fetchAccount(deps, apiUrl, apiKey);
    if (live) {
      account = live;
      await deps.updateProfile(name, { account: live, accountCachedAt: deps.now() });
    } else {
      deps.stderr.write(`Could not refresh the account for ${name} (${failure}); keeping the cached value.
`);
    }
  } else {
    deps.stderr.write(`No stored credentials for ${name}. Run: candle auth login --profile ${name}
`);
  }
  if (json)
    deps.stdout.write(`${JSON.stringify({ name, account, apiUrl })}
`);
  else
    deps.stdout.write(`${identityLine(name, account, apiUrl)}
`);
  return 0;
}
var SECRET_KINDS = ["deviceToken", "apiKey"];
async function profileRename(args, ctx) {
  const { deps, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  const [from, to] = parsed.positionals;
  if (!from || !to || parsed.positionals.length !== 2) {
    writeUsageFailure(deps, "Usage: candle profile rename <old> <new>", json);
    return 2;
  }
  if (!isValidProfileName(to)) {
    writeUsageFailure(deps, `Invalid profile name: ${to}`, json);
    return 2;
  }
  const config = await deps.readConfig();
  const profiles = { ...config.profiles ?? {} };
  if (!profiles[from]) {
    writeLocalFailure(deps, { code: "NO_SUCH_PROFILE", message: `No profile named "${from}".` }, json);
    return 1;
  }
  if (profiles[to]) {
    writeLocalFailure(deps, { code: "PROFILE_EXISTS", message: `Profile "${to}" already exists.` }, json);
    return 1;
  }
  for (const kind of SECRET_KINDS) {
    const value = await deps.store.get(profileSecretRef(from, kind));
    if (value) {
      await deps.store.set(profileSecretRef(to, kind), value);
      await deps.store.delete(profileSecretRef(from, kind));
    }
  }
  profiles[to] = profiles[from];
  delete profiles[from];
  await deps.writeConfig({ profiles, ...config.activeProfile === from ? { activeProfile: to } : {} });
  if (json)
    deps.stdout.write(`${JSON.stringify({ from, to })}
`);
  else
    deps.stdout.write(`Renamed profile ${from} to ${to}.
`);
  return 0;
}
async function profileRemove(args, ctx) {
  const { deps, json } = ctx;
  const parsed = parseArgs(args, { booleanFlags: ["--yes"] });
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  const name = parsed.positionals[0];
  if (!name || parsed.positionals.length !== 1) {
    writeUsageFailure(deps, "Usage: candle profile remove <name> --yes", json);
    return 2;
  }
  const config = await deps.readConfig();
  const profiles = { ...config.profiles ?? {} };
  const profile = profiles[name];
  if (!profile) {
    writeLocalFailure(deps, { code: "NO_SUCH_PROFILE", message: `No profile named "${name}".` }, json);
    return 1;
  }
  if (!parsed.booleans.has("--yes")) {
    writeUsageFailure(deps, `Would delete profile ${name} (${profile.account ?? "unknown"} at ${profile.apiUrl ?? "default host"}) and its stored credentials. Re-run with --yes to confirm.`, json);
    return 2;
  }
  for (const kind of SECRET_KINDS)
    await deps.store.delete(profileSecretRef(name, kind));
  delete profiles[name];
  const wasActive = config.activeProfile === name;
  await deps.writeConfig({ profiles, ...wasActive ? { activeProfile: undefined } : {} });
  if (json)
    deps.stdout.write(`${JSON.stringify({ removed: name })}
`);
  else {
    const needsPick = wasActive && Object.keys(profiles).length > 1;
    deps.stdout.write(`Deleted profile ${name} and its stored credentials.${needsPick ? " Run: candle profile use <name>" : ""}
`);
  }
  return 0;
}

// src/commands/setup.ts
var SKILLS_CLAUDE_COMMAND = "/plugin marketplace add candledottv/agentic";
var CODING_AGENTS_DOCS = "https://docs.candle.tv/developers/coding-agents";
function section(deps, title) {
  deps.stdout.write(`
== ${title} ==
`);
}
async function setup(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, { booleanFlags: ["--no-browser"] });
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  if (json) {
    writeUsageFailure(deps, "setup is an interactive wizard; for machine use, compose `auth login --json` and `doctor --json` directly", json);
    return 2;
  }
  await printIdentity(ctx);
  deps.stdout.write(`candle setup: this wizard authorizes the device, shows funding, and verifies everything.
`);
  section(deps, "1/4 Authorize this device");
  const deviceToken = await resolveDeviceToken(deps, ctx.profile);
  const apiKey = await resolveApiKey(deps, ctx.profile);
  let nextCtx = ctx;
  if (deviceToken && apiKey) {
    deps.stdout.write(`Already authorized on this machine (device token + API key present). Skipping login.
`);
  } else {
    const loginArgs = parsed.booleans.has("--no-browser") ? ["--no-browser"] : [];
    const loginExit = await authLogin(loginArgs, ctx);
    if (loginExit !== 0) {
      deps.stderr.write(`Setup stopped: device authorization did not complete.
`);
      return loginExit;
    }
    const loginConfig = await deps.readConfig();
    const resolution = resolveProfileName(loginConfig, { flag: ctx.profileFlag, env: deps.env });
    if (!resolution.ok) {
      deps.stderr.write(`${resolution.message}
`);
      return 1;
    }
    nextCtx = { ...ctx, profile: resolution.name };
  }
  section(deps, "2/4 Fund your agent's wallets");
  const key = await resolveApiKey(deps, nextCtx.profile);
  const walletsResult = key ? await apiRequest("/api/v1/agent/wallets/embedded", {
    auth: "key",
    credentials: { apiKey: key },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  }) : null;
  if (walletsResult?.ok) {
    const body = walletsResult.body;
    const solana = body.wallets?.solana ?? null;
    const evm = body.wallets?.evm ?? null;
    if (body.account)
      deps.stdout.write(`${identityLine(nextCtx.profile, body.account, apiUrl)}
`);
    if (solana)
      deps.stdout.write(`Solana (send SOL here):    ${solana.address}
`);
    if (evm)
      deps.stdout.write(`Hood    (send ETH here):    ${evm.address}
`);
    deps.stdout.write(`Launches and trades are paid from these wallets. There is no minimum, and read-only requests work unfunded.
`);
    deps.stdout.write(`
Tell your agent (paste into its context):
`);
    deps.stdout.write(`  You operate a Candle agent account. API base URL: ${apiUrl} (send your API key in the x-api-key header).
`);
    if (solana)
      deps.stdout.write(`  Your Solana wallet: ${solana.address}
`);
    if (evm)
      deps.stdout.write(`  Your Hood Chain (EVM) wallet: ${evm.address}
`);
    deps.stdout.write(`  Check balances before trading, and ask me to fund whichever chain you need.
`);
  } else {
    deps.stdout.write("Could not read the agent wallets right now; `candle wallets` shows them once the API is reachable.\n");
  }
  section(deps, "3/4 Connect your agent");
  deps.stdout.write(`Claude Code skills:  ${SKILLS_CLAUDE_COMMAND}
`);
  deps.stdout.write(`MCP (any client), paste into the host's MCP config:
`);
  deps.stdout.write(`${await mcpClientConfig([], deps)}
`);
  deps.stdout.write(`MCP hosts also need Node 18+ on their own PATH: candle mcp starts the server with npx --yes @candledottv/mcp.
`);
  deps.stdout.write(`Other platforms:     ${CODING_AGENTS_DOCS}
`);
  section(deps, "4/4 Health check");
  const doctorExit = await doctor([], nextCtx);
  const config = await deps.readConfig();
  const { portalOrigin } = effectiveProfileFields(config, nextCtx.profile);
  deps.stdout.write(`
Console (keys, funding, withdrawal addresses, limits): ${portalDeviceUrl(apiUrl, portalOrigin)}
`);
  deps.stdout.write(doctorExit === 0 ? `Setup complete. Your agent can launch, trade, and transfer the moment the wallets are funded.
` : "Setup finished with failed checks above; fix them and re-run `candle doctor`.\n");
  return doctorExit;
}

// src/commands/update.ts
import { createHash as createHash2, randomBytes } from "node:crypto";

// src/bun-crypto-shim.ts
import crypto2, { KeyObject } from "node:crypto";
var original = crypto2.verify.bind(crypto2);
var MAX_UNWRAP = 3;
function keyOf(key, depth = 0) {
  if (key instanceof KeyObject)
    return key;
  if (key !== null && typeof key === "object" && "key" in key) {
    return depth >= MAX_UNWRAP ? null : keyOf(key.key, depth + 1);
  }
  if (typeof key === "string" || key instanceof Uint8Array) {
    try {
      return crypto2.createPublicKey(key);
    } catch {
      return null;
    }
  }
  return null;
}
function installBunCryptoShim() {
  if (!("Bun" in globalThis))
    return;
  const shimmed = (algorithm, data, key, signature, ...rest) => {
    if (algorithm === null || algorithm === undefined) {
      const resolved = keyOf(key);
      if (resolved?.asymmetricKeyType === "ec")
        return original("sha256", data, key, signature, ...rest);
    }
    return original(algorithm, data, key, signature, ...rest);
  };
  Object.defineProperty(crypto2, "verify", { value: shimmed, configurable: true, writable: true });
}
installBunCryptoShim();

// src/release-verify.ts
var import_bundle = __toESM(require_dist2(), 1);
var import_protobuf_specs = __toESM(require_dist(), 1);
var import_verify = __toESM(require_dist4(), 1);
import { createHash } from "node:crypto";
// src/sigstore-trusted-root.json
var sigstore_trusted_root_default = {
  mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
  tlogs: [
    {
      baseUrl: "https://rekor.sigstore.dev",
      hashAlgorithm: "SHA2_256",
      publicKey: {
        rawBytes: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwrkBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==",
        keyDetails: "PKIX_ECDSA_P256_SHA_256",
        validFor: {
          start: "2021-01-12T11:53:27.000Z"
        }
      },
      logId: {
        keyId: "wNI9atQGlz+VWfO6LRygH4QUfY/8W4RFwiT5i5WRgB0="
      }
    },
    {
      baseUrl: "https://log2025-1.rekor.sigstore.dev",
      hashAlgorithm: "SHA2_256",
      publicKey: {
        rawBytes: "MCowBQYDK2VwAyEAt8rlp1knGwjfbcXAYPYAkn0XiLz1x8O4t0YkEhie244=",
        keyDetails: "PKIX_ED25519",
        validFor: {
          start: "2025-09-23T00:00:00.000Z"
        }
      },
      logId: {
        keyId: "zxGZFVvd0FEmjR8WrFwMdcAJ9vtaY/QXf44Y1wUeP6A="
      }
    }
  ],
  certificateAuthorities: [
    {
      subject: {
        organization: "sigstore.dev",
        commonName: "sigstore"
      },
      uri: "https://fulcio.sigstore.dev",
      certChain: {
        certificates: [
          {
            rawBytes: "MIIB+DCCAX6gAwIBAgITNVkDZoCiofPDsy7dfm6geLbuhzAKBggqhkjOPQQDAzAqMRUwEwYDVQQKEwxzaWdzdG9yZS5kZXYxETAPBgNVBAMTCHNpZ3N0b3JlMB4XDTIxMDMwNzAzMjAyOVoXDTMxMDIyMzAzMjAyOVowKjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTB2MBAGByqGSM49AgEGBSuBBAAiA2IABLSyA7Ii5k+pNO8ZEWY0ylemWDowOkNa3kL+GZE5Z5GWehL9/A9bRNA3RbrsZ5i0JcastaRL7Sp5fp/jD5dxqc/UdTVnlvS16an+2Yfswe/QuLolRUCrcOE2+2iA5+tzd6NmMGQwDgYDVR0PAQH/BAQDAgEGMBIGA1UdEwEB/wQIMAYBAf8CAQEwHQYDVR0OBBYEFMjFHQBBmiQpMlEk6w2uSu1KBtPsMB8GA1UdIwQYMBaAFMjFHQBBmiQpMlEk6w2uSu1KBtPsMAoGCCqGSM49BAMDA2gAMGUCMH8liWJfMui6vXXBhjDgY4MwslmN/TJxVe/83WrFomwmNf056y1X48F9c4m3a3ozXAIxAKjRay5/aj/jsKKGIkmQatjI8uupHr/+CxFvaJWmpYqNkLDGRU+9orzh5hI2RrcuaQ=="
          }
        ]
      },
      validFor: {
        start: "2021-03-07T03:20:29.000Z",
        end: "2022-12-31T23:59:59.999Z"
      }
    },
    {
      subject: {
        organization: "sigstore.dev",
        commonName: "sigstore"
      },
      uri: "https://fulcio.sigstore.dev",
      certChain: {
        certificates: [
          {
            rawBytes: "MIICGjCCAaGgAwIBAgIUALnViVfnU0brJasmRkHrn/UnfaQwCgYIKoZIzj0EAwMwKjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTAeFw0yMjA0MTMyMDA2MTVaFw0zMTEwMDUxMzU2NThaMDcxFTATBgNVBAoTDHNpZ3N0b3JlLmRldjEeMBwGA1UEAxMVc2lnc3RvcmUtaW50ZXJtZWRpYXRlMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE8RVS/ysH+NOvuDZyPIZtilgUF9NlarYpAd9HP1vBBH1U5CV77LSS7s0ZiH4nE7Hv7ptS6LvvR/STk798LVgMzLlJ4HeIfF3tHSaexLcYpSASr1kS0N/RgBJz/9jWCiXno3sweTAOBgNVHQ8BAf8EBAMCAQYwEwYDVR0lBAwwCgYIKwYBBQUHAwMwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQU39Ppz1YkEZb5qNjpKFWixi4YZD8wHwYDVR0jBBgwFoAUWMAeX5FFpWapesyQoZMi0CrFxfowCgYIKoZIzj0EAwMDZwAwZAIwPCsQK4DYiZYDPIaDi5HFKnfxXx6ASSVmERfsynYBiX2X6SJRnZU84/9DZdnFvvxmAjBOt6QpBlc4J/0DxvkTCqpclvziL6BCCPnjdlIB3Pu3BxsPmygUY7Ii2zbdCdliiow="
          },
          {
            rawBytes: "MIIB9zCCAXygAwIBAgIUALZNAPFdxHPwjeDloDwyYChAO/4wCgYIKoZIzj0EAwMwKjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTAeFw0yMTEwMDcxMzU2NTlaFw0zMTEwMDUxMzU2NThaMCoxFTATBgNVBAoTDHNpZ3N0b3JlLmRldjERMA8GA1UEAxMIc2lnc3RvcmUwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAT7XeFT4rb3PQGwS4IajtLk3/OlnpgangaBclYpsYBr5i+4ynB07ceb3LP0OIOZdxexX69c5iVuyJRQ+Hz05yi+UF3uBWAlHpiS5sh0+H2GHE7SXrk1EC5m1Tr19L9gg92jYzBhMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBRYwB5fkUWlZql6zJChkyLQKsXF+jAfBgNVHSMEGDAWgBRYwB5fkUWlZql6zJChkyLQKsXF+jAKBggqhkjOPQQDAwNpADBmAjEAj1nHeXZp+13NWBNa+EDsDP8G1WWg1tCMWP/WHPqpaVo0jhsweNFZgSs0eE7wYI4qAjEA2WB9ot98sIkoF3vZYdd3/VtWB5b9TNMea7Ix/stJ5TfcLLeABLE4BNJOsQ4vnBHJ"
          }
        ]
      },
      validFor: {
        start: "2022-04-13T20:06:15.000Z"
      }
    }
  ],
  ctlogs: [
    {
      baseUrl: "https://ctfe.sigstore.dev/test",
      hashAlgorithm: "SHA2_256",
      publicKey: {
        rawBytes: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbfwR+RJudXscgRBRpKX1XFDy3PyudDxz/SfnRi1fT8ekpfBd2O1uoz7jr3Z8nKzxA69EUQ+eFCFI3zeubPWU7w==",
        keyDetails: "PKIX_ECDSA_P256_SHA_256",
        validFor: {
          start: "2021-03-14T00:00:00.000Z",
          end: "2022-10-31T23:59:59.999Z"
        }
      },
      logId: {
        keyId: "CGCS8ChS/2hF0dFrJ4ScRWcYrBY9wzjSbea8IgY2b3I="
      }
    },
    {
      baseUrl: "https://ctfe.sigstore.dev/2022",
      hashAlgorithm: "SHA2_256",
      publicKey: {
        rawBytes: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEiPSlFi0CmFTfEjCUqF9HuCEcYXNKAaYalIJmBZ8yyezPjTqhxrKBpMnaocVtLJBI1eM3uXnQzQGAJdJ4gs9Fyw==",
        keyDetails: "PKIX_ECDSA_P256_SHA_256",
        validFor: {
          start: "2022-10-20T00:00:00.000Z"
        }
      },
      logId: {
        keyId: "3T0wasbHETJjGR4cmWc3AqJKXrjePK3/h4pygC8p7o4="
      }
    }
  ],
  timestampAuthorities: [
    {
      subject: {
        organization: "sigstore.dev",
        commonName: "sigstore-tsa-selfsigned"
      },
      uri: "https://timestamp.sigstore.dev/api/v1/timestamp",
      certChain: {
        certificates: [
          {
            rawBytes: "MIICEDCCAZagAwIBAgIUOhNULwyQYe68wUMvy4qOiyojiwwwCgYIKoZIzj0EAwMwOTEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MSAwHgYDVQQDExdzaWdzdG9yZS10c2Etc2VsZnNpZ25lZDAeFw0yNTA0MDgwNjU5NDNaFw0zNTA0MDYwNjU5NDNaMC4xFTATBgNVBAoTDHNpZ3N0b3JlLmRldjEVMBMGA1UEAxMMc2lnc3RvcmUtdHNhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE4ra2Z8hKNig2T9kFjCAToGG30jky+WQv3BzL+mKvh1SKNR/UwuwsfNCg4sryoYAd8E6isovVA3M4aoNdm9QDi50Z8nTEyvqgfDPtTIwXItfiW/AFf1V7uwkbkAoj0xxco2owaDAOBgNVHQ8BAf8EBAMCB4AwHQYDVR0OBBYEFIn9eUOHz9BlRsMCRscsc1t9tOsDMB8GA1UdIwQYMBaAFJjsAe9/u1H/1JUeb4qImFMHic6/MBYGA1UdJQEB/wQMMAoGCCsGAQUFBwMIMAoGCCqGSM49BAMDA2gAMGUCMDtpsV/6KaO0qyF/UMsX2aSUXKQFdoGTptQGc0ftq1csulHPGG6dsmyMNd3JB+G3EQIxAOajvBcjpJmKb4Nv+2Taoj8Uc5+b6ih6FXCCKraSqupe07zqswMcXJTe1cExvHvvlw=="
          },
          {
            rawBytes: "MIIB9zCCAXygAwIBAgIUV7f0GLDOoEzIh8LXSW80OJiUp14wCgYIKoZIzj0EAwMwOTEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MSAwHgYDVQQDExdzaWdzdG9yZS10c2Etc2VsZnNpZ25lZDAeFw0yNTA0MDgwNjU5NDNaFw0zNTA0MDYwNjU5NDNaMDkxFTATBgNVBAoTDHNpZ3N0b3JlLmRldjEgMB4GA1UEAxMXc2lnc3RvcmUtdHNhLXNlbGZzaWduZWQwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQUQNtfRT/ou3YATa6wB/kKTe70cfJwyRIBovMnt8RcJph/COE82uyS6FmppLLL1VBPGcPfpQPYJNXzWwi8icwhKQ6W/Qe2h3oebBb2FHpwNJDqo+TMaC/tdfkv/ElJB72jRTBDMA4GA1UdDwEB/wQEAwIBBjASBgNVHRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBSY7AHvf7tR/9SVHm+KiJhTB4nOvzAKBggqhkjOPQQDAwNpADBmAjEAwGEGrfGZR1cen1R8/DTVMI943LssZmJRtDp/i7SfGHmGRP6gRbuj9vOK3b67Z0QQAjEAuT2H673LQEaHTcyQSZrkp4mX7WwkmF+sVbkYY5mXN+RMH13KUEHHOqASaemYWK/E"
          }
        ]
      },
      validFor: {
        start: "2025-07-04T00:00:00.000Z"
      }
    }
  ]
};

// src/release-verify.ts
var verifier;
function getVerifier() {
  if (!verifier) {
    const root = import_protobuf_specs.TrustedRoot.fromJSON(sigstore_trusted_root_default);
    verifier = new import_verify.Verifier(import_verify.toTrustMaterial(root), { ctlogThreshold: 1, tlogThreshold: 1 });
  }
  return verifier;
}
var IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
function exactIdentity(identityUri) {
  return new RegExp(`^${identityUri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}
function withTrustRootHint(reason) {
  const staleRoot = /certificate chain|certificate path|certificate is not valid or expired/i;
  if (!staleRoot.test(reason))
    return reason;
  return `${reason}; the trust root embedded in this candle may be out of date; reinstall with curl -fsSL https://candle.tv/install.sh | bash`;
}
function verifyReleaseAsset(bytes, bundleJson, identityUri, issuer) {
  try {
    const bundle = import_bundle.bundleFromJSON(bundleJson);
    const digest = createHash("sha256").update(bytes).digest();
    const content = bundle.content;
    if (content.$case === "messageSignature") {
      const claimed = content.messageSignature.messageDigest?.digest;
      if (!claimed || Buffer.compare(Buffer.from(claimed), digest) !== 0) {
        return { ok: false, reason: "the bundle's message digest does not match the file" };
      }
    } else if (content.$case === "dsseEnvelope") {
      if (content.dsseEnvelope.payloadType !== IN_TOTO_PAYLOAD_TYPE) {
        return { ok: false, reason: `unsupported attestation payload type: ${content.dsseEnvelope.payloadType}` };
      }
      let statement;
      try {
        statement = JSON.parse(Buffer.from(content.dsseEnvelope.payload).toString("utf8"));
      } catch {
        return { ok: false, reason: "the attestation payload is not valid JSON" };
      }
      const hex = digest.toString("hex");
      if (!statement.subject?.some((subject) => subject.digest?.sha256 === hex)) {
        return { ok: false, reason: "the attestation's subject digest does not match the file" };
      }
    } else {
      return { ok: false, reason: "unsupported bundle content" };
    }
    const entity = import_verify.toSignedEntity(bundle, Buffer.from(bytes));
    getVerifier().verify(entity, { subjectAlternativeName: exactIdentity(identityUri), extensions: { issuer } });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: withTrustRootHint(error instanceof Error ? error.message : String(error)) };
  }
}

// src/commands/update.ts
var INSTALLER_LINE = "curl -fsSL https://candle.tv/install.sh | bash";
async function update(args, ctx) {
  const { deps, json } = ctx;
  const parsed = parseArgs(args, { valueFlags: ["--to"], booleanFlags: ["--check"] });
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const check = parsed.booleans.has("--check");
  const pinned = parsed.values["--to"];
  const realExec = await deps.realpath(deps.execPath).catch(() => deps.execPath);
  const method = detectInstall(deps.execPath, realExec);
  if (method === "homebrew") {
    if (json) {
      const payload = { current: CLI_VERSION, latest: null, updated: false, path: realExec, method };
      deps.stdout.write(`${JSON.stringify(payload)}
`);
    } else {
      deps.stdout.write(`Installed by Homebrew. Run: brew upgrade candle
`);
    }
    return 0;
  }
  if (method === "script") {
    if (json) {
      const payload = { current: CLI_VERSION, latest: null, updated: false, path: realExec, method };
      deps.stdout.write(`${JSON.stringify(payload)}
`);
    } else {
      deps.stdout.write(`Installed with npm (or a dev checkout). Run: npm i -g @candledottv/cli@latest
`);
    }
    return 0;
  }
  const base = releaseBaseUrl(deps.env);
  const fetched = pinned ? await fetchPinned(deps, base, pinned) : await fetchLatest(deps, base);
  if (!fetched.ok) {
    const code = fetched.kind === "invalid" ? "MANIFEST_INVALID" : "UPDATE_UNREACHABLE";
    writeLocalFailure(deps, { code, message: fetched.message }, json);
    return 1;
  }
  const target = fetched.manifest;
  let identityUri;
  try {
    identityUri = releaseIdentityUri(target.version);
  } catch (error) {
    writeLocalFailure(deps, {
      code: "MANIFEST_INVALID",
      message: `Refusing the release manifest at ${base}: ${messageOf(error)}.`,
      suggestion: "Nothing was downloaded or installed."
    }, json);
    return 1;
  }
  const order = compareVersions(CLI_VERSION, target.version);
  if (check) {
    if (json) {
      const payload = { current: CLI_VERSION, latest: target.version, updated: false, path: realExec };
      deps.stdout.write(`${JSON.stringify(payload)}
`);
    } else if (order < 0) {
      deps.stdout.write(`candle ${CLI_VERSION}; ${target.version} available. Run: candle update
`);
    } else {
      deps.stdout.write(`candle ${CLI_VERSION} is up to date (latest ${target.version})
`);
    }
    return 0;
  }
  if (order === 0 || order > 0 && !pinned) {
    if (json) {
      const payload = { current: CLI_VERSION, latest: target.version, updated: false, path: realExec };
      deps.stdout.write(`${JSON.stringify(payload)}
`);
    } else {
      deps.stdout.write(`candle ${CLI_VERSION} is up to date
`);
    }
    return 0;
  }
  if (order > 0 && pinned)
    deps.stderr.write(`Warning: ${target.version} is a downgrade from ${CLI_VERSION}
`);
  if (!deps.platformKey) {
    writeLocalFailure(deps, {
      code: "UPDATE_UNSUPPORTED_PLATFORM",
      message: "No release binary for this platform.",
      suggestion: "Run: npm i -g @candledottv/cli@latest"
    }, json);
    return 1;
  }
  const expectedName = `candle-${deps.platformKey}`;
  const asset = target.assets[deps.platformKey];
  if (!asset) {
    writeLocalFailure(deps, {
      code: "UPDATE_UNSUPPORTED_PLATFORM",
      message: `Release ${target.tag} has no asset for ${deps.platformKey}.`
    }, json);
    return 1;
  }
  if (asset.name !== expectedName) {
    writeLocalFailure(deps, {
      code: "MANIFEST_INVALID",
      message: `Release ${target.tag} names ${asset.name} as the ${deps.platformKey} asset; this platform installs ${expectedName}.`,
      suggestion: "Nothing was downloaded or installed."
    }, json);
    return 1;
  }
  const download = await fetchAll(deps, base, target.tag, expectedName);
  if (!download.ok) {
    writeLocalFailure(deps, { code: "UPDATE_UNREACHABLE", message: download.message }, json);
    return 1;
  }
  const { bytes, sums, bundle } = download;
  const dir = realExec.slice(0, realExec.lastIndexOf("/")) || ".";
  const tmpPath = `${dir}/.candle-update-${target.version}-${randomBytes(6).toString("hex")}`;
  try {
    await deps.writeBytes(tmpPath, bytes);
  } catch (error) {
    writeLocalFailure(deps, notWritable(dir, error), json);
    return 1;
  }
  const actual = createHash2("sha256").update(bytes).digest("hex");
  const fromSums = sums.split(`
`).map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === expectedName)?.[0];
  if (actual !== asset.sha256 || actual !== fromSums) {
    await discard(deps, tmpPath);
    writeLocalFailure(deps, {
      code: "UPDATE_VERIFY_FAILED",
      message: `checksum mismatch for ${expectedName} (manifest ${asset.sha256}, SHA256SUMS ${fromSums ?? "missing"}, downloaded ${actual}); nothing installed.`
    }, json);
    return 1;
  }
  const verify = deps.verify ?? verifyReleaseAsset;
  const verdict = verify(bytes, bundle, identityUri, RELEASE_ISSUER);
  if (!verdict.ok) {
    await discard(deps, tmpPath);
    writeLocalFailure(deps, {
      code: "UPDATE_VERIFY_FAILED",
      message: `signature verification failed for ${expectedName}: ${verdict.reason}; nothing installed.`,
      suggestion: `Checked against ${identityUri}.`
    }, json);
    return 1;
  }
  try {
    await deps.rename(tmpPath, realExec);
  } catch (error) {
    await discard(deps, tmpPath);
    writeLocalFailure(deps, notWritable(dir, error), json);
    return 1;
  }
  if (json) {
    const payload = { current: CLI_VERSION, latest: target.version, updated: true, path: realExec };
    deps.stdout.write(`${JSON.stringify(payload)}
`);
  } else {
    deps.stdout.write(`Updated candle ${CLI_VERSION} -> ${target.version}
`);
  }
  return 0;
}
function notWritable(dir, error) {
  return {
    code: "UPDATE_NOT_WRITABLE",
    message: `Cannot write ${dir}: ${messageOf(error)}.`,
    suggestion: `Rerun the installer with --bin-dir <writable dir>: ${INSTALLER_LINE}`
  };
}
async function discard(deps, path) {
  try {
    await deps.unlink(path);
  } catch {}
}
async function fetchPinned(deps, base, tag) {
  const url = assetUrl(base, tag, "latest.json");
  try {
    const res = await deps.fetch(url, { redirect: "follow" });
    if (!res.ok)
      return { ok: false, kind: "unreachable", message: `${url} answered ${res.status}` };
    const manifest = await res.json();
    const missing = [
      typeof manifest.version === "string" ? null : "version",
      typeof manifest.tag === "string" ? null : "tag",
      typeof manifest.assets === "object" && manifest.assets !== null ? null : "assets"
    ].filter((field) => field !== null);
    if (missing.length > 0) {
      return { ok: false, kind: "invalid", message: `The release manifest at ${url} has no ${missing.join(", ")}` };
    }
    return { ok: true, manifest };
  } catch (error) {
    return { ok: false, kind: "unreachable", message: `Could not reach ${url}: ${messageOf(error)}` };
  }
}
async function fetchAll(deps, base, tag, name) {
  try {
    const [bin, sums, bundle] = await Promise.all([
      deps.fetch(assetUrl(base, tag, name), { redirect: "follow" }),
      deps.fetch(assetUrl(base, tag, "SHA256SUMS"), { redirect: "follow" }),
      deps.fetch(assetUrl(base, tag, `${name}.sigstore.json`), { redirect: "follow" })
    ]);
    for (const [label, res] of [
      [name, bin],
      ["SHA256SUMS", sums],
      [`${name}.sigstore.json`, bundle]
    ]) {
      if (!res.ok)
        return { ok: false, message: `${label} answered ${res.status} at ${assetUrl(base, tag, label)}` };
    }
    return {
      ok: true,
      bytes: new Uint8Array(await bin.arrayBuffer()),
      sums: await sums.text(),
      bundle: await bundle.json()
    };
  } catch (error) {
    return { ok: false, message: `Could not download ${tag}: ${messageOf(error)}` };
  }
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/commands/verify.ts
import { dirname as dirname2, join as join3 } from "node:path";
var USAGE = "Usage: candle verify <file> --bundle <path> [--identity <uri>] [--issuer <url>]";
async function resolveIdentity(deps, bundlePath, flag) {
  if (flag)
    return { kind: "ok", uri: flag, provenance: "identity from --identity" };
  let version;
  try {
    const manifest = JSON.parse(await deps.readFile(join3(dirname2(bundlePath), "latest.json")));
    if (typeof manifest.version !== "string" || manifest.version.length === 0)
      return { kind: "absent" };
    version = manifest.version;
  } catch {
    return { kind: "absent" };
  }
  try {
    return {
      kind: "ok",
      uri: releaseIdentityUri(version),
      provenance: "identity from latest.json beside the bundle"
    };
  } catch (error) {
    return { kind: "invalid", message: messageOf2(error) };
  }
}
async function verify(args, ctx) {
  const { deps, json } = ctx;
  const parsed = parseArgs(args, { valueFlags: ["--bundle", "--identity", "--issuer"] });
  if ("error" in parsed) {
    writeUsageFailure(deps, `${parsed.error}
${USAGE}`, json);
    return 2;
  }
  const file = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || file === undefined) {
    writeUsageFailure(deps, `verify takes exactly one file.
${USAGE}`, json);
    return 2;
  }
  const bundlePath = parsed.values["--bundle"];
  if (!bundlePath) {
    writeUsageFailure(deps, `--bundle is required.
${USAGE}`, json);
    return 2;
  }
  const resolved = await resolveIdentity(deps, bundlePath, parsed.values["--identity"]);
  if (resolved.kind === "invalid") {
    writeLocalFailure(deps, {
      code: "MANIFEST_INVALID",
      message: `Refusing ${file}: ${resolved.message}.`,
      suggestion: `The latest.json beside ${bundlePath} does not name a release version. Pass --identity to say what signature to expect.`
    }, json);
    return 1;
  }
  if (resolved.kind === "absent") {
    writeUsageFailure(deps, `--identity is required: there is no latest.json beside ${bundlePath} to take the release version from.
${USAGE}`, json);
    return 2;
  }
  const identity = resolved.uri;
  const issuer = parsed.values["--issuer"] ?? RELEASE_ISSUER;
  let bytes;
  let bundleJson;
  try {
    bytes = await deps.readBytes(file);
  } catch (error) {
    writeLocalFailure(deps, { code: "FILE_UNREADABLE", message: `Could not read ${file}: ${messageOf2(error)}` }, json);
    return 1;
  }
  try {
    bundleJson = JSON.parse(await deps.readFile(bundlePath));
  } catch (error) {
    writeLocalFailure(deps, { code: "BUNDLE_UNREADABLE", message: `Could not read the bundle ${bundlePath}: ${messageOf2(error)}` }, json);
    return 1;
  }
  const result = verifyReleaseAsset(bytes, bundleJson, identity, issuer);
  if (!result.ok) {
    writeLocalFailure(deps, {
      code: "SIGNATURE_INVALID",
      message: `Refusing ${file}: ${result.reason}.`,
      suggestion: `Checked against ${identity} (${resolved.provenance}).`
    }, json);
    return 1;
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ok: true, file, identity, issuer, identitySource: resolved.provenance })}
`);
  } else {
    deps.stdout.write(`verified: ${identity} (${resolved.provenance})
`);
  }
  return 0;
}
function messageOf2(error) {
  return error instanceof Error ? error.message : String(error);
}

// ../../node_modules/@scure/base/lib/esm/index.js
/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function isArrayOf(isString, arr) {
  if (!Array.isArray(arr))
    return false;
  if (arr.length === 0)
    return true;
  if (isString) {
    return arr.every((item) => typeof item === "string");
  } else {
    return arr.every((item) => Number.isSafeInteger(item));
  }
}
function afn(input) {
  if (typeof input !== "function")
    throw new Error("function expected");
  return true;
}
function astr(label, input) {
  if (typeof input !== "string")
    throw new Error(`${label}: string expected`);
  return true;
}
function anumber(n) {
  if (!Number.isSafeInteger(n))
    throw new Error(`invalid integer: ${n}`);
}
function aArr(input) {
  if (!Array.isArray(input))
    throw new Error("array expected");
}
function astrArr(label, input) {
  if (!isArrayOf(true, input))
    throw new Error(`${label}: array of strings expected`);
}
function anumArr(label, input) {
  if (!isArrayOf(false, input))
    throw new Error(`${label}: array of numbers expected`);
}
function chain(...args) {
  const id = (a) => a;
  const wrap = (a, b) => (c) => a(b(c));
  const encode = args.map((x) => x.encode).reduceRight(wrap, id);
  const decode = args.map((x) => x.decode).reduce(wrap, id);
  return { encode, decode };
}
function alphabet(letters) {
  const lettersA = typeof letters === "string" ? letters.split("") : letters;
  const len = lettersA.length;
  astrArr("alphabet", lettersA);
  const indexes = new Map(lettersA.map((l, i) => [l, i]));
  return {
    encode: (digits) => {
      aArr(digits);
      return digits.map((i) => {
        if (!Number.isSafeInteger(i) || i < 0 || i >= len)
          throw new Error(`alphabet.encode: digit index outside alphabet "${i}". Allowed: ${letters}`);
        return lettersA[i];
      });
    },
    decode: (input) => {
      aArr(input);
      return input.map((letter) => {
        astr("alphabet.decode", letter);
        const i = indexes.get(letter);
        if (i === undefined)
          throw new Error(`Unknown letter: "${letter}". Allowed: ${letters}`);
        return i;
      });
    }
  };
}
function join4(separator = "") {
  astr("join", separator);
  return {
    encode: (from) => {
      astrArr("join.decode", from);
      return from.join(separator);
    },
    decode: (to) => {
      astr("join.decode", to);
      return to.split(separator);
    }
  };
}
function padding(bits, chr = "=") {
  anumber(bits);
  astr("padding", chr);
  return {
    encode(data) {
      astrArr("padding.encode", data);
      while (data.length * bits % 8)
        data.push(chr);
      return data;
    },
    decode(input) {
      astrArr("padding.decode", input);
      let end = input.length;
      if (end * bits % 8)
        throw new Error("padding: invalid, string should have whole number of bytes");
      for (;end > 0 && input[end - 1] === chr; end--) {
        const last = end - 1;
        const byte = last * bits;
        if (byte % 8 === 0)
          throw new Error("padding: invalid, string has too much padding");
      }
      return input.slice(0, end);
    }
  };
}
function normalize(fn) {
  afn(fn);
  return { encode: (from) => from, decode: (to) => fn(to) };
}
function convertRadix(data, from, to) {
  if (from < 2)
    throw new Error(`convertRadix: invalid from=${from}, base cannot be less than 2`);
  if (to < 2)
    throw new Error(`convertRadix: invalid to=${to}, base cannot be less than 2`);
  aArr(data);
  if (!data.length)
    return [];
  let pos = 0;
  const res = [];
  const digits = Array.from(data, (d) => {
    anumber(d);
    if (d < 0 || d >= from)
      throw new Error(`invalid integer: ${d}`);
    return d;
  });
  const dlen = digits.length;
  while (true) {
    let carry = 0;
    let done = true;
    for (let i = pos;i < dlen; i++) {
      const digit = digits[i];
      const fromCarry = from * carry;
      const digitBase = fromCarry + digit;
      if (!Number.isSafeInteger(digitBase) || fromCarry / from !== carry || digitBase - digit !== fromCarry) {
        throw new Error("convertRadix: carry overflow");
      }
      const div = digitBase / to;
      carry = digitBase % to;
      const rounded = Math.floor(div);
      digits[i] = rounded;
      if (!Number.isSafeInteger(rounded) || rounded * to + carry !== digitBase)
        throw new Error("convertRadix: carry overflow");
      if (!done)
        continue;
      else if (!rounded)
        pos = i;
      else
        done = false;
    }
    res.push(carry);
    if (done)
      break;
  }
  for (let i = 0;i < data.length - 1 && data[i] === 0; i++)
    res.push(0);
  return res.reverse();
}
var gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
var radix2carry = (from, to) => from + (to - gcd(from, to));
var powers = /* @__PURE__ */ (() => {
  let res = [];
  for (let i = 0;i < 40; i++)
    res.push(2 ** i);
  return res;
})();
function convertRadix2(data, from, to, padding2) {
  aArr(data);
  if (from <= 0 || from > 32)
    throw new Error(`convertRadix2: wrong from=${from}`);
  if (to <= 0 || to > 32)
    throw new Error(`convertRadix2: wrong to=${to}`);
  if (radix2carry(from, to) > 32) {
    throw new Error(`convertRadix2: carry overflow from=${from} to=${to} carryBits=${radix2carry(from, to)}`);
  }
  let carry = 0;
  let pos = 0;
  const max = powers[from];
  const mask = powers[to] - 1;
  const res = [];
  for (const n of data) {
    anumber(n);
    if (n >= max)
      throw new Error(`convertRadix2: invalid data word=${n} from=${from}`);
    carry = carry << from | n;
    if (pos + from > 32)
      throw new Error(`convertRadix2: carry overflow pos=${pos} from=${from}`);
    pos += from;
    for (;pos >= to; pos -= to)
      res.push((carry >> pos - to & mask) >>> 0);
    const pow = powers[pos];
    if (pow === undefined)
      throw new Error("invalid carry");
    carry &= pow - 1;
  }
  carry = carry << to - pos & mask;
  if (!padding2 && pos >= from)
    throw new Error("Excess padding");
  if (!padding2 && carry > 0)
    throw new Error(`Non-zero padding: ${carry}`);
  if (padding2 && pos > 0)
    res.push(carry >>> 0);
  return res;
}
function radix(num) {
  anumber(num);
  const _256 = 2 ** 8;
  return {
    encode: (bytes) => {
      if (!isBytes(bytes))
        throw new Error("radix.encode input should be Uint8Array");
      return convertRadix(Array.from(bytes), _256, num);
    },
    decode: (digits) => {
      anumArr("radix.decode", digits);
      return Uint8Array.from(convertRadix(digits, num, _256));
    }
  };
}
function radix2(bits, revPadding = false) {
  anumber(bits);
  if (bits <= 0 || bits > 32)
    throw new Error("radix2: bits should be in (0..32]");
  if (radix2carry(8, bits) > 32 || radix2carry(bits, 8) > 32)
    throw new Error("radix2: carry overflow");
  return {
    encode: (bytes) => {
      if (!isBytes(bytes))
        throw new Error("radix2.encode input should be Uint8Array");
      return convertRadix2(Array.from(bytes), 8, bits, !revPadding);
    },
    decode: (digits) => {
      anumArr("radix2.decode", digits);
      return Uint8Array.from(convertRadix2(digits, bits, 8, revPadding));
    }
  };
}
function unsafeWrapper(fn) {
  afn(fn);
  return function(...args) {
    try {
      return fn.apply(null, args);
    } catch (e) {}
  };
}
var base16 = chain(radix2(4), alphabet("0123456789ABCDEF"), join4(""));
var base32 = chain(radix2(5), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"), padding(5), join4(""));
var base32nopad = chain(radix2(5), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"), join4(""));
var base32hex = chain(radix2(5), alphabet("0123456789ABCDEFGHIJKLMNOPQRSTUV"), padding(5), join4(""));
var base32hexnopad = chain(radix2(5), alphabet("0123456789ABCDEFGHIJKLMNOPQRSTUV"), join4(""));
var base32crockford = chain(radix2(5), alphabet("0123456789ABCDEFGHJKMNPQRSTVWXYZ"), join4(""), normalize((s) => s.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1")));
var hasBase64Builtin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toBase64 === "function" && typeof Uint8Array.fromBase64 === "function")();
var decodeBase64Builtin = (s, isUrl) => {
  astr("base64", s);
  const re = isUrl ? /^[A-Za-z0-9=_-]+$/ : /^[A-Za-z0-9=+/]+$/;
  const alphabet2 = isUrl ? "base64url" : "base64";
  if (s.length > 0 && !re.test(s))
    throw new Error("invalid base64");
  return Uint8Array.fromBase64(s, { alphabet: alphabet2, lastChunkHandling: "strict" });
};
var base64 = hasBase64Builtin ? {
  encode(b) {
    abytes(b);
    return b.toBase64();
  },
  decode(s) {
    return decodeBase64Builtin(s, false);
  }
} : chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"), padding(6), join4(""));
var base64nopad = chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"), join4(""));
var base64url = hasBase64Builtin ? {
  encode(b) {
    abytes(b);
    return b.toBase64({ alphabet: "base64url" });
  },
  decode(s) {
    return decodeBase64Builtin(s, true);
  }
} : chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"), padding(6), join4(""));
var base64urlnopad = chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"), join4(""));
var genBase58 = (abc) => chain(radix(58), alphabet(abc), join4(""));
var base58 = genBase58("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz");
var base58flickr = genBase58("123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ");
var base58xrp = genBase58("rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz");
var BECH_ALPHABET = chain(alphabet("qpzry9x8gf2tvdw0s3jn54khce6mua7l"), join4(""));
var POLYMOD_GENERATORS = [996825010, 642813549, 513874426, 1027748829, 705979059];
function bech32Polymod(pre) {
  const b = pre >> 25;
  let chk = (pre & 33554431) << 5;
  for (let i = 0;i < POLYMOD_GENERATORS.length; i++) {
    if ((b >> i & 1) === 1)
      chk ^= POLYMOD_GENERATORS[i];
  }
  return chk;
}
function bechChecksum(prefix, words, encodingConst = 1) {
  const len = prefix.length;
  let chk = 1;
  for (let i = 0;i < len; i++) {
    const c = prefix.charCodeAt(i);
    if (c < 33 || c > 126)
      throw new Error(`Invalid prefix (${prefix})`);
    chk = bech32Polymod(chk) ^ c >> 5;
  }
  chk = bech32Polymod(chk);
  for (let i = 0;i < len; i++)
    chk = bech32Polymod(chk) ^ prefix.charCodeAt(i) & 31;
  for (let v of words)
    chk = bech32Polymod(chk) ^ v;
  for (let i = 0;i < 6; i++)
    chk = bech32Polymod(chk);
  chk ^= encodingConst;
  return BECH_ALPHABET.encode(convertRadix2([chk % powers[30]], 30, 5, false));
}
function genBech32(encoding) {
  const ENCODING_CONST = encoding === "bech32" ? 1 : 734539939;
  const _words = radix2(5);
  const fromWords = _words.decode;
  const toWords = _words.encode;
  const fromWordsUnsafe = unsafeWrapper(fromWords);
  function encode(prefix, words, limit = 90) {
    astr("bech32.encode prefix", prefix);
    if (isBytes(words))
      words = Array.from(words);
    anumArr("bech32.encode", words);
    const plen = prefix.length;
    if (plen === 0)
      throw new TypeError(`Invalid prefix length ${plen}`);
    const actualLength = plen + 7 + words.length;
    if (limit !== false && actualLength > limit)
      throw new TypeError(`Length ${actualLength} exceeds limit ${limit}`);
    const lowered = prefix.toLowerCase();
    const sum = bechChecksum(lowered, words, ENCODING_CONST);
    return `${lowered}1${BECH_ALPHABET.encode(words)}${sum}`;
  }
  function decode(str, limit = 90) {
    astr("bech32.decode input", str);
    const slen = str.length;
    if (slen < 8 || limit !== false && slen > limit)
      throw new TypeError(`invalid string length: ${slen} (${str}). Expected (8..${limit})`);
    const lowered = str.toLowerCase();
    if (str !== lowered && str !== str.toUpperCase())
      throw new Error(`String must be lowercase or uppercase`);
    const sepIndex = lowered.lastIndexOf("1");
    if (sepIndex === 0 || sepIndex === -1)
      throw new Error(`Letter "1" must be present between prefix and data only`);
    const prefix = lowered.slice(0, sepIndex);
    const data = lowered.slice(sepIndex + 1);
    if (data.length < 6)
      throw new Error("Data must be at least 6 characters long");
    const words = BECH_ALPHABET.decode(data).slice(0, -6);
    const sum = bechChecksum(prefix, words, ENCODING_CONST);
    if (!data.endsWith(sum))
      throw new Error(`Invalid checksum in ${str}: expected "${sum}"`);
    return { prefix, words };
  }
  const decodeUnsafe = unsafeWrapper(decode);
  function decodeToBytes(str) {
    const { prefix, words } = decode(str, false);
    return { prefix, words, bytes: fromWords(words) };
  }
  function encodeFromBytes(prefix, bytes) {
    return encode(prefix, toWords(bytes));
  }
  return {
    encode,
    decode,
    encodeFromBytes,
    decodeToBytes,
    decodeUnsafe,
    fromWords,
    fromWordsUnsafe,
    toWords
  };
}
var bech32 = genBech32("bech32");
var bech32m = genBech32("bech32m");
var hasHexBuiltin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function")();
var hexBuiltin = {
  encode(data) {
    abytes(data);
    return data.toHex();
  },
  decode(s) {
    astr("hex", s);
    return Uint8Array.fromHex(s);
  }
};
var hex = hasHexBuiltin ? hexBuiltin : chain(radix2(4), alphabet("0123456789abcdef"), join4(""), normalize((s) => {
  if (typeof s !== "string" || s.length % 2 !== 0)
    throw new TypeError(`hex.decode: expected string, got ${typeof s} with length ${s.length}`);
  return s.toLowerCase();
}));

// ../../node_modules/@hpke/chacha20poly1305/esm/src/chacha/utils.js
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abool(b) {
  if (typeof b !== "boolean")
    throw new Error(`boolean expected, not ${b}`);
}
function anumber2(n) {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error("positive integer expected, got " + n);
  }
}
function abytes2(value, length, title = "") {
  const bytes = isBytes2(value);
  const len = value?.length;
  const needsLen = length !== undefined;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished) {
    throw new Error("Hash#digest() has already been called");
  }
}
function aoutput(out, instance) {
  abytes2(out, undefined, "output");
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean(...arrays) {
  for (let i = 0;i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
var isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
function checkOpts(defaults, opts) {
  if (opts == null || typeof opts !== "object") {
    throw new Error("options must be defined");
  }
  const merged = Object.assign(defaults, opts);
  return merged;
}
function equalBytes(a, b) {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0;i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
var wrapCipher = (params, constructor) => {
  function wrappedCipher(key, ...args) {
    abytes2(key, undefined, "key");
    if (!isLE) {
      throw new Error("Non little-endian hardware is not yet supported");
    }
    if (params.nonceLength !== undefined) {
      const nonce = args[0];
      abytes2(nonce, params.varSizeNonce ? undefined : params.nonceLength, "nonce");
    }
    const tagl = params.tagLength;
    if (tagl && args[1] !== undefined)
      abytes2(args[1], undefined, "AAD");
    const cipher = constructor(key, ...args);
    const checkOutput = (fnLength, output) => {
      if (output !== undefined) {
        if (fnLength !== 2)
          throw new Error("cipher output not supported");
        abytes2(output, undefined, "output");
      }
    };
    let called = false;
    const wrCipher = {
      encrypt(data, output) {
        if (called) {
          throw new Error("cannot encrypt() twice with same key + nonce");
        }
        called = true;
        abytes2(data);
        checkOutput(cipher.encrypt.length, output);
        return cipher.encrypt(data, output);
      },
      decrypt(data, output) {
        abytes2(data);
        if (tagl && data.length < tagl) {
          throw new Error('"ciphertext" expected length bigger than tagLength=' + tagl);
        }
        checkOutput(cipher.decrypt.length, output);
        return cipher.decrypt(data, output);
      }
    };
    return wrCipher;
  }
  Object.assign(wrappedCipher, params);
  return wrappedCipher;
};
function getOutput(expectedLength, out, onlyAligned = true) {
  if (out === undefined)
    return new Uint8Array(expectedLength);
  if (out.length !== expectedLength) {
    throw new Error('"output" expected Uint8Array of length ' + expectedLength + ", got: " + out.length);
  }
  if (onlyAligned && !isAligned32(out)) {
    throw new Error("invalid output, must be aligned");
  }
  return out;
}
function u64Lengths(dataLength, aadLength, isLE2) {
  abool(isLE2);
  const num = new Uint8Array(16);
  const view = createView(num);
  view.setBigUint64(0, BigInt(aadLength), isLE2);
  view.setBigUint64(8, BigInt(dataLength), isLE2);
  return num;
}
function isAligned32(bytes) {
  return bytes.byteOffset % 4 === 0;
}
function copyBytes(bytes) {
  return Uint8Array.from(bytes);
}

// ../../node_modules/@hpke/chacha20poly1305/esm/src/chacha/_arx.js
var _utf8ToBytes = (str) => Uint8Array.from(str.split("").map((c) => c.charCodeAt(0)));
var sigma16 = _utf8ToBytes("expand 16-byte k");
var sigma32 = _utf8ToBytes("expand 32-byte k");
var sigma16_32 = u32(sigma16);
var sigma32_32 = u32(sigma32);
function rotl(a, b) {
  return a << b | a >>> 32 - b;
}
function isAligned322(b) {
  return b.byteOffset % 4 === 0;
}
var BLOCK_LEN = 64;
var BLOCK_LEN32 = 16;
var MAX_COUNTER = 2 ** 32 - 1;
var U32_EMPTY = Uint32Array.of();
function runCipher(core, sigma, key, nonce, data, output, counter, rounds) {
  const len = data.length;
  const block = new Uint8Array(BLOCK_LEN);
  const b32 = u32(block);
  const isAligned = isAligned322(data) && isAligned322(output);
  const d32 = isAligned ? u32(data) : U32_EMPTY;
  const o32 = isAligned ? u32(output) : U32_EMPTY;
  for (let pos = 0;pos < len; counter++) {
    core(sigma, key, nonce, b32, counter, rounds);
    if (counter >= MAX_COUNTER)
      throw new Error("arx: counter overflow");
    const take = Math.min(BLOCK_LEN, len - pos);
    if (isAligned && take === BLOCK_LEN) {
      const pos32 = pos / 4;
      if (pos % 4 !== 0)
        throw new Error("arx: invalid block position");
      for (let j = 0, posj;j < BLOCK_LEN32; j++) {
        posj = pos32 + j;
        o32[posj] = d32[posj] ^ b32[j];
      }
      pos += BLOCK_LEN;
      continue;
    }
    for (let j = 0, posj;j < take; j++) {
      posj = pos + j;
      output[posj] = data[posj] ^ block[j];
    }
    pos += take;
  }
}
function createCipher(core, opts) {
  const { allowShortKeys, extendNonceFn, counterLength, counterRight, rounds } = checkOpts({
    allowShortKeys: false,
    counterLength: 8,
    counterRight: false,
    rounds: 20
  }, opts);
  if (typeof core !== "function")
    throw new Error("core must be a function");
  anumber2(counterLength);
  anumber2(rounds);
  abool(counterRight);
  abool(allowShortKeys);
  return (key, nonce, data, output, counter = 0) => {
    abytes2(key, undefined, "key");
    abytes2(nonce, undefined, "nonce");
    abytes2(data, undefined, "data");
    const len = data.length;
    if (output === undefined)
      output = new Uint8Array(len);
    abytes2(output, undefined, "output");
    anumber2(counter);
    if (counter < 0 || counter >= MAX_COUNTER) {
      throw new Error("arx: counter overflow");
    }
    if (output.length < len) {
      throw new Error(`arx: output (${output.length}) is shorter than data (${len})`);
    }
    const toClean = [];
    const l = key.length;
    let k;
    let sigma;
    if (l === 32) {
      toClean.push(k = copyBytes(key));
      sigma = sigma32_32;
    } else if (l === 16 && allowShortKeys) {
      k = new Uint8Array(32);
      k.set(key);
      k.set(key, 16);
      sigma = sigma16_32;
      toClean.push(k);
    } else {
      abytes2(key, 32, "arx key");
      throw new Error("invalid key size");
    }
    if (!isAligned322(nonce))
      toClean.push(nonce = copyBytes(nonce));
    const k32 = u32(k);
    if (extendNonceFn) {
      if (nonce.length !== 24) {
        throw new Error(`arx: extended nonce must be 24 bytes`);
      }
      extendNonceFn(sigma, k32, u32(nonce.subarray(0, 16)), k32);
      nonce = nonce.subarray(16);
    }
    const nonceNcLen = 16 - counterLength;
    if (nonceNcLen !== nonce.length) {
      throw new Error(`arx: nonce must be ${nonceNcLen} or 16 bytes`);
    }
    if (nonceNcLen !== 12) {
      const nc = new Uint8Array(12);
      nc.set(nonce, counterRight ? 0 : 12 - nonce.length);
      nonce = nc;
      toClean.push(nonce);
    }
    const n32 = u32(nonce);
    runCipher(core, sigma, k32, n32, data, output, counter, rounds);
    clean(...toClean);
    return output;
  };
}

// ../../node_modules/@hpke/chacha20poly1305/esm/src/chacha/_poly1305.js
function u8to16(a, i) {
  return a[i++] & 255 | (a[i++] & 255) << 8;
}

class Poly1305 {
  constructor(key) {
    Object.defineProperty(this, "blockLen", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 16
    });
    Object.defineProperty(this, "outputLen", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 16
    });
    Object.defineProperty(this, "buffer", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: new Uint8Array(16)
    });
    Object.defineProperty(this, "r", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: new Uint16Array(10)
    });
    Object.defineProperty(this, "h", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: new Uint16Array(10)
    });
    Object.defineProperty(this, "pad", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: new Uint16Array(8)
    });
    Object.defineProperty(this, "pos", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "finished", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: false
    });
    key = copyBytes(abytes2(key, 32, "key"));
    const t0 = u8to16(key, 0);
    const t1 = u8to16(key, 2);
    const t2 = u8to16(key, 4);
    const t3 = u8to16(key, 6);
    const t4 = u8to16(key, 8);
    const t5 = u8to16(key, 10);
    const t6 = u8to16(key, 12);
    const t7 = u8to16(key, 14);
    this.r[0] = t0 & 8191;
    this.r[1] = (t0 >>> 13 | t1 << 3) & 8191;
    this.r[2] = (t1 >>> 10 | t2 << 6) & 7939;
    this.r[3] = (t2 >>> 7 | t3 << 9) & 8191;
    this.r[4] = (t3 >>> 4 | t4 << 12) & 255;
    this.r[5] = t4 >>> 1 & 8190;
    this.r[6] = (t4 >>> 14 | t5 << 2) & 8191;
    this.r[7] = (t5 >>> 11 | t6 << 5) & 8065;
    this.r[8] = (t6 >>> 8 | t7 << 8) & 8191;
    this.r[9] = t7 >>> 5 & 127;
    for (let i = 0;i < 8; i++)
      this.pad[i] = u8to16(key, 16 + 2 * i);
  }
  process(data, offset, isLast = false) {
    const hibit = isLast ? 0 : 1 << 11;
    const { h, r } = this;
    const r0 = r[0];
    const r1 = r[1];
    const r2 = r[2];
    const r3 = r[3];
    const r4 = r[4];
    const r5 = r[5];
    const r6 = r[6];
    const r7 = r[7];
    const r8 = r[8];
    const r9 = r[9];
    const t0 = u8to16(data, offset + 0);
    const t1 = u8to16(data, offset + 2);
    const t2 = u8to16(data, offset + 4);
    const t3 = u8to16(data, offset + 6);
    const t4 = u8to16(data, offset + 8);
    const t5 = u8to16(data, offset + 10);
    const t6 = u8to16(data, offset + 12);
    const t7 = u8to16(data, offset + 14);
    const h0 = h[0] + (t0 & 8191);
    const h1 = h[1] + ((t0 >>> 13 | t1 << 3) & 8191);
    const h2 = h[2] + ((t1 >>> 10 | t2 << 6) & 8191);
    const h3 = h[3] + ((t2 >>> 7 | t3 << 9) & 8191);
    const h4 = h[4] + ((t3 >>> 4 | t4 << 12) & 8191);
    const h5 = h[5] + (t4 >>> 1 & 8191);
    const h6 = h[6] + ((t4 >>> 14 | t5 << 2) & 8191);
    const h7 = h[7] + ((t5 >>> 11 | t6 << 5) & 8191);
    const h8 = h[8] + ((t6 >>> 8 | t7 << 8) & 8191);
    const h9 = h[9] + (t7 >>> 5 | hibit);
    let c = 0;
    let d0 = c + h0 * r0 + h1 * (5 * r9) + h2 * (5 * r8) + h3 * (5 * r7) + h4 * (5 * r6);
    c = d0 >>> 13;
    d0 &= 8191;
    d0 += h5 * (5 * r5) + h6 * (5 * r4) + h7 * (5 * r3) + h8 * (5 * r2) + h9 * (5 * r1);
    c += d0 >>> 13;
    d0 &= 8191;
    let d1 = c + h0 * r1 + h1 * r0 + h2 * (5 * r9) + h3 * (5 * r8) + h4 * (5 * r7);
    c = d1 >>> 13;
    d1 &= 8191;
    d1 += h5 * (5 * r6) + h6 * (5 * r5) + h7 * (5 * r4) + h8 * (5 * r3) + h9 * (5 * r2);
    c += d1 >>> 13;
    d1 &= 8191;
    let d2 = c + h0 * r2 + h1 * r1 + h2 * r0 + h3 * (5 * r9) + h4 * (5 * r8);
    c = d2 >>> 13;
    d2 &= 8191;
    d2 += h5 * (5 * r7) + h6 * (5 * r6) + h7 * (5 * r5) + h8 * (5 * r4) + h9 * (5 * r3);
    c += d2 >>> 13;
    d2 &= 8191;
    let d3 = c + h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * (5 * r9);
    c = d3 >>> 13;
    d3 &= 8191;
    d3 += h5 * (5 * r8) + h6 * (5 * r7) + h7 * (5 * r6) + h8 * (5 * r5) + h9 * (5 * r4);
    c += d3 >>> 13;
    d3 &= 8191;
    let d4 = c + h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;
    c = d4 >>> 13;
    d4 &= 8191;
    d4 += h5 * (5 * r9) + h6 * (5 * r8) + h7 * (5 * r7) + h8 * (5 * r6) + h9 * (5 * r5);
    c += d4 >>> 13;
    d4 &= 8191;
    let d5 = c + h0 * r5 + h1 * r4 + h2 * r3 + h3 * r2 + h4 * r1;
    c = d5 >>> 13;
    d5 &= 8191;
    d5 += h5 * r0 + h6 * (5 * r9) + h7 * (5 * r8) + h8 * (5 * r7) + h9 * (5 * r6);
    c += d5 >>> 13;
    d5 &= 8191;
    let d6 = c + h0 * r6 + h1 * r5 + h2 * r4 + h3 * r3 + h4 * r2;
    c = d6 >>> 13;
    d6 &= 8191;
    d6 += h5 * r1 + h6 * r0 + h7 * (5 * r9) + h8 * (5 * r8) + h9 * (5 * r7);
    c += d6 >>> 13;
    d6 &= 8191;
    let d7 = c + h0 * r7 + h1 * r6 + h2 * r5 + h3 * r4 + h4 * r3;
    c = d7 >>> 13;
    d7 &= 8191;
    d7 += h5 * r2 + h6 * r1 + h7 * r0 + h8 * (5 * r9) + h9 * (5 * r8);
    c += d7 >>> 13;
    d7 &= 8191;
    let d8 = c + h0 * r8 + h1 * r7 + h2 * r6 + h3 * r5 + h4 * r4;
    c = d8 >>> 13;
    d8 &= 8191;
    d8 += h5 * r3 + h6 * r2 + h7 * r1 + h8 * r0 + h9 * (5 * r9);
    c += d8 >>> 13;
    d8 &= 8191;
    let d9 = c + h0 * r9 + h1 * r8 + h2 * r7 + h3 * r6 + h4 * r5;
    c = d9 >>> 13;
    d9 &= 8191;
    d9 += h5 * r4 + h6 * r3 + h7 * r2 + h8 * r1 + h9 * r0;
    c += d9 >>> 13;
    d9 &= 8191;
    c = (c << 2) + c | 0;
    c = c + d0 | 0;
    d0 = c & 8191;
    c = c >>> 13;
    d1 += c;
    h[0] = d0;
    h[1] = d1;
    h[2] = d2;
    h[3] = d3;
    h[4] = d4;
    h[5] = d5;
    h[6] = d6;
    h[7] = d7;
    h[8] = d8;
    h[9] = d9;
  }
  finalize() {
    const { h, pad } = this;
    const g = new Uint16Array(10);
    let c = h[1] >>> 13;
    h[1] &= 8191;
    for (let i = 2;i < 10; i++) {
      h[i] += c;
      c = h[i] >>> 13;
      h[i] &= 8191;
    }
    h[0] += c * 5;
    c = h[0] >>> 13;
    h[0] &= 8191;
    h[1] += c;
    c = h[1] >>> 13;
    h[1] &= 8191;
    h[2] += c;
    g[0] = h[0] + 5;
    c = g[0] >>> 13;
    g[0] &= 8191;
    for (let i = 1;i < 10; i++) {
      g[i] = h[i] + c;
      c = g[i] >>> 13;
      g[i] &= 8191;
    }
    g[9] -= 1 << 13;
    let mask = (c ^ 1) - 1;
    for (let i = 0;i < 10; i++)
      g[i] &= mask;
    mask = ~mask;
    for (let i = 0;i < 10; i++)
      h[i] = h[i] & mask | g[i];
    h[0] = (h[0] | h[1] << 13) & 65535;
    h[1] = (h[1] >>> 3 | h[2] << 10) & 65535;
    h[2] = (h[2] >>> 6 | h[3] << 7) & 65535;
    h[3] = (h[3] >>> 9 | h[4] << 4) & 65535;
    h[4] = (h[4] >>> 12 | h[5] << 1 | h[6] << 14) & 65535;
    h[5] = (h[6] >>> 2 | h[7] << 11) & 65535;
    h[6] = (h[7] >>> 5 | h[8] << 8) & 65535;
    h[7] = (h[8] >>> 8 | h[9] << 5) & 65535;
    let f = h[0] + pad[0];
    h[0] = f & 65535;
    for (let i = 1;i < 8; i++) {
      f = (h[i] + pad[i] | 0) + (f >>> 16) | 0;
      h[i] = f & 65535;
    }
    clean(g);
  }
  update(data) {
    aexists(this);
    abytes2(data);
    data = copyBytes(data);
    const { buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0;pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        for (;blockLen <= len - pos; pos += blockLen)
          this.process(data, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(buffer, 0, false);
        this.pos = 0;
      }
    }
    return this;
  }
  destroy() {
    clean(this.h, this.r, this.buffer, this.pad);
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, h } = this;
    let { pos } = this;
    if (pos) {
      buffer[pos++] = 1;
      for (;pos < 16; pos++)
        buffer[pos] = 0;
      this.process(buffer, 0, true);
    }
    this.finalize();
    let opos = 0;
    for (let i = 0;i < 8; i++) {
      out[opos++] = h[i] >>> 0;
      out[opos++] = h[i] >>> 8;
    }
    return out;
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
}
function wrapConstructorWithKey(hashCons) {
  const hashC = (msg, key) => hashCons(key).update(msg).digest();
  const tmp = hashCons(new Uint8Array(32));
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = (key) => hashCons(key);
  return hashC;
}
var poly1305 = /* @__PURE__ */ (() => wrapConstructorWithKey((key) => new Poly1305(key)))();

// ../../node_modules/@hpke/chacha20poly1305/esm/src/chacha/chacha.js
function chachaCore(s, k, n, out, cnt, rounds = 20) {
  const y00 = s[0], y01 = s[1], y02 = s[2], y03 = s[3], y04 = k[0], y05 = k[1], y06 = k[2], y07 = k[3], y08 = k[4], y09 = k[5], y10 = k[6], y11 = k[7], y12 = cnt, y13 = n[0], y14 = n[1], y15 = n[2];
  let x00 = y00, x01 = y01, x02 = y02, x03 = y03, x04 = y04, x05 = y05, x06 = y06, x07 = y07, x08 = y08, x09 = y09, x10 = y10, x11 = y11, x12 = y12, x13 = y13, x14 = y14, x15 = y15;
  for (let r = 0;r < rounds; r += 2) {
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 16);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 12);
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 8);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 7);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 16);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 12);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 8);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 7);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 16);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 12);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 8);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 7);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 16);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 12);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 8);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 7);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 16);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 12);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 8);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 7);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 16);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 12);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 8);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 7);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 16);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 12);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 8);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 7);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 16);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 12);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 8);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 7);
  }
  let oi = 0;
  out[oi++] = y00 + x00 | 0;
  out[oi++] = y01 + x01 | 0;
  out[oi++] = y02 + x02 | 0;
  out[oi++] = y03 + x03 | 0;
  out[oi++] = y04 + x04 | 0;
  out[oi++] = y05 + x05 | 0;
  out[oi++] = y06 + x06 | 0;
  out[oi++] = y07 + x07 | 0;
  out[oi++] = y08 + x08 | 0;
  out[oi++] = y09 + x09 | 0;
  out[oi++] = y10 + x10 | 0;
  out[oi++] = y11 + x11 | 0;
  out[oi++] = y12 + x12 | 0;
  out[oi++] = y13 + x13 | 0;
  out[oi++] = y14 + x14 | 0;
  out[oi++] = y15 + x15 | 0;
}
var chacha20 = /* @__PURE__ */ createCipher(chachaCore, {
  counterRight: false,
  counterLength: 4,
  allowShortKeys: false
});
var ZEROS16 = /* @__PURE__ */ new Uint8Array(16);
var updatePadded = (h, msg) => {
  h.update(msg);
  const leftover = msg.length % 16;
  if (leftover)
    h.update(ZEROS16.subarray(leftover));
};
var ZEROS32 = /* @__PURE__ */ new Uint8Array(32);
function computeTag(fn, key, nonce, ciphertext, AAD) {
  if (AAD !== undefined)
    abytes2(AAD, undefined, "AAD");
  const authKey = fn(key, nonce, ZEROS32);
  const lengths = u64Lengths(ciphertext.length, AAD ? AAD.length : 0, true);
  const h = poly1305.create(authKey);
  if (AAD)
    updatePadded(h, AAD);
  updatePadded(h, ciphertext);
  h.update(lengths);
  const res = h.digest();
  clean(authKey, lengths);
  return res;
}
var _poly1305_aead = (xorStream) => (key, nonce, AAD) => {
  const tagLength = 16;
  return {
    encrypt(plaintext, output) {
      const plength = plaintext.length;
      output = getOutput(plength + tagLength, output, false);
      output.set(plaintext);
      const oPlain = output.subarray(0, -tagLength);
      xorStream(key, nonce, oPlain, oPlain, 1);
      const tag = computeTag(xorStream, key, nonce, oPlain, AAD);
      output.set(tag, plength);
      clean(tag);
      return output;
    },
    decrypt(ciphertext, output) {
      output = getOutput(ciphertext.length - tagLength, output, false);
      const data = ciphertext.subarray(0, -tagLength);
      const passedTag = ciphertext.subarray(-tagLength);
      const tag = computeTag(xorStream, key, nonce, data, AAD);
      if (!equalBytes(passedTag, tag))
        throw new Error("invalid tag");
      output.set(ciphertext.subarray(0, -tagLength));
      xorStream(key, nonce, output, output, 1);
      clean(tag);
      return output;
    }
  };
};
var chacha20poly1305 = /* @__PURE__ */ wrapCipher({ blockSize: 64, nonceLength: 12, tagLength: 16 }, _poly1305_aead(chacha20));

// ../../node_modules/@hpke/common/esm/src/errors.js
class HpkeError extends Error {
  constructor(e) {
    let message;
    if (e instanceof Error) {
      message = e.message;
    } else if (typeof e === "string") {
      message = e;
    } else {
      message = "";
    }
    super(message);
    this.name = this.constructor.name;
  }
}

class InvalidParamError extends HpkeError {
}
class SerializeError extends HpkeError {
}

class DeserializeError extends HpkeError {
}

class EncapError extends HpkeError {
}

class DecapError extends HpkeError {
}

class ExportError extends HpkeError {
}

class SealError extends HpkeError {
}

class OpenError extends HpkeError {
}

class MessageLimitReachedError extends HpkeError {
}

class DeriveKeyPairError extends HpkeError {
}

class NotSupportedError extends HpkeError {
}
// ../../node_modules/@hpke/common/esm/_dnt.shims.js
var dntGlobals = {};
var dntGlobalThis = createMergeProxy(globalThis, dntGlobals);
function createMergeProxy(baseObj, extObj) {
  return new Proxy(baseObj, {
    get(_target, prop, _receiver) {
      if (prop in extObj) {
        return extObj[prop];
      } else {
        return baseObj[prop];
      }
    },
    set(_target, prop, value) {
      if (prop in extObj) {
        delete extObj[prop];
      }
      baseObj[prop] = value;
      return true;
    },
    deleteProperty(_target, prop) {
      let success = false;
      if (prop in extObj) {
        delete extObj[prop];
        success = true;
      }
      if (prop in baseObj) {
        delete baseObj[prop];
        success = true;
      }
      return success;
    },
    ownKeys(_target) {
      const baseKeys = Reflect.ownKeys(baseObj);
      const extKeys = Reflect.ownKeys(extObj);
      const extKeysSet = new Set(extKeys);
      return [...baseKeys.filter((k) => !extKeysSet.has(k)), ...extKeys];
    },
    defineProperty(_target, prop, desc) {
      if (prop in extObj) {
        delete extObj[prop];
      }
      Reflect.defineProperty(baseObj, prop, desc);
      return true;
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (prop in extObj) {
        return Reflect.getOwnPropertyDescriptor(extObj, prop);
      } else {
        return Reflect.getOwnPropertyDescriptor(baseObj, prop);
      }
    },
    has(_target, prop) {
      return prop in extObj || prop in baseObj;
    }
  });
}

// ../../node_modules/@hpke/common/esm/src/algorithm.js
async function loadSubtleCrypto() {
  if (dntGlobalThis !== undefined && globalThis.crypto !== undefined) {
    return globalThis.crypto.subtle;
  }
  try {
    const { webcrypto } = await import("crypto");
    return webcrypto.subtle;
  } catch (e) {
    throw new NotSupportedError(e);
  }
}

class NativeAlgorithm {
  constructor() {
    Object.defineProperty(this, "_api", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
  }
  async _setup() {
    if (this._api !== undefined) {
      return;
    }
    this._api = await loadSubtleCrypto();
  }
}
// ../../node_modules/@hpke/common/esm/src/identifiers.js
var Mode = {
  Base: 0,
  Psk: 1,
  Auth: 2,
  AuthPsk: 3
};
var KemId = {
  NotAssigned: 0,
  DhkemP256HkdfSha256: 16,
  DhkemP384HkdfSha384: 17,
  DhkemP521HkdfSha512: 18,
  DhkemSecp256k1HkdfSha256: 19,
  DhkemX25519HkdfSha256: 32,
  DhkemX448HkdfSha512: 33,
  HybridkemX25519Kyber768: 48,
  MlKem512: 64,
  MlKem768: 65,
  MlKem1024: 66,
  XWing: 25722
};
var KdfId = {
  HkdfSha256: 1,
  HkdfSha384: 2,
  HkdfSha512: 3
};
var AeadId = {
  Aes128Gcm: 1,
  Aes256Gcm: 2,
  Chacha20Poly1305: 3,
  ExportOnly: 65535
};
// ../../node_modules/@hpke/common/esm/src/consts.js
var INPUT_LENGTH_LIMIT = 8192;
var INFO_LENGTH_LIMIT = 65536;
var MINIMUM_PSK_LENGTH = 32;
var EMPTY = new Uint8Array(0);

// ../../node_modules/@hpke/common/esm/src/interfaces/kemInterface.js
var SUITE_ID_HEADER_KEM = new Uint8Array([
  75,
  69,
  77,
  0,
  0
]);

// ../../node_modules/@hpke/common/esm/src/utils/misc.js
var isCryptoKeyPair = (x) => typeof x === "object" && x !== null && typeof x.privateKey === "object" && typeof x.publicKey === "object";
function i2Osp(n, w) {
  if (w <= 0) {
    throw new Error("i2Osp: too small size");
  }
  if (n >= 256 ** w) {
    throw new Error("i2Osp: too large integer");
  }
  const ret = new Uint8Array(w);
  for (let i = 0;i < w && n; i++) {
    ret[w - (i + 1)] = n % 256;
    n = n >> 8;
  }
  return ret;
}
function concat(a, b) {
  const ret = new Uint8Array(a.length + b.length);
  ret.set(a, 0);
  ret.set(b, a.length);
  return ret;
}
function base64UrlToBytes(v) {
  const base642 = v.replace(/-/g, "+").replace(/_/g, "/");
  const byteString = atob(base642);
  const ret = new Uint8Array(byteString.length);
  for (let i = 0;i < byteString.length; i++) {
    ret[i] = byteString.charCodeAt(i);
  }
  return ret;
}
function xor(a, b) {
  if (a.byteLength !== b.byteLength) {
    throw new Error("xor: different length inputs");
  }
  const buf = new Uint8Array(a.byteLength);
  for (let i = 0;i < a.byteLength; i++) {
    buf[i] = a[i] ^ b[i];
  }
  return buf;
}

// ../../node_modules/@hpke/common/esm/src/kems/dhkem.js
var LABEL_EAE_PRK = new Uint8Array([101, 97, 101, 95, 112, 114, 107]);
var LABEL_SHARED_SECRET = new Uint8Array([
  115,
  104,
  97,
  114,
  101,
  100,
  95,
  115,
  101,
  99,
  114,
  101,
  116
]);
function concat3(a, b, c) {
  const ret = new Uint8Array(a.length + b.length + c.length);
  ret.set(a, 0);
  ret.set(b, a.length);
  ret.set(c, a.length + b.length);
  return ret;
}

class Dhkem {
  constructor(id, prim, kdf) {
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "secretSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "encSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "publicKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "privateKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "_prim", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_kdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    this.id = id;
    this._prim = prim;
    this._kdf = kdf;
    const suiteId = new Uint8Array(SUITE_ID_HEADER_KEM);
    suiteId.set(i2Osp(this.id, 2), 3);
    this._kdf.init(suiteId);
  }
  async serializePublicKey(key) {
    return await this._prim.serializePublicKey(key);
  }
  async deserializePublicKey(key) {
    return await this._prim.deserializePublicKey(key);
  }
  async serializePrivateKey(key) {
    return await this._prim.serializePrivateKey(key);
  }
  async deserializePrivateKey(key) {
    return await this._prim.deserializePrivateKey(key);
  }
  async importKey(format, key, isPublic = true) {
    return await this._prim.importKey(format, key, isPublic);
  }
  async generateKeyPair() {
    return await this._prim.generateKeyPair();
  }
  async deriveKeyPair(ikm) {
    if (ikm.byteLength > INPUT_LENGTH_LIMIT) {
      throw new InvalidParamError("Too long ikm");
    }
    return await this._prim.deriveKeyPair(ikm);
  }
  async encap(params) {
    let ke;
    if (params.ekm === undefined) {
      ke = await this.generateKeyPair();
    } else if (isCryptoKeyPair(params.ekm)) {
      ke = params.ekm;
    } else {
      ke = await this.deriveKeyPair(params.ekm);
    }
    const enc = await this._prim.serializePublicKey(ke.publicKey);
    const pkrm = await this._prim.serializePublicKey(params.recipientPublicKey);
    try {
      let dh;
      if (params.senderKey === undefined) {
        dh = new Uint8Array(await this._prim.dh(ke.privateKey, params.recipientPublicKey));
      } else {
        const sks = isCryptoKeyPair(params.senderKey) ? params.senderKey.privateKey : params.senderKey;
        const dh1 = new Uint8Array(await this._prim.dh(ke.privateKey, params.recipientPublicKey));
        const dh2 = new Uint8Array(await this._prim.dh(sks, params.recipientPublicKey));
        dh = concat(dh1, dh2);
      }
      let kemContext;
      if (params.senderKey === undefined) {
        kemContext = concat(new Uint8Array(enc), new Uint8Array(pkrm));
      } else {
        const pks = isCryptoKeyPair(params.senderKey) ? params.senderKey.publicKey : await this._prim.derivePublicKey(params.senderKey);
        const pksm = await this._prim.serializePublicKey(pks);
        kemContext = concat3(new Uint8Array(enc), new Uint8Array(pkrm), new Uint8Array(pksm));
      }
      const sharedSecret = await this._generateSharedSecret(dh, kemContext);
      return {
        enc,
        sharedSecret
      };
    } catch (e) {
      throw new EncapError(e);
    }
  }
  async decap(params) {
    const pke = await this._prim.deserializePublicKey(params.enc);
    const skr = isCryptoKeyPair(params.recipientKey) ? params.recipientKey.privateKey : params.recipientKey;
    const pkr = isCryptoKeyPair(params.recipientKey) ? params.recipientKey.publicKey : await this._prim.derivePublicKey(params.recipientKey);
    const pkrm = await this._prim.serializePublicKey(pkr);
    try {
      let dh;
      if (params.senderPublicKey === undefined) {
        dh = new Uint8Array(await this._prim.dh(skr, pke));
      } else {
        const dh1 = new Uint8Array(await this._prim.dh(skr, pke));
        const dh2 = new Uint8Array(await this._prim.dh(skr, params.senderPublicKey));
        dh = concat(dh1, dh2);
      }
      let kemContext;
      if (params.senderPublicKey === undefined) {
        kemContext = concat(new Uint8Array(params.enc), new Uint8Array(pkrm));
      } else {
        const pksm = await this._prim.serializePublicKey(params.senderPublicKey);
        kemContext = new Uint8Array(params.enc.byteLength + pkrm.byteLength + pksm.byteLength);
        kemContext.set(new Uint8Array(params.enc), 0);
        kemContext.set(new Uint8Array(pkrm), params.enc.byteLength);
        kemContext.set(new Uint8Array(pksm), params.enc.byteLength + pkrm.byteLength);
      }
      return await this._generateSharedSecret(dh, kemContext);
    } catch (e) {
      throw new DecapError(e);
    }
  }
  async _generateSharedSecret(dh, kemContext) {
    const labeledIkm = this._kdf.buildLabeledIkm(LABEL_EAE_PRK, dh);
    const labeledInfo = this._kdf.buildLabeledInfo(LABEL_SHARED_SECRET, kemContext, this.secretSize);
    return await this._kdf.extractAndExpand(EMPTY.buffer, labeledIkm.buffer, labeledInfo.buffer, this.secretSize);
  }
}
// ../../node_modules/@hpke/common/esm/src/interfaces/dhkemPrimitives.js
var KEM_USAGES = ["deriveBits"];
var LABEL_DKP_PRK = new Uint8Array([
  100,
  107,
  112,
  95,
  112,
  114,
  107
]);
var LABEL_SK = new Uint8Array([115, 107]);

// ../../node_modules/@hpke/common/esm/src/utils/bignum.js
class Bignum {
  constructor(size) {
    Object.defineProperty(this, "_num", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    this._num = new Uint8Array(size);
  }
  val() {
    return this._num;
  }
  reset() {
    this._num.fill(0);
  }
  set(src) {
    if (src.length !== this._num.length) {
      throw new Error("Bignum.set: invalid argument");
    }
    this._num.set(src);
  }
  isZero() {
    for (let i = 0;i < this._num.length; i++) {
      if (this._num[i] !== 0) {
        return false;
      }
    }
    return true;
  }
  lessThan(v) {
    if (v.length !== this._num.length) {
      throw new Error("Bignum.lessThan: invalid argument");
    }
    for (let i = 0;i < this._num.length; i++) {
      if (this._num[i] < v[i]) {
        return true;
      }
      if (this._num[i] > v[i]) {
        return false;
      }
    }
    return false;
  }
}

// ../../node_modules/@hpke/common/esm/src/kems/dhkemPrimitives/ec.js
var LABEL_CANDIDATE = new Uint8Array([
  99,
  97,
  110,
  100,
  105,
  100,
  97,
  116,
  101
]);
var ORDER_P_256 = new Uint8Array([
  255,
  255,
  255,
  255,
  0,
  0,
  0,
  0,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  188,
  230,
  250,
  173,
  167,
  23,
  158,
  132,
  243,
  185,
  202,
  194,
  252,
  99,
  37,
  81
]);
var ORDER_P_384 = new Uint8Array([
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  199,
  99,
  77,
  129,
  244,
  55,
  45,
  223,
  88,
  26,
  13,
  178,
  72,
  176,
  167,
  122,
  236,
  236,
  25,
  106,
  204,
  197,
  41,
  115
]);
var ORDER_P_521 = new Uint8Array([
  1,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  250,
  81,
  134,
  135,
  131,
  191,
  47,
  150,
  107,
  127,
  204,
  1,
  72,
  247,
  9,
  165,
  208,
  59,
  181,
  201,
  184,
  137,
  156,
  71,
  174,
  187,
  111,
  183,
  30,
  145,
  56,
  100,
  9
]);
var PKCS8_ALG_ID_P_256 = new Uint8Array([
  48,
  65,
  2,
  1,
  0,
  48,
  19,
  6,
  7,
  42,
  134,
  72,
  206,
  61,
  2,
  1,
  6,
  8,
  42,
  134,
  72,
  206,
  61,
  3,
  1,
  7,
  4,
  39,
  48,
  37,
  2,
  1,
  1,
  4,
  32
]);
var PKCS8_ALG_ID_P_384 = new Uint8Array([
  48,
  78,
  2,
  1,
  0,
  48,
  16,
  6,
  7,
  42,
  134,
  72,
  206,
  61,
  2,
  1,
  6,
  5,
  43,
  129,
  4,
  0,
  34,
  4,
  55,
  48,
  53,
  2,
  1,
  1,
  4,
  48
]);
var PKCS8_ALG_ID_P_521 = new Uint8Array([
  48,
  96,
  2,
  1,
  0,
  48,
  16,
  6,
  7,
  42,
  134,
  72,
  206,
  61,
  2,
  1,
  6,
  5,
  43,
  129,
  4,
  0,
  35,
  4,
  73,
  48,
  71,
  2,
  1,
  1,
  4,
  66
]);

class Ec extends NativeAlgorithm {
  constructor(kem, hkdf) {
    super();
    Object.defineProperty(this, "_hkdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_alg", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_nPk", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_nSk", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_nDh", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_order", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_bitmask", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_pkcs8AlgId", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    this._hkdf = hkdf;
    switch (kem) {
      case KemId.DhkemP256HkdfSha256:
        this._alg = { name: "ECDH", namedCurve: "P-256" };
        this._nPk = 65;
        this._nSk = 32;
        this._nDh = 32;
        this._order = ORDER_P_256;
        this._bitmask = 255;
        this._pkcs8AlgId = PKCS8_ALG_ID_P_256;
        break;
      case KemId.DhkemP384HkdfSha384:
        this._alg = { name: "ECDH", namedCurve: "P-384" };
        this._nPk = 97;
        this._nSk = 48;
        this._nDh = 48;
        this._order = ORDER_P_384;
        this._bitmask = 255;
        this._pkcs8AlgId = PKCS8_ALG_ID_P_384;
        break;
      default:
        this._alg = { name: "ECDH", namedCurve: "P-521" };
        this._nPk = 133;
        this._nSk = 66;
        this._nDh = 66;
        this._order = ORDER_P_521;
        this._bitmask = 1;
        this._pkcs8AlgId = PKCS8_ALG_ID_P_521;
        break;
    }
  }
  async serializePublicKey(key) {
    await this._setup();
    try {
      return await this._api.exportKey("raw", key);
    } catch (e) {
      throw new SerializeError(e);
    }
  }
  async deserializePublicKey(key) {
    await this._setup();
    try {
      return await this._importRawKey(key, true);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async serializePrivateKey(key) {
    await this._setup();
    try {
      const jwk = await this._api.exportKey("jwk", key);
      if (!("d" in jwk)) {
        throw new Error("Not private key");
      }
      return base64UrlToBytes(jwk["d"]).buffer;
    } catch (e) {
      throw new SerializeError(e);
    }
  }
  async deserializePrivateKey(key) {
    await this._setup();
    try {
      return await this._importRawKey(key, false);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async importKey(format, key, isPublic) {
    await this._setup();
    try {
      if (format === "raw") {
        return await this._importRawKey(key, isPublic);
      }
      if (key instanceof ArrayBuffer) {
        throw new Error("Invalid jwk key format");
      }
      return await this._importJWK(key, isPublic);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async generateKeyPair() {
    await this._setup();
    try {
      return await this._api.generateKey(this._alg, true, KEM_USAGES);
    } catch (e) {
      throw new NotSupportedError(e);
    }
  }
  async deriveKeyPair(ikm) {
    await this._setup();
    try {
      const dkpPrk = await this._hkdf.labeledExtract(EMPTY.buffer, LABEL_DKP_PRK, new Uint8Array(ikm));
      const bn = new Bignum(this._nSk);
      for (let counter = 0;bn.isZero() || !bn.lessThan(this._order); counter++) {
        if (counter > 255) {
          throw new Error("Faild to derive a key pair");
        }
        const bytes = new Uint8Array(await this._hkdf.labeledExpand(dkpPrk, LABEL_CANDIDATE, i2Osp(counter, 1), this._nSk));
        bytes[0] = bytes[0] & this._bitmask;
        bn.set(bytes);
      }
      const sk = await this._deserializePkcs8Key(bn.val());
      bn.reset();
      return {
        privateKey: sk,
        publicKey: await this.derivePublicKey(sk)
      };
    } catch (e) {
      throw new DeriveKeyPairError(e);
    }
  }
  async derivePublicKey(key) {
    await this._setup();
    try {
      const jwk = await this._api.exportKey("jwk", key);
      delete jwk["d"];
      delete jwk["key_ops"];
      return await this._api.importKey("jwk", jwk, this._alg, true, []);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async dh(sk, pk) {
    try {
      await this._setup();
      const bits = await this._api.deriveBits({
        name: "ECDH",
        public: pk
      }, sk, this._nDh * 8);
      return bits;
    } catch (e) {
      throw new SerializeError(e);
    }
  }
  async _importRawKey(key, isPublic) {
    if (isPublic && key.byteLength !== this._nPk) {
      throw new Error("Invalid public key for the ciphersuite");
    }
    if (!isPublic && key.byteLength !== this._nSk) {
      throw new Error("Invalid private key for the ciphersuite");
    }
    if (isPublic) {
      return await this._api.importKey("raw", key, this._alg, true, []);
    }
    return await this._deserializePkcs8Key(new Uint8Array(key));
  }
  async _importJWK(key, isPublic) {
    if (typeof key.crv === "undefined" || key.crv !== this._alg.namedCurve) {
      throw new Error(`Invalid crv: ${key.crv}`);
    }
    if (isPublic) {
      if (typeof key.d !== "undefined") {
        throw new Error("Invalid key: `d` should not be set");
      }
      return await this._api.importKey("jwk", key, this._alg, true, []);
    }
    if (typeof key.d === "undefined") {
      throw new Error("Invalid key: `d` not found");
    }
    return await this._api.importKey("jwk", key, this._alg, true, KEM_USAGES);
  }
  async _deserializePkcs8Key(k) {
    const pkcs8Key = new Uint8Array(this._pkcs8AlgId.length + k.length);
    pkcs8Key.set(this._pkcs8AlgId, 0);
    pkcs8Key.set(k, this._pkcs8AlgId.length);
    return await this._api.importKey("pkcs8", pkcs8Key, this._alg, true, KEM_USAGES);
  }
}
// ../../node_modules/@hpke/common/esm/src/kdfs/hkdf.js
var HPKE_VERSION = new Uint8Array([72, 80, 75, 69, 45, 118, 49]);

class HkdfNative extends NativeAlgorithm {
  constructor() {
    super();
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KdfId.HkdfSha256
    });
    Object.defineProperty(this, "hashSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "_suiteId", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: EMPTY
    });
    Object.defineProperty(this, "algHash", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        name: "HMAC",
        hash: "SHA-256",
        length: 256
      }
    });
  }
  init(suiteId) {
    this._suiteId = suiteId;
  }
  buildLabeledIkm(label, ikm) {
    this._checkInit();
    const ret = new Uint8Array(7 + this._suiteId.byteLength + label.byteLength + ikm.byteLength);
    ret.set(HPKE_VERSION, 0);
    ret.set(this._suiteId, 7);
    ret.set(label, 7 + this._suiteId.byteLength);
    ret.set(ikm, 7 + this._suiteId.byteLength + label.byteLength);
    return ret;
  }
  buildLabeledInfo(label, info, len) {
    this._checkInit();
    const ret = new Uint8Array(9 + this._suiteId.byteLength + label.byteLength + info.byteLength);
    ret.set(new Uint8Array([0, len]), 0);
    ret.set(HPKE_VERSION, 2);
    ret.set(this._suiteId, 9);
    ret.set(label, 9 + this._suiteId.byteLength);
    ret.set(info, 9 + this._suiteId.byteLength + label.byteLength);
    return ret;
  }
  async extract(salt, ikm) {
    await this._setup();
    if (salt.byteLength === 0) {
      salt = new ArrayBuffer(this.hashSize);
    }
    if (salt.byteLength !== this.hashSize) {
      throw new InvalidParamError("The salt length must be the same as the hashSize");
    }
    const key = await this._api.importKey("raw", salt, this.algHash, false, [
      "sign"
    ]);
    return await this._api.sign("HMAC", key, ikm);
  }
  async expand(prk, info, len) {
    await this._setup();
    const key = await this._api.importKey("raw", prk, this.algHash, false, [
      "sign"
    ]);
    const okm = new ArrayBuffer(len);
    const p = new Uint8Array(okm);
    let prev = EMPTY;
    const mid = new Uint8Array(info);
    const tail = new Uint8Array(1);
    if (len > 255 * this.hashSize) {
      throw new Error("Entropy limit reached");
    }
    const tmp = new Uint8Array(this.hashSize + mid.length + 1);
    for (let i = 1, cur = 0;cur < p.length; i++) {
      tail[0] = i;
      tmp.set(prev, 0);
      tmp.set(mid, prev.length);
      tmp.set(tail, prev.length + mid.length);
      prev = new Uint8Array(await this._api.sign("HMAC", key, tmp.slice(0, prev.length + mid.length + 1)));
      if (p.length - cur >= prev.length) {
        p.set(prev, cur);
        cur += prev.length;
      } else {
        p.set(prev.slice(0, p.length - cur), cur);
        cur += p.length - cur;
      }
    }
    return okm;
  }
  async extractAndExpand(salt, ikm, info, len) {
    await this._setup();
    const baseKey = await this._api.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return await this._api.deriveBits({
      name: "HKDF",
      hash: this.algHash.hash,
      salt,
      info
    }, baseKey, len * 8);
  }
  async labeledExtract(salt, label, ikm) {
    return await this.extract(salt, this.buildLabeledIkm(label, ikm).buffer);
  }
  async labeledExpand(prk, label, info, len) {
    return await this.expand(prk, this.buildLabeledInfo(label, info, len).buffer, len);
  }
  _checkInit() {
    if (this._suiteId === EMPTY) {
      throw new Error("Not initialized. Call init()");
    }
  }
}

class HkdfSha256Native extends HkdfNative {
  constructor() {
    super(...arguments);
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KdfId.HkdfSha256
    });
    Object.defineProperty(this, "hashSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "algHash", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        name: "HMAC",
        hash: "SHA-256",
        length: 256
      }
    });
  }
}
// ../../node_modules/@hpke/chacha20poly1305/esm/src/chacha20Poly1305.js
class Chacha20Poly1305Context {
  constructor(key) {
    Object.defineProperty(this, "_key", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    this._key = new Uint8Array(key);
  }
  async seal(iv, data, aad) {
    return await this._seal(iv, data, aad);
  }
  async open(iv, data, aad) {
    return await this._open(iv, data, aad);
  }
  _seal(iv, data, aad) {
    return new Promise((resolve) => {
      const ret = chacha20poly1305(this._key, new Uint8Array(iv), new Uint8Array(aad)).encrypt(new Uint8Array(data));
      resolve(ret.buffer);
    });
  }
  _open(iv, data, aad) {
    return new Promise((resolve) => {
      const ret = chacha20poly1305(this._key, new Uint8Array(iv), new Uint8Array(aad)).decrypt(new Uint8Array(data));
      resolve(ret.buffer);
    });
  }
}

class Chacha20Poly1305 {
  constructor() {
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: AeadId.Chacha20Poly1305
    });
    Object.defineProperty(this, "keySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "nonceSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 12
    });
    Object.defineProperty(this, "tagSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 16
    });
  }
  createEncryptionContext(key) {
    return new Chacha20Poly1305Context(key);
  }
}
// ../../node_modules/@hpke/core/esm/src/utils/emitNotSupported.js
function emitNotSupported() {
  return new Promise((_resolve, reject) => {
    reject(new NotSupportedError("Not supported"));
  });
}

// ../../node_modules/@hpke/core/esm/src/exporterContext.js
var LABEL_SEC = new Uint8Array([115, 101, 99]);

class ExporterContextImpl {
  constructor(api, kdf, exporterSecret) {
    Object.defineProperty(this, "_api", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "exporterSecret", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_kdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    this._api = api;
    this._kdf = kdf;
    this.exporterSecret = exporterSecret;
  }
  async seal(_data, _aad) {
    return await emitNotSupported();
  }
  async open(_data, _aad) {
    return await emitNotSupported();
  }
  async export(exporterContext, len) {
    if (exporterContext.byteLength > INPUT_LENGTH_LIMIT) {
      throw new InvalidParamError("Too long exporter context");
    }
    try {
      return await this._kdf.labeledExpand(this.exporterSecret, LABEL_SEC, new Uint8Array(exporterContext), len);
    } catch (e) {
      throw new ExportError(e);
    }
  }
}

class RecipientExporterContextImpl extends ExporterContextImpl {
}

class SenderExporterContextImpl extends ExporterContextImpl {
  constructor(api, kdf, exporterSecret, enc) {
    super(api, kdf, exporterSecret);
    Object.defineProperty(this, "enc", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    this.enc = enc;
    return;
  }
}

// ../../node_modules/@hpke/core/esm/src/encryptionContext.js
class EncryptionContextImpl extends ExporterContextImpl {
  constructor(api, kdf, params) {
    super(api, kdf, params.exporterSecret);
    Object.defineProperty(this, "_aead", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_nK", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_nN", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_nT", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_ctx", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    if (params.key === undefined || params.baseNonce === undefined || params.seq === undefined) {
      throw new Error("Required parameters are missing");
    }
    this._aead = params.aead;
    this._nK = this._aead.keySize;
    this._nN = this._aead.nonceSize;
    this._nT = this._aead.tagSize;
    const key = this._aead.createEncryptionContext(params.key);
    this._ctx = {
      key,
      baseNonce: params.baseNonce,
      seq: params.seq
    };
  }
  computeNonce(k) {
    const seqBytes = i2Osp(k.seq, k.baseNonce.byteLength);
    return xor(k.baseNonce, seqBytes).buffer;
  }
  incrementSeq(k) {
    if (k.seq > Number.MAX_SAFE_INTEGER) {
      throw new MessageLimitReachedError("Message limit reached");
    }
    k.seq += 1;
    return;
  }
}

// ../../node_modules/@hpke/core/esm/src/mutex.js
var __classPrivateFieldGet = function(receiver, state, kind, f) {
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet = function(receiver, state, value, kind, f) {
  if (kind === "m")
    throw new TypeError("Private method is not writable");
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var _Mutex_locked;

class Mutex {
  constructor() {
    _Mutex_locked.set(this, Promise.resolve());
  }
  async lock() {
    let releaseLock;
    const nextLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    const previousLock = __classPrivateFieldGet(this, _Mutex_locked, "f");
    __classPrivateFieldSet(this, _Mutex_locked, nextLock, "f");
    await previousLock;
    return releaseLock;
  }
}
_Mutex_locked = new WeakMap;

// ../../node_modules/@hpke/core/esm/src/recipientContext.js
var __classPrivateFieldGet2 = function(receiver, state, kind, f) {
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet2 = function(receiver, state, value, kind, f) {
  if (kind === "m")
    throw new TypeError("Private method is not writable");
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var _RecipientContextImpl_mutex;

class RecipientContextImpl extends EncryptionContextImpl {
  constructor() {
    super(...arguments);
    _RecipientContextImpl_mutex.set(this, undefined);
  }
  async open(data, aad = EMPTY.buffer) {
    __classPrivateFieldSet2(this, _RecipientContextImpl_mutex, __classPrivateFieldGet2(this, _RecipientContextImpl_mutex, "f") ?? new Mutex, "f");
    const release = await __classPrivateFieldGet2(this, _RecipientContextImpl_mutex, "f").lock();
    let pt;
    try {
      pt = await this._ctx.key.open(this.computeNonce(this._ctx), data, aad);
    } catch (e) {
      throw new OpenError(e);
    } finally {
      release();
    }
    this.incrementSeq(this._ctx);
    return pt;
  }
}
_RecipientContextImpl_mutex = new WeakMap;

// ../../node_modules/@hpke/core/esm/src/senderContext.js
var __classPrivateFieldGet3 = function(receiver, state, kind, f) {
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet3 = function(receiver, state, value, kind, f) {
  if (kind === "m")
    throw new TypeError("Private method is not writable");
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var _SenderContextImpl_mutex;

class SenderContextImpl extends EncryptionContextImpl {
  constructor(api, kdf, params, enc) {
    super(api, kdf, params);
    Object.defineProperty(this, "enc", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    _SenderContextImpl_mutex.set(this, undefined);
    this.enc = enc;
  }
  async seal(data, aad = EMPTY.buffer) {
    __classPrivateFieldSet3(this, _SenderContextImpl_mutex, __classPrivateFieldGet3(this, _SenderContextImpl_mutex, "f") ?? new Mutex, "f");
    const release = await __classPrivateFieldGet3(this, _SenderContextImpl_mutex, "f").lock();
    let ct;
    try {
      ct = await this._ctx.key.seal(this.computeNonce(this._ctx), data, aad);
    } catch (e) {
      throw new SealError(e);
    } finally {
      release();
    }
    this.incrementSeq(this._ctx);
    return ct;
  }
}
_SenderContextImpl_mutex = new WeakMap;

// ../../node_modules/@hpke/core/esm/src/cipherSuiteNative.js
var LABEL_BASE_NONCE = new Uint8Array([
  98,
  97,
  115,
  101,
  95,
  110,
  111,
  110,
  99,
  101
]);
var LABEL_EXP = new Uint8Array([101, 120, 112]);
var LABEL_INFO_HASH = new Uint8Array([
  105,
  110,
  102,
  111,
  95,
  104,
  97,
  115,
  104
]);
var LABEL_KEY = new Uint8Array([107, 101, 121]);
var LABEL_PSK_ID_HASH = new Uint8Array([
  112,
  115,
  107,
  95,
  105,
  100,
  95,
  104,
  97,
  115,
  104
]);
var LABEL_SECRET = new Uint8Array([115, 101, 99, 114, 101, 116]);
var SUITE_ID_HEADER_HPKE = new Uint8Array([
  72,
  80,
  75,
  69,
  0,
  0,
  0,
  0,
  0,
  0
]);

class CipherSuiteNative extends NativeAlgorithm {
  constructor(params) {
    super();
    Object.defineProperty(this, "_kem", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_kdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_aead", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_suiteId", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    if (typeof params.kem === "number") {
      throw new InvalidParamError("KemId cannot be used");
    }
    this._kem = params.kem;
    if (typeof params.kdf === "number") {
      throw new InvalidParamError("KdfId cannot be used");
    }
    this._kdf = params.kdf;
    if (typeof params.aead === "number") {
      throw new InvalidParamError("AeadId cannot be used");
    }
    this._aead = params.aead;
    this._suiteId = new Uint8Array(SUITE_ID_HEADER_HPKE);
    this._suiteId.set(i2Osp(this._kem.id, 2), 4);
    this._suiteId.set(i2Osp(this._kdf.id, 2), 6);
    this._suiteId.set(i2Osp(this._aead.id, 2), 8);
    this._kdf.init(this._suiteId);
  }
  get kem() {
    return this._kem;
  }
  get kdf() {
    return this._kdf;
  }
  get aead() {
    return this._aead;
  }
  async createSenderContext(params) {
    this._validateInputLength(params);
    await this._setup();
    const dh = await this._kem.encap(params);
    let mode;
    if (params.psk !== undefined) {
      mode = params.senderKey !== undefined ? Mode.AuthPsk : Mode.Psk;
    } else {
      mode = params.senderKey !== undefined ? Mode.Auth : Mode.Base;
    }
    return await this._keyScheduleS(mode, dh.sharedSecret, dh.enc, params);
  }
  async createRecipientContext(params) {
    this._validateInputLength(params);
    await this._setup();
    const sharedSecret = await this._kem.decap(params);
    let mode;
    if (params.psk !== undefined) {
      mode = params.senderPublicKey !== undefined ? Mode.AuthPsk : Mode.Psk;
    } else {
      mode = params.senderPublicKey !== undefined ? Mode.Auth : Mode.Base;
    }
    return await this._keyScheduleR(mode, sharedSecret, params);
  }
  async seal(params, pt, aad = EMPTY.buffer) {
    const ctx = await this.createSenderContext(params);
    return {
      ct: await ctx.seal(pt, aad),
      enc: ctx.enc
    };
  }
  async open(params, ct, aad = EMPTY.buffer) {
    const ctx = await this.createRecipientContext(params);
    return await ctx.open(ct, aad);
  }
  async _keySchedule(mode, sharedSecret, params) {
    const pskId = params.psk === undefined ? EMPTY : new Uint8Array(params.psk.id);
    const pskIdHash = await this._kdf.labeledExtract(EMPTY.buffer, LABEL_PSK_ID_HASH, pskId);
    const info = params.info === undefined ? EMPTY : new Uint8Array(params.info);
    const infoHash = await this._kdf.labeledExtract(EMPTY.buffer, LABEL_INFO_HASH, info);
    const keyScheduleContext = new Uint8Array(1 + pskIdHash.byteLength + infoHash.byteLength);
    keyScheduleContext.set(new Uint8Array([mode]), 0);
    keyScheduleContext.set(new Uint8Array(pskIdHash), 1);
    keyScheduleContext.set(new Uint8Array(infoHash), 1 + pskIdHash.byteLength);
    const psk = params.psk === undefined ? EMPTY : new Uint8Array(params.psk.key);
    const ikm = this._kdf.buildLabeledIkm(LABEL_SECRET, psk).buffer;
    const exporterSecretInfo = this._kdf.buildLabeledInfo(LABEL_EXP, keyScheduleContext, this._kdf.hashSize).buffer;
    const exporterSecret = await this._kdf.extractAndExpand(sharedSecret, ikm, exporterSecretInfo, this._kdf.hashSize);
    if (this._aead.id === AeadId.ExportOnly) {
      return { aead: this._aead, exporterSecret };
    }
    const keyInfo = this._kdf.buildLabeledInfo(LABEL_KEY, keyScheduleContext, this._aead.keySize).buffer;
    const key = await this._kdf.extractAndExpand(sharedSecret, ikm, keyInfo, this._aead.keySize);
    const baseNonceInfo = this._kdf.buildLabeledInfo(LABEL_BASE_NONCE, keyScheduleContext, this._aead.nonceSize).buffer;
    const baseNonce = await this._kdf.extractAndExpand(sharedSecret, ikm, baseNonceInfo, this._aead.nonceSize);
    return {
      aead: this._aead,
      exporterSecret,
      key,
      baseNonce: new Uint8Array(baseNonce),
      seq: 0
    };
  }
  async _keyScheduleS(mode, sharedSecret, enc, params) {
    const res = await this._keySchedule(mode, sharedSecret, params);
    if (res.key === undefined) {
      return new SenderExporterContextImpl(this._api, this._kdf, res.exporterSecret, enc);
    }
    return new SenderContextImpl(this._api, this._kdf, res, enc);
  }
  async _keyScheduleR(mode, sharedSecret, params) {
    const res = await this._keySchedule(mode, sharedSecret, params);
    if (res.key === undefined) {
      return new RecipientExporterContextImpl(this._api, this._kdf, res.exporterSecret);
    }
    return new RecipientContextImpl(this._api, this._kdf, res);
  }
  _validateInputLength(params) {
    if (params.info !== undefined && params.info.byteLength > INFO_LENGTH_LIMIT) {
      throw new InvalidParamError("Too long info");
    }
    if (params.psk !== undefined) {
      if (params.psk.key.byteLength < MINIMUM_PSK_LENGTH) {
        throw new InvalidParamError(`PSK must have at least ${MINIMUM_PSK_LENGTH} bytes`);
      }
      if (params.psk.key.byteLength > INPUT_LENGTH_LIMIT) {
        throw new InvalidParamError("Too long psk.key");
      }
      if (params.psk.id.byteLength > INPUT_LENGTH_LIMIT) {
        throw new InvalidParamError("Too long psk.id");
      }
    }
    return;
  }
}

// ../../node_modules/@hpke/core/esm/src/kems/dhkemNative.js
class DhkemP256HkdfSha256Native extends Dhkem {
  constructor() {
    const kdf = new HkdfSha256Native;
    const prim = new Ec(KemId.DhkemP256HkdfSha256, kdf);
    super(KemId.DhkemP256HkdfSha256, prim, kdf);
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KemId.DhkemP256HkdfSha256
    });
    Object.defineProperty(this, "secretSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "encSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 65
    });
    Object.defineProperty(this, "publicKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 65
    });
    Object.defineProperty(this, "privateKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
  }
}

// ../../node_modules/@hpke/core/esm/src/native.js
class CipherSuite extends CipherSuiteNative {
}

class DhkemP256HkdfSha256 extends DhkemP256HkdfSha256Native {
}
class HkdfSha256 extends HkdfSha256Native {
}
// src/internal/encoding.ts
function toArrayBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}
function arrayBufferToBase64(data) {
  return Buffer.from(data).toString("base64");
}
function base64ToArrayBuffer(base642) {
  const buf = Buffer.from(base642, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// src/wallet-import.ts
function buildCipherSuite() {
  return new CipherSuite({
    kem: new DhkemP256HkdfSha256,
    kdf: new HkdfSha256,
    aead: new Chacha20Poly1305
  });
}
function parseSolanaSecret(input) {
  const trimmed = input.trim();
  if (!trimmed.startsWith("[")) {
    try {
      return base58.decode(trimmed);
    } catch {
      throw new Error("Invalid Solana private key: expected a base58 string or an id.json byte array.");
    }
  }
  const parsed = (() => {
    try {
      return JSON.parse(trimmed);
    } catch {
      return;
    }
  })();
  const isByteArray = Array.isArray(parsed) && parsed.length === 64 && parsed.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
  if (!isByteArray) {
    throw new Error("This looks like a Solana keyfile (id.json) but is not a 64-byte array. Pass the file's contents, e.g. [12,34,...].");
  }
  return Uint8Array.from(parsed);
}
function decodeWalletPrivateKey(chain2, privateKey) {
  if (chain2 === "evm") {
    const hex2 = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    if (hex2.length === 0 || hex2.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex2)) {
      throw new Error('Invalid EVM private key: expected a hex string (optionally "0x"-prefixed)');
    }
    return Uint8Array.from(Buffer.from(hex2, "hex"));
  }
  return parseSolanaSecret(privateKey);
}
async function encryptWalletKeyForImport(params) {
  const plaintext = decodeWalletPrivateKey(params.chain, params.privateKey);
  const suite = buildCipherSuite();
  const recipientPublicKey = await suite.kem.deserializePublicKey(base64ToArrayBuffer(params.encryptionPublicKey));
  const sender = await suite.createSenderContext({ recipientPublicKey });
  const ciphertext = await sender.seal(toArrayBuffer(plaintext));
  return {
    ciphertext: arrayBufferToBase64(ciphertext),
    encapsulatedKey: arrayBufferToBase64(sender.enc)
  };
}
async function generateSignerKeypair() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const [publicKeyDer, privateKeyDer] = await Promise.all([
    crypto.subtle.exportKey("spki", keyPair.publicKey),
    crypto.subtle.exportKey("pkcs8", keyPair.privateKey)
  ]);
  return {
    privateKeyPem: derToPem(privateKeyDer, "PRIVATE KEY"),
    publicKeyDerBase64: arrayBufferToBase64(publicKeyDer)
  };
}
function derToPem(der, label) {
  const base642 = arrayBufferToBase64(der);
  const lines = base642.match(/.{1,64}/g) ?? [base642];
  return `-----BEGIN ${label}-----
${lines.join(`
`)}
-----END ${label}-----
`;
}

// src/commands/wallets.ts
var NONE_HINT = `A wallet marked none has no signer on this machine, so a trade from here cannot sign with it.
` + `Import it here (candle wallets import), or run the trade from the machine that imported it.
`;
var STALE_HINT = `A wallet marked stale is revoked but its signer is still stored here. Run: candle wallets revoke <id>
`;
async function probeSignerStates(rows, store) {
  const states = new Map;
  let storeError;
  for (const row of rows) {
    if (typeof row._id !== "string" || row._id.length === 0)
      continue;
    let stored = false;
    try {
      stored = await store.get(walletSignerRef(row._id)) !== null;
    } catch (error) {
      storeError ??= error instanceof Error ? error.message : String(error);
    }
    states.set(row._id, stored ? row.revokedAt ? "stale" : "stored" : "none");
  }
  return { states, ...storeError !== undefined ? { storeError } : {} };
}
function signerCell(state, row) {
  if (state === undefined || state === "none" && row.revokedAt)
    return "-";
  return state;
}
async function wallets(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  await printIdentity(ctx);
  const apiKey = await resolveApiKey(deps, ctx.profile);
  if (!apiKey) {
    writeLocalFailure(deps, { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle keys create" }, json);
    return 1;
  }
  const embedded = await apiRequest("/api/v1/agent/wallets/embedded", {
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!embedded.ok) {
    writeFailure(deps, embedded, { apiUrl, authType: "key" }, json);
    return 1;
  }
  const linked = await apiRequest("/api/v1/agent/wallets", {
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!linked.ok) {
    writeFailure(deps, linked, { apiUrl, authType: "key" }, json);
    return 1;
  }
  const linkedBody = linked.body;
  const linkedRows = Array.isArray(linkedBody.page) ? linkedBody.page : [];
  const { states: signerStates, storeError } = await probeSignerStates(linkedRows, deps.store);
  if (storeError !== undefined)
    deps.stderr.write(`Could not read the signer store: ${storeError}
`);
  if (json) {
    deps.stdout.write(`${JSON.stringify({
      embedded: embedded.body,
      linked: linked.body,
      signers: Object.fromEntries(signerStates)
    })}
`);
    return 0;
  }
  const embeddedBody = embedded.body;
  deps.stdout.write(`Embedded (launch) wallets:
`);
  deps.stdout.write(`${renderTable(["Wallet", "Address", "Delegated", "Launches on"], [
    [
      "solana",
      embeddedBody.wallets.solana?.address ?? "none",
      embeddedBody.wallets.solana?.delegated ? "yes" : "no",
      "solana"
    ],
    [
      "evm",
      embeddedBody.wallets.evm?.address ?? "none",
      embeddedBody.wallets.evm?.delegated ? "yes" : "no",
      "hood"
    ]
  ])}
`);
  deps.stdout.write(`
Linked wallets:
`);
  if (linkedRows.length === 0) {
    deps.stdout.write(`(none)
`);
  } else {
    const cells = linkedRows.map((wallet) => signerCell(signerStates.get(wallet._id), wallet));
    deps.stdout.write(`${renderTable(["Id", "Wallet", "Address", "Label", "Revoked", "Signer"], linkedRows.map((wallet, index) => [
      wallet._id,
      wallet.chain,
      wallet.address,
      wallet.label ?? "-",
      wallet.revokedAt ? "yes" : "no",
      cells[index] ?? "-"
    ]))}
`);
    const anyNone = cells.includes("none");
    const anyStale = cells.includes("stale");
    if (anyNone || anyStale)
      deps.stdout.write(`
`);
    if (anyNone)
      deps.stdout.write(NONE_HINT);
    if (anyStale)
      deps.stdout.write(STALE_HINT);
  }
  return 0;
}
async function resolveKeyMaterial(keyFile, chain2, ctx) {
  if (keyFile !== undefined) {
    try {
      return { ok: true, privateKey: (await ctx.deps.readFile(keyFile)).trim() };
    } catch (error) {
      return { ok: false, message: `Could not read --key-file: ${error instanceof Error ? error.message : error}` };
    }
  }
  try {
    const promptText = chain2 === "solana" ? "Solana private key (base58 or id.json contents; input hidden): " : "EVM private key (hex; input hidden): ";
    const entered = (await ctx.deps.promptSecret(promptText)).trim();
    if (entered.length === 0)
      return { ok: false, message: "No private key entered" };
    return { ok: true, privateKey: entered };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
function resolveImportAddress(chain2, privateKey, addressFlag) {
  if (chain2 === "evm") {
    if (!addressFlag)
      return { ok: false, message: "--address is required for --chain evm" };
    return { ok: true, address: addressFlag };
  }
  let secret;
  try {
    secret = parseSolanaSecret(privateKey);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (secret.length !== 64) {
    return { ok: false, message: `Invalid Solana private key: expected 64 bytes, got ${secret.length}` };
  }
  const derived = base58.encode(secret.slice(32));
  if (addressFlag !== undefined && addressFlag !== derived) {
    return {
      ok: false,
      message: `--address does not match this private key (the key derives ${derived}). Refusing to import a mismatched pair.`
    };
  }
  return { ok: true, address: derived };
}
async function walletsImport(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {
    valueFlags: ["--chain", "--address", "--label", "--key-file", "--signer-out"]
  });
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const chainFlag = parsed.values["--chain"];
  const chainValid = chainFlag === "solana" || chainFlag === "evm";
  const missing = [];
  if (!chainValid)
    missing.push("--chain <solana|evm>");
  if (chainFlag === "evm" && parsed.values["--address"] === undefined)
    missing.push("--address <0x...>");
  if (missing.length > 0) {
    deps.stderr.write(`Missing required: ${missing.join(", ")}
`);
    deps.stderr.write(`Example: candle wallets import --chain evm --address 0xYourWallet --api-url ${apiUrl}
`);
    return 2;
  }
  const chain2 = chainFlag;
  await printIdentity(ctx);
  const material = await resolveKeyMaterial(parsed.values["--key-file"], chain2, ctx);
  if (!material.ok) {
    writeLocalFailure(deps, { code: "KEY_INPUT_FAILED", message: material.message }, json);
    return 1;
  }
  const resolvedAddress = resolveImportAddress(chain2, material.privateKey, parsed.values["--address"]);
  if (!resolvedAddress.ok) {
    writeLocalFailure(deps, { code: "KEY_INPUT_FAILED", message: resolvedAddress.message }, json);
    return 1;
  }
  const address = resolvedAddress.address;
  const apiKey = await resolveApiKey(deps, ctx.profile);
  if (!apiKey) {
    writeLocalFailure(deps, { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle keys create" }, json);
    return 1;
  }
  const init = await apiRequest("/api/v1/agent/wallets/import/init", {
    method: "POST",
    body: { chain: chain2, address },
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!init.ok) {
    writeFailure(deps, init, { apiUrl, authType: "key" }, json);
    return 1;
  }
  const { encryptionPublicKey } = init.body;
  const { ciphertext, encapsulatedKey } = await encryptWalletKeyForImport({
    chain: chain2,
    privateKey: material.privateKey,
    encryptionPublicKey
  });
  const signer = await generateSignerKeypair();
  const submit = await apiRequest("/api/v1/agent/wallets/import/submit", {
    method: "POST",
    body: {
      chain: chain2,
      address,
      ciphertext,
      encapsulatedKey,
      signerPublicKey: signer.publicKeyDerBase64,
      ...parsed.values["--label"] !== undefined ? { label: parsed.values["--label"] } : {}
    },
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!submit.ok) {
    writeFailure(deps, submit, { apiUrl, authType: "key" }, json);
    return 1;
  }
  const result = submit.body;
  await deps.store.set(walletSignerRef(result.id), pemToStoredSigner(signer.privateKeyPem));
  const signerOut = parsed.values["--signer-out"];
  if (signerOut !== undefined) {
    try {
      await deps.writeFile(signerOut, signer.privateKeyPem);
    } catch (error) {
      deps.stderr.write(`Warning: could not write --signer-out (${error instanceof Error ? error.message : error}); the signer is stored in the ${deps.backend} store
`);
    }
  }
  const verification = await verifyImportLanded({ id: result.id, apiKey, apiUrl, ctx });
  if (verification.status === "missing") {
    writeLocalFailure(deps, {
      code: "IMPORT_NOT_VISIBLE",
      message: `The server accepted the import (wallet id ${result.id}) but it is not on the account these ` + `credentials belong to${verification.account !== undefined ? ` (${verification.account})` : ""}. ` + `That usually means the CLI is logged in as a different Candle account than you expect. ` + `Run: candle doctor --api-url ${apiUrl}`
    }, json);
    return 1;
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify({
      id: result.id,
      address: result.address,
      chain: result.chain,
      privyWalletId: result.privyWalletId,
      account: verification.account,
      apiUrl,
      signerStore: deps.backend,
      verified: verification.status === "verified",
      ...signerOut !== undefined ? { signerOut } : {}
    })}
`);
    return 0;
  }
  deps.stdout.write(`Imported ${result.chain} wallet ${result.address}
`);
  deps.stdout.write(`  Account:         ${verification.account ?? "unknown"} at ${apiUrl}
`);
  deps.stdout.write(`  Wallet id:       ${result.id}
`);
  deps.stdout.write(`  Privy wallet id: ${result.privyWalletId}
`);
  if (signerOut !== undefined) {
    deps.stdout.write(`  Signer key:      exported to ${signerOut} (and in the ${deps.backend} store)
`);
    deps.stdout.write(`Back up ${signerOut}: trades from this wallet sign with it, and it cannot be re-downloaded.
`);
  } else {
    deps.stdout.write(`  Signer key:      stored in your ${deps.backend} store; nothing to save by hand
`);
  }
  if (verification.status === "unchecked") {
    deps.stdout.write(`Note: could not read the wallet back to confirm which account it landed on. Run: candle wallets --api-url ${apiUrl}
`);
  }
  return 0;
}
async function verifyImportLanded(args) {
  const { deps } = args.ctx;
  const listed = await apiRequest("/api/v1/agent/wallets", {
    method: "GET",
    auth: "key",
    credentials: { apiKey: args.apiKey },
    apiUrl: args.apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!listed.ok)
    return { status: "unchecked" };
  const page = listed.body.page;
  if (!Array.isArray(page))
    return { status: "unchecked" };
  const account = page.find((row) => typeof row.userAddress === "string")?.userAddress;
  const found = page.some((row) => row._id === args.id);
  return { status: found ? "verified" : "missing", ...account !== undefined ? { account } : {} };
}
async function walletsRevoke(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  const [walletId, extra] = parsed.positionals;
  if (!walletId || extra !== undefined) {
    deps.stderr.write(`Usage: candle wallets revoke <wallet-id>
`);
    return 2;
  }
  await printIdentity(ctx);
  const apiKey = await resolveApiKey(deps, ctx.profile);
  if (!apiKey) {
    writeLocalFailure(deps, { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle keys create" }, json);
    return 1;
  }
  const result = await apiRequest(`/api/v1/agent/wallets/${encodeURIComponent(walletId)}`, {
    method: "DELETE",
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!result.ok) {
    writeFailure(deps, result, { apiUrl, authType: "key" }, json);
    return 1;
  }
  try {
    await deps.store.delete(walletSignerRef(walletId));
  } catch {}
  if (json) {
    deps.stdout.write(`${JSON.stringify({ revoked: walletId, ...result.body })}
`);
    return 0;
  }
  deps.stdout.write(`Revoked linked wallet ${walletId}
`);
  return 0;
}

// src/config.ts
import { chmod as chmod2, mkdir as mkdir2, readFile as readFile2, rm, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { join as join5 } from "node:path";
function configDir2() {
  return process.env.CANDLE_CONFIG_DIR?.trim() || join5(homedir3(), ".config", "candle");
}
function configFilePath() {
  return join5(configDir2(), "config.json");
}
async function readConfig() {
  try {
    const raw = await readFile2(configFilePath(), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT")
      return {};
    throw err;
  }
}
async function writeConfig(patch) {
  const current = await readConfig();
  const next = { ...current, ...patch };
  const dir = configDir2();
  await mkdir2(dir, { recursive: true });
  await chmod2(dir, 448);
  await writeFile2(configFilePath(), JSON.stringify(next, null, 2), "utf8");
}
async function updateProfile(name, patch) {
  const current = await readConfig();
  const profiles = { ...current.profiles ?? {} };
  profiles[name] = { ...profiles[name] ?? {}, ...patch };
  await writeConfig({ profiles });
}
async function clearConfig() {
  try {
    await rm(configFilePath());
  } catch (err) {
    if (err.code !== "ENOENT")
      throw err;
  }
}

// src/guard.ts
async function verifyProfileAccount(ctx, config) {
  const { deps, profile } = ctx;
  if (!ctx.verifyAccount)
    return { ok: true, skipped: "--no-verify-account" };
  if (!profile)
    return { ok: true, skipped: "no profile" };
  if (credentialEnvOverrides(deps.env).length > 0)
    return { ok: true, skipped: "env override" };
  const cached = effectiveProfileFields(config, profile).account;
  if (!cached)
    return { ok: true, skipped: "no cached account" };
  const apiKey = await deps.store.get(profileSecretRef(profile, "apiKey"));
  if (!apiKey)
    return { ok: true, skipped: "no stored key" };
  const { account: live, failure } = await fetchAccount(deps, ctx.apiUrl, apiKey);
  if (!live) {
    return {
      ok: true,
      warning: `Could not verify the account for ${profile} (${failure}); proceeding on the cached value ${cached}.`
    };
  }
  if (live !== cached) {
    return {
      ok: false,
      message: `Refusing: profile ${profile} expects account ${cached} but its stored key belongs to ${live}.`,
      suggestion: [
        `If that key was legitimately re-issued: candle profile use ${profile}`,
        `To re-authenticate: candle auth login --profile ${profile}`,
        "To proceed once without the check: --no-verify-account"
      ].join(`
`)
    };
  }
  return { ok: true };
}

// src/keychain.ts
import { spawn, spawnSync } from "node:child_process";
var SERVICE = "tv.candle.cli";
var PROBE_ACCOUNT = "tv.candle.cli.probe";
var UNSAFE_FOR_SECURITY_COMMAND_LINE = /["\\\n\r]/;
var RUN_TIMEOUT_MS = 1e4;
function run(bin, args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled)
        return;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined)
      child.stdin.write(stdin);
    child.stdin.end();
  });
}
function binaryResolvable(bin) {
  return spawnSync("which", [bin], { env: process.env }).status === 0;
}

class KeychainSecretStore {
  binary;
  constructor(binary = "security") {
    this.binary = binary;
  }
  async get(ref) {
    const result = await run(this.binary, ["find-generic-password", "-s", SERVICE, "-a", ref, "-w"]);
    if (result.status !== 0)
      return null;
    return result.stdout.replace(/\n$/, "");
  }
  async set(ref, value) {
    if (UNSAFE_FOR_SECURITY_COMMAND_LINE.test(value)) {
      throw new Error("Refusing to store this secret in the macOS Keychain: it contains a quote, backslash, or " + "newline, which could break out of the quoted argument on security's command-on-stdin line");
    }
    const command = `add-generic-password -U -s "${SERVICE}" -a "${ref}" -w "${value}"
`;
    const result = await run(this.binary, ["-i"], command);
    if (result.status !== 0) {
      throw new Error(`Failed to store credential in the macOS Keychain (security exited ${result.status})`);
    }
  }
  async delete(ref) {
    const command = `delete-generic-password -s "${SERVICE}" -a "${ref}"
`;
    await run(this.binary, ["-i"], command);
  }
}

class SecretToolSecretStore {
  binary;
  constructor(binary = "secret-tool") {
    this.binary = binary;
  }
  async get(ref) {
    const result = await run(this.binary, ["lookup", "service", SERVICE, "account", ref]);
    if (result.status !== 0)
      return null;
    const value = result.stdout.replace(/\n$/, "");
    return value.length > 0 ? value : null;
  }
  async set(ref, value) {
    const result = await run(this.binary, ["store", "--label=Candle CLI", "service", SERVICE, "account", ref], value);
    if (result.status !== 0) {
      throw new Error(`Failed to store credential via secret-tool (exited ${result.status})`);
    }
  }
  async delete(ref) {
    await run(this.binary, ["clear", "service", SERVICE, "account", ref]);
  }
}
async function probeSecretTool(store) {
  const probeValue = crypto.randomUUID();
  try {
    await store.set(PROBE_ACCOUNT, probeValue);
    const got = await store.get(PROBE_ACCOUNT);
    return got === probeValue;
  } catch {
    return false;
  } finally {
    try {
      await store.delete(PROBE_ACCOUNT);
    } catch {}
  }
}
async function resolveSecretStore(platform = process.platform) {
  if (platform === "darwin" && binaryResolvable("security")) {
    return { store: new KeychainSecretStore, backend: "keychain" };
  }
  if (platform === "linux" && binaryResolvable("secret-tool")) {
    const candidate = new SecretToolSecretStore;
    if (await probeSecretTool(candidate)) {
      return { store: candidate, backend: "secret-tool" };
    }
  }
  return { store: new EncryptedFileSecretStore, backend: "encrypted-file" };
}

// src/index.ts
function extractGlobalFlags(argv) {
  const rest = [];
  const flags = { json: false, help: false, version: false, noVerifyAccount: false };
  for (let i = 0;i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json")
      flags.json = true;
    else if (arg === "--help" || arg === "-h")
      flags.help = true;
    else if (arg === "--version" || arg === "-v")
      flags.version = true;
    else if (arg === "--no-verify-account")
      flags.noVerifyAccount = true;
    else if (arg === "--api-url") {
      const value = argv[++i];
      if (value === undefined)
        return { error: "--api-url requires a value" };
      flags.apiUrl = value;
    } else if (arg?.startsWith("--api-url="))
      flags.apiUrl = arg.slice("--api-url=".length);
    else if (arg === "--profile") {
      const value = argv[++i];
      if (value === undefined)
        return { error: "--profile requires a value" };
      flags.profile = value;
    } else if (arg?.startsWith("--profile="))
      flags.profile = arg.slice("--profile=".length);
    else if (arg !== undefined)
      rest.push(arg);
  }
  return { rest, flags };
}
var HELP_TEXT = `candle: manage Candle agent credentials from the terminal

Usage: candle <command> [subcommand] [options]

Commands:
  auth login [--scopes <a,b,c>] [--label <name>] [--no-browser]   Authorize this device
             [--profile <name>]
  auth status                                                     Show credential status
  auth logout [--keep-key]                                        Clear local credentials
  keys list                                                       List API keys
  keys create [--scopes <a,b,c>] [--label <name>]                 Create an API key
              [--expires-in <days>] [--tx-limit <usd> [--reset daily|weekly|monthly|never]]
  keys revoke <prefix>                                            Revoke an API key
  wallets                                                         Show launch and linked wallets
  wallets import --chain <solana|evm> [options]                   Import a wallet you own (key via --key-file or hidden prompt)
  wallets revoke <wallet-id>                                      Revoke a linked wallet
  profile list                                                    Profiles on this machine, with cached accounts
  profile add <name> --api-url <url>                              Create a profile before authenticating it
  profile use <name>                                              Make a profile the active one
  profile rename <old> <new>                                      Rename a profile
  profile remove <name> --yes                                     Delete a profile and its stored credentials
  setup [--no-browser]                                            One wizard: authorize, fund, connect, verify
  mcp [--tools <a,b,c>] [--read-only] [--print-config]            Run the Candle MCP server with stored credentials
  doctor                                                          Diagnose CLI setup
  verify <file> --bundle <path>                                   Verify a release asset's Sigstore bundle
  update [--check] [--to <tag>]                                   Update the CLI to the latest signed release

Global options:
  --api-url <url>         Override the API base URL
  --profile <name>        Act as a named profile (see: candle auth login --profile)
  --no-verify-account     Skip the check that the stored key belongs to the profile's account
  --json                  Machine-readable output
  --help, -h              Show this help
  --version, -v           Show the CLI version
`;
var COMMANDS = {
  auth: { subcommands: { login: authLogin, status: authStatus, logout: authLogout } },
  keys: { subcommands: { list: keysList, create: keysCreate, revoke: keysRevoke } },
  wallets: { subcommands: { import: walletsImport, revoke: walletsRevoke }, bare: wallets },
  profile: {
    subcommands: { list: profileList, add: profileAdd, use: profileUse, rename: profileRename, remove: profileRemove }
  },
  doctor: { bare: doctor },
  mcp: { bare: mcp },
  setup: { bare: setup },
  verify: { bare: verify },
  update: { bare: update }
};
var ROUTED_COMMANDS = new Set(Object.keys(COMMANDS));
var ROUTED_SUBCOMMANDS = Object.fromEntries(Object.entries(COMMANDS).filter(([, route]) => route.subcommands !== undefined).map(([word, route]) => [word, Object.keys(route.subcommands ?? {})]));
function routeFor(word) {
  return word !== undefined && Object.hasOwn(COMMANDS, word) ? COMMANDS[word] : undefined;
}
function subHandlerFor(route, sub) {
  const subcommands = route?.subcommands;
  if (!subcommands || sub === undefined || !Object.hasOwn(subcommands, sub))
    return;
  return subcommands[sub];
}
function routesToCommand(cmd, sub) {
  const route = routeFor(cmd);
  if (!route)
    return false;
  if (subHandlerFor(route, sub) !== undefined)
    return true;
  return route.bare !== undefined;
}
var NEVER_GUARDED = new Set(["auth", "profile", "doctor", "verify", "update"]);
async function run2(argv, deps) {
  const extracted = extractGlobalFlags(argv);
  if ("error" in extracted) {
    deps.stderr.write(`${extracted.error}
`);
    return 2;
  }
  const { rest, flags } = extracted;
  const tokens = rest[0] === "candle" ? rest.slice(1) : rest;
  if (flags.version) {
    const versionWord = tokens[0];
    if (versionWord !== undefined && ROUTED_COMMANDS.has(versionWord)) {
      const fix = "--version prints the CLI version; to pin a release use: candle update --to <tag>";
      writeUsageFailure(deps, fix, flags.json);
      return 2;
    }
    deps.stdout.write(`${CLI_VERSION}
`);
    return 0;
  }
  if (flags.help) {
    deps.stdout.write(HELP_TEXT);
    return 0;
  }
  const [cmd, sub, ...cmdArgs] = tokens;
  const config = await migrateProfiles(deps);
  const isAuthLogin = cmd === "auth" && sub === "login";
  const isProfileCommand = cmd === "profile";
  const resolution = isAuthLogin ? resolveProfileNameForLogin(config, { flag: flags.profile, env: deps.env }) : isProfileCommand ? { ok: true, name: undefined } : resolveProfileName(config, { flag: flags.profile, env: deps.env });
  if (!resolution.ok) {
    if (isAuthLogin) {
      writeUsageFailure(deps, resolution.message, flags.json);
      return 2;
    }
    writeLocalFailure(deps, { code: "PROFILE_UNRESOLVED", ...splitFix(resolution.message) }, flags.json);
    return 1;
  }
  const profile = resolution.name;
  const profileApiUrl = profile ? config.profiles?.[profile]?.apiUrl : config.apiUrl;
  const apiUrl = flags.apiUrl ?? resolveApiUrl(profileApiUrl, deps.env);
  const ctx = {
    deps,
    json: flags.json,
    apiUrl,
    apiUrlFlag: flags.apiUrl,
    profile,
    profileFlag: flags.profile,
    verifyAccount: !flags.noVerifyAccount
  };
  const word = cmd ?? "";
  const actsAsIdentity = word !== "mcp" || mcpActsAsIdentity(tokens.slice(1));
  if (ROUTED_COMMANDS.has(word) && !NEVER_GUARDED.has(word) && routesToCommand(cmd, sub) && actsAsIdentity) {
    const verdict = await verifyProfileAccount(ctx, config);
    if (!verdict.ok) {
      writeLocalFailure(deps, { code: "ACCOUNT_MISMATCH", message: verdict.message, suggestion: verdict.suggestion }, flags.json);
      return 1;
    }
    if (verdict.warning)
      deps.stderr.write(`${verdict.warning}
`);
  }
  const route = routeFor(cmd);
  const handler = subHandlerFor(route, sub);
  if (handler)
    return handler(cmdArgs, ctx);
  if (route?.bare)
    return route.bare(tokens.slice(1), ctx);
  if (route)
    return unknownCommand(deps, sub === undefined ? undefined : `${cmd} ${sub}`);
  return unknownCommand(deps, cmd);
}
function splitFix(message) {
  const newline = message.indexOf(`
`);
  if (newline !== -1) {
    const suggestion = message.slice(newline + 1);
    return suggestion.includes(`
`) ? { message: message.slice(0, newline), suggestion } : { message };
  }
  const fixAt = message.indexOf(" Run: ");
  return fixAt === -1 ? { message } : { message: message.slice(0, fixAt), suggestion: message.slice(fixAt + 1) };
}
function unknownCommand(deps, token) {
  if (token !== undefined)
    deps.stderr.write(`Unknown command: ${token}
`);
  deps.stderr.write(HELP_TEXT);
  return 1;
}
async function migrateProfiles(deps) {
  const before = await deps.readConfig();
  const { config, migrated } = migratedConfig(before);
  if (!migrated)
    return before;
  for (const [legacyRef, kind] of [
    [SECRET_REFS.deviceToken, "deviceToken"],
    [SECRET_REFS.apiKey, "apiKey"]
  ]) {
    const value = await deps.store.get(legacyRef);
    if (value)
      await deps.store.set(profileSecretRef("default", kind), value);
  }
  await deps.writeConfig({ profiles: config.profiles, activeProfile: config.activeProfile });
  return config;
}
function realOpenBrowser(url) {
  try {
    const platform = process.platform;
    const child = platform === "darwin" ? spawn2("open", [url], { stdio: "ignore", detached: true }) : platform === "win32" ? spawn2("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }) : spawn2("xdg-open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}
async function buildRealDeps() {
  const { store, backend } = await resolveSecretStore();
  return {
    fetch: globalThis.fetch,
    store,
    backend,
    readConfig,
    writeConfig,
    clearConfig,
    updateProfile,
    stdout: {
      write: (chunk) => {
        process.stdout.write(chunk);
      }
    },
    stderr: {
      write: (chunk) => {
        process.stderr.write(chunk);
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    openBrowser: realOpenBrowser,
    env: process.env,
    nodeVersion: process.versions.node,
    hostname: hostname(),
    runChild: (command, args, env) => new Promise((resolve) => {
      const child = spawn2(command, args, {
        stdio: "inherit",
        env,
        shell: process.platform === "win32"
      });
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 1));
    }),
    readFile: (path) => readFile3(path, "utf8"),
    readBytes: (path) => readFile3(path),
    writeFile: (path, content) => writeFile3(path, content, { mode: 384 }),
    promptSecret: promptHiddenSecret,
    execPath: process.execPath,
    argv1: process.argv[1] ?? "",
    platformKey: platformKey(process.platform, process.arch),
    realpath: (path) => realpath(path),
    writeBytes: async (path, bytes) => {
      await writeFile3(path, bytes, { flag: "wx", mode: 493 });
      await chmod3(path, 493);
    },
    rename: (from, to) => rename2(from, to),
    unlink: (path) => unlink(path)
  };
}
async function main() {
  const deps = await buildRealDeps();
  const code = await run2(process.argv.slice(2), deps);
  process.exit(code);
}
function entryHref(argv1) {
  try {
    return pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return pathToFileURL(argv1).href;
  }
}
var isMainModule = process.argv[1] !== undefined && import.meta.url === entryHref(process.argv[1]);
if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}
`);
    process.exit(1);
  });
}
export {
  run2 as run,
  buildRealDeps,
  ROUTED_SUBCOMMANDS,
  ROUTED_COMMANDS,
  NEVER_GUARDED
};
