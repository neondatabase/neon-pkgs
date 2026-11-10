// Generates schema/realtime-envelope-v3.fixtures.json: sealed v3 envelopes that
// the Realtime proxy vendors for its parser tests.
//
// The output is deterministic. Keys come from deriveKeyPair() on fixed labels,
// and every envelope passes a fixed ephemeral key to @hpke/core through `ekm`,
// its input for tests. This script does not import the SDK, so the SDK's own
// sealer is checked against it rather than against itself.
//
// Run `node scripts/generate-envelope-fixtures.mjs` to rewrite the file, or add
// `--check` to fail when the committed file is stale.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";

const outputUrl = new URL(
  "../schema/realtime-envelope-v3.fixtures.json",
  import.meta.url,
);

const NOW = 1_767_225_600; // 2026-01-01T00:00:00Z
const LIFETIME_SECONDS = 60;
const INFO = "neon-realtime/envelope/v3";
const ALG = "HPKE-P256-SHA256-A256GCM";
const MAX_SQL_BYTES = 32_768;
const MAX_CREDENTIAL_BYTES = 16_384;
const FINGERPRINT_DOMAIN = "neon-live-query-fingerprint-v1\0";
// Plain test values. Secret scanners flag `npg_` passwords and `ey...`-prefixed
// JWTs, and the proxy vendors this file, so neither shape may appear in it.
const PASSWORD = "fixture-password-correct-horse";

// P-256 field prime and curve coefficient b (a = -3).
const P = BigInt(
  "0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff",
);
const B = BigInt(
  "0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b",
);

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});
const encoder = new TextEncoder();
const utf8 = (value) => encoder.encode(value);

function label(name) {
  return new Uint8Array(
    createHash("sha256")
      .update(`neon-realtime/envelope/v3/fixtures/${name}`)
      .digest(),
  );
}

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function fromB64url(value) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function header(kid) {
  return JSON.stringify({ alg: ALG, kid, v: 3 });
}

async function fixtureKey(name) {
  const pair = await suite.kem.deriveKeyPair(label(`key/${name}`));
  const sk = new Uint8Array(await suite.kem.serializePrivateKey(pair.privateKey));
  const pk = new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey));
  if (sk.length !== 32 || pk.length !== 65 || pk[0] !== 0x04) {
    throw new Error(`unexpected key encoding for ${name}`);
  }
  return {
    kid: b64url(label(`kid/${name}`).subarray(0, 16)),
    sk,
    pk,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
  };
}

function fingerprint(sql, parameters) {
  const canonical = JSON.stringify({ sql, parameters });
  return createHash("sha256")
    .update(FINGERPRINT_DOMAIN + canonical, "utf8")
    .digest("hex");
}

function claims({
  sql = "select id, body from messages where channel_id = $1",
  parameters = [{ type_oid: 23, value: b64("7") }],
  user = "neondb_owner",
  credential = PASSWORD,
  database = "neondb",
  errorDetails = "safe",
  querySource = "raw_sql",
  iat = NOW,
  exp = NOW + LIFETIME_SECONDS,
} = {}) {
  return {
    v: 3,
    aud: "realtime-proxy",
    database,
    error_details: errorDetails,
    issuer: { sdk: "javascript", release_line: "0.2", query_source: querySource },
    query_fingerprint: fingerprint(sql, parameters),
    sql,
    parameters,
    iat,
    exp,
    auth: { user, credential },
  };
}

function b64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

/** Seal `plaintext` to `key` under the exact `headerJson` text. */
async function seal(key, headerJson, plaintext, ephemeral) {
  const encodedHeader = b64url(utf8(headerJson));
  const { ct, enc } = await suite.seal(
    {
      recipientPublicKey: key.publicKey,
      info: utf8(INFO),
      ekm: label(`ephemeral/${ephemeral}`),
    },
    typeof plaintext === "string" ? utf8(plaintext) : plaintext,
    utf8(encodedHeader),
  );
  return [
    encodedHeader,
    b64url(new Uint8Array(enc)),
    "",
    b64url(new Uint8Array(ct)),
    "",
  ].join(".");
}

function replaceSegment(envelope, index, value) {
  const segments = envelope.split(".");
  segments[index] = value;
  return segments.join(".");
}

function bigIntFrom(bytes) {
  return BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
}

function bytesFrom(value) {
  return new Uint8Array(Buffer.from(value.toString(16).padStart(64, "0"), "hex"));
}

function mod(value) {
  const result = value % P;
  return result < 0n ? result + P : result;
}

function onCurve(x, y) {
  return mod(y * y) === mod(x * x * x - 3n * x + B);
}

function point(enc) {
  return { x: enc.subarray(1, 33), y: enc.subarray(33, 65) };
}

function expectOnCurve(x, y, expected, name) {
  if (onCurve(bigIntFrom(x), bigIntFrom(y)) !== expected) {
    throw new Error(`${name}: point is unexpectedly ${expected ? "off" : "on"} the curve`);
  }
}

/**
 * Three dot-separated base64url segments of a Vercel OIDC token's typical
 * sizes. JWT-shaped, not a real JWT: the segments encode plain text and
 * random bytes, not JSON. The proxy does not tell credentials apart.
 */
function jwtShapedCredential() {
  const signature = new Uint8Array(256);
  for (let offset = 0; offset < signature.length; offset += 32) {
    signature.set(label(`oidc-signature/${offset}`), offset);
  }
  const credential = [
    b64url(utf8("neon-realtime fixture: JWT-shaped header, not a real JWT")),
    b64url(
      utf8(
        "neon-realtime fixture: JWT-shaped payload standing in for a Vercel OIDC token " +
          "for project realtime-app, environment production, role neondb_owner. " +
          "It is not JSON and carries no claims.",
      ),
    ),
    b64url(signature),
  ].join(".");
  if (credential.split(".").some((segment) => segment.startsWith("ey"))) {
    throw new Error("JWT-shaped credential must not look like a real JWT");
  }
  return credential;
}

function paddedToBytes(prefix, filler, bytes) {
  const value = prefix + filler.repeat(bytes - utf8(prefix).length);
  if (utf8(value).length !== bytes) throw new Error("padding miscounted");
  return value;
}

async function build() {
  const primary = await fixtureKey("primary");
  const secondary = await fixtureKey("secondary");
  const unknown = await fixtureKey("unknown");
  const standardHeader = header(primary.kid);

  const valid = [];
  const addValid = async (name, decoded) => {
    const envelope = await seal(primary, standardHeader, JSON.stringify(decoded), name);
    valid.push({ name, envelope, claims: decoded });
    return envelope;
  };

  const passwordEnvelope = await addValid("password", claims());
  await addValid(
    "oidc_jwt_shaped",
    claims({
      sql: "select id, title from items order by id",
      parameters: [],
      credential: jwtShapedCredential(),
      errorDetails: "full",
      querySource: "drizzle",
    }),
  );
  await addValid(
    "max_size_sql",
    claims({
      sql: paddedToBytes("select 1 as value -- ", "x", MAX_SQL_BYTES),
      parameters: [],
    }),
  );
  await addValid(
    "parameters_with_nulls",
    claims({
      sql: "select id from messages where room_id = $1 and deleted_at is not distinct from $2 and author is not distinct from $3",
      parameters: [
        { type_oid: 23, value: b64("1") },
        { type_oid: 0, value: null },
        { value: null },
      ],
      querySource: "kysely",
    }),
  );
  await addValid(
    "max_size_credential",
    claims({
      credential: paddedToBytes("fixture-password-", "A", MAX_CREDENTIAL_BYTES),
      querySource: "custom",
    }),
  );

  const invalid = [];
  const addInvalid = (name, envelope, reason) =>
    invalid.push({ name, envelope, reason });
  const sealClaims = (name, plaintext, sealHeader = standardHeader, key = primary) =>
    seal(key, sealHeader, plaintext, `invalid/${name}`);

  const [, encodedEnc, , encodedCiphertext] = passwordEnvelope.split(".");
  const enc = fromB64url(encodedEnc);
  const { x, y } = point(enc);

  // Header and key selection.
  addInvalid(
    "changed_header",
    replaceSegment(passwordEnvelope, 0, b64url(utf8(header(secondary.kid)))),
    "decrypt_failed",
  );
  const ciphertext = fromB64url(encodedCiphertext);
  ciphertext[0] ^= 0x01;
  addInvalid(
    "changed_ciphertext",
    replaceSegment(passwordEnvelope, 3, b64url(ciphertext)),
    "decrypt_failed",
  );
  // Negating Y flips only the y-parity bit of the compressed form, and the point
  // stays on the curve, so the failure is decryption rather than key agreement.
  const negatedY = bytesFrom(P - bigIntFrom(y));
  expectOnCurve(x, negatedY, true, "changed_enc");
  addInvalid(
    "changed_enc",
    replaceSegment(passwordEnvelope, 1, b64url(Uint8Array.from([0x04, ...x, ...negatedY]))),
    "decrypt_failed",
  );
  const offCurveY = Uint8Array.from(y);
  offCurveY[31] ^= 0x01;
  expectOnCurve(x, offCurveY, false, "off_curve_enc");
  addInvalid(
    "off_curve_enc",
    replaceSegment(passwordEnvelope, 1, b64url(Uint8Array.from([0x04, ...x, ...offCurveY]))),
    "invalid_enc",
  );
  const yParity = y[31] & 1;
  addInvalid(
    "compressed_enc",
    replaceSegment(passwordEnvelope, 1, b64url(Uint8Array.from([0x02 | yParity, ...x]))),
    "invalid_enc",
  );
  addInvalid(
    "hybrid_enc",
    replaceSegment(passwordEnvelope, 1, b64url(Uint8Array.from([0x06 | yParity, ...x, ...y]))),
    "invalid_enc",
  );
  addInvalid(
    "short_enc",
    replaceSegment(passwordEnvelope, 1, b64url(enc.subarray(0, 64))),
    "invalid_enc",
  );
  addInvalid(
    "unknown_kid",
    await sealClaims("unknown_kid", JSON.stringify(claims()), header(unknown.kid), unknown),
    "unknown_kid",
  );

  // Header contents. Each envelope is sealed under its own header, so the header
  // is its only defect.
  const legacyIv = label("invalid/dir_alg_v3/iv").subarray(0, 12);
  const legacyCiphertext = label("invalid/dir_alg_v3/ciphertext");
  const legacyTag = label("invalid/dir_alg_v3/tag").subarray(0, 16);
  addInvalid(
    "dir_alg_v3",
    [
      b64url(utf8(JSON.stringify({ alg: "dir", enc: "A256GCM", v: 3 }))),
      "",
      b64url(legacyIv),
      b64url(legacyCiphertext),
      b64url(legacyTag),
    ].join("."),
    "unsupported_header",
  );
  addInvalid(
    "hpke_alg_v2",
    await sealClaims(
      "hpke_alg_v2",
      JSON.stringify(claims()),
      JSON.stringify({ alg: ALG, kid: primary.kid, v: 2 }),
    ),
    "unsupported_header",
  );
  addInvalid(
    "extra_header_key",
    await sealClaims(
      "extra_header_key",
      JSON.stringify(claims()),
      JSON.stringify({ alg: ALG, kid: primary.kid, v: 3, enc: "A256GCM" }),
    ),
    "unsupported_header",
  );
  addInvalid(
    "duplicate_header_key",
    await sealClaims(
      "duplicate_header_key",
      JSON.stringify(claims()),
      `{"alg":"${ALG}","kid":"${primary.kid}","v":3,"v":3}`,
    ),
    "unsupported_header",
  );

  // Compact serialization.
  addInvalid(
    "padded_segment",
    replaceSegment(passwordEnvelope, 1, `${encodedEnc}=`),
    "malformed",
  );
  // 65 bytes leave two unused bits in the last character. Setting one keeps the
  // decoded bytes for a lenient decoder.
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lastIndex = alphabet.indexOf(encodedEnc.at(-1));
  if ((lastIndex & 0b11) !== 0) throw new Error("enc is not canonical");
  addInvalid(
    "non_canonical_base64url",
    replaceSegment(
      passwordEnvelope,
      1,
      encodedEnc.slice(0, -1) + alphabet[lastIndex | 0b01],
    ),
    "malformed",
  );
  addInvalid("non_empty_segment_3", replaceSegment(passwordEnvelope, 2, "AA"), "malformed");
  addInvalid("non_empty_segment_5", replaceSegment(passwordEnvelope, 4, "AA"), "malformed");
  addInvalid(
    "four_segments",
    passwordEnvelope.split(".").slice(0, 4).join("."),
    "malformed",
  );
  addInvalid("six_segments", `${passwordEnvelope}.`, "malformed");
  addInvalid(
    "short_ciphertext",
    replaceSegment(passwordEnvelope, 3, b64url(fromB64url(encodedCiphertext).subarray(0, 16))),
    "malformed",
  );

  // Claims. Each is sealed correctly; only the decrypted plaintext is wrong.
  addInvalid(
    "plaintext_not_json",
    await sealClaims("plaintext_not_json", "neon realtime fixture: not json"),
    "invalid_claims",
  );
  const standard = JSON.stringify(claims());
  const databaseMember = '"database":"neondb",';
  if (!standard.includes(databaseMember)) throw new Error("claims changed shape");
  addInvalid(
    "duplicate_claim_key",
    await sealClaims(
      "duplicate_claim_key",
      standard.replace(databaseMember, `${databaseMember}"database":"postgres",`),
    ),
    "invalid_claims",
  );
  const { auth: _auth, ...withoutAuth } = claims();
  addInvalid(
    "missing_auth",
    await sealClaims("missing_auth", JSON.stringify(withoutAuth)),
    "invalid_claims",
  );
  addInvalid(
    "extra_auth_key",
    await sealClaims(
      "extra_auth_key",
      JSON.stringify({
        ...claims(),
        auth: { user: "neondb_owner", credential: PASSWORD, kind: "password" },
      }),
    ),
    "invalid_claims",
  );
  addInvalid(
    "empty_credential",
    await sealClaims("empty_credential", JSON.stringify(claims({ credential: "" }))),
    "invalid_claims",
  );
  addInvalid(
    "wrong_aud",
    await sealClaims(
      "wrong_aud",
      JSON.stringify({ ...claims(), aud: "realtime" }),
    ),
    "invalid_claims",
  );
  addInvalid(
    "claims_v2",
    await sealClaims("claims_v2", JSON.stringify({ ...claims(), v: 2 })),
    "invalid_claims",
  );
  addInvalid(
    "extra_claim_key",
    await sealClaims(
      "extra_claim_key",
      JSON.stringify({ ...claims(), branch: "br-fixture" }),
    ),
    "invalid_claims",
  );
  addInvalid(
    "expired",
    await sealClaims(
      "expired",
      JSON.stringify(claims({ iat: NOW - LIFETIME_SECONDS - 1, exp: NOW - 1 })),
    ),
    "expired",
  );
  addInvalid(
    "not_yet_valid",
    await sealClaims(
      "not_yet_valid",
      JSON.stringify(claims({ iat: NOW + 31, exp: NOW + 31 + LIFETIME_SECONDS })),
    ),
    "not_yet_valid",
  );
  addInvalid(
    "lifetime_too_long",
    await sealClaims(
      "lifetime_too_long",
      JSON.stringify(claims({ iat: NOW, exp: NOW + 301 })),
    ),
    "invalid_claims",
  );

  // Self-check: every valid envelope opens with its key to exactly its claims.
  for (const fixture of valid) {
    const [encodedHeader, encodedEncValue, , encodedCt] = fixture.envelope.split(".");
    const plaintext = await suite.open(
      {
        recipientKey: primary.privateKey,
        enc: fromB64url(encodedEncValue),
        info: utf8(INFO),
      },
      fromB64url(encodedCt),
      utf8(encodedHeader),
    );
    if (new TextDecoder().decode(plaintext) !== JSON.stringify(fixture.claims)) {
      throw new Error(`${fixture.name}: does not open to its claims`);
    }
  }

  const keyEntry = (key) => ({
    kid: key.kid,
    sk: b64url(key.sk),
    x: b64url(key.pk.subarray(1, 33)),
    y: b64url(key.pk.subarray(33, 65)),
  });
  return {
    description: "Neon Realtime envelope v3 fixtures",
    suite: { mode: 0, kem_id: 16, kdf_id: 1, aead_id: 2 },
    info: INFO,
    now: NOW,
    keys: [keyEntry(primary), keyEntry(secondary)],
    valid,
    invalid,
  };
}

const generated = `${JSON.stringify(await build(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let committed;
  try {
    committed = await readFile(outputUrl, "utf8");
  } catch {
    committed = undefined;
  }
  if (committed !== generated) {
    console.error(
      `${fileURLToPath(outputUrl)} is stale; run npm run generate:fixtures --workspace @neon/realtime`,
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(outputUrl, generated);
}
