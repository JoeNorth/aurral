import fs from "fs";
import { createHash, createPrivateKey, sign } from "crypto";

const TOKEN_LIFETIME_SECONDS = 150 * 24 * 60 * 60;
const TOKEN_REFRESH_BUFFER_MS = 24 * 60 * 60 * 1000;

let cachedToken = null;

const clean = (value) => String(value || "").trim();

const encodeJson = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function normalizeOrigin(value) {
  const raw = clean(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function readPrivateKey(env) {
  const inline = clean(env.APPLE_MUSIC_PRIVATE_KEY);
  if (inline) {
    return {
      pem: inline.replaceAll("\\n", "\n"),
      identity: `inline:${createHash("sha256").update(inline).digest("hex")}`,
    };
  }

  const encoded = clean(env.APPLE_MUSIC_PRIVATE_KEY_BASE64);
  if (encoded) {
    let pem;
    try {
      pem = Buffer.from(encoded, "base64").toString("utf8").trim();
    } catch {
      pem = "";
    }
    if (!pem) throw new Error("APPLE_MUSIC_PRIVATE_KEY_BASE64 is invalid");
    return {
      pem,
      identity: `base64:${createHash("sha256").update(encoded).digest("hex")}`,
    };
  }

  const keyPath = clean(env.APPLE_MUSIC_PRIVATE_KEY_PATH);
  if (!keyPath) return null;
  let stat;
  let pem;
  try {
    stat = fs.statSync(keyPath);
    pem = fs.readFileSync(keyPath, "utf8").trim();
  } catch (error) {
    throw new Error(`Unable to read Apple Music private key: ${error.message}`);
  }
  if (!pem) throw new Error("Apple Music private key is empty");
  return { pem, identity: `file:${keyPath}:${stat.mtimeMs}:${stat.size}` };
}

export function getAppleMusicConfiguration(env = process.env) {
  const developerToken = clean(env.APPLE_MUSIC_DEVELOPER_TOKEN);
  const teamId = clean(env.APPLE_MUSIC_TEAM_ID);
  const keyId = clean(env.APPLE_MUSIC_KEY_ID);
  const originValue = clean(env.APPLE_MUSIC_ORIGIN);
  const origin = normalizeOrigin(originValue);

  if (originValue && !origin) {
    return {
      configured: false,
      mode: null,
      origin: null,
      message: "APPLE_MUSIC_ORIGIN must be an HTTP or HTTPS origin",
    };
  }

  if (developerToken) {
    return {
      configured: true,
      mode: "developer-token",
      developerToken,
      origin,
      message: null,
    };
  }

  let privateKey = null;
  try {
    privateKey = readPrivateKey(env);
  } catch (error) {
    return {
      configured: false,
      mode: null,
      origin,
      message: error.message,
    };
  }

  const missing = [];
  if (!teamId) missing.push("APPLE_MUSIC_TEAM_ID");
  if (!keyId) missing.push("APPLE_MUSIC_KEY_ID");
  if (!privateKey) missing.push("APPLE_MUSIC_PRIVATE_KEY_PATH");
  if (missing.length > 0) {
    return {
      configured: false,
      mode: null,
      origin,
      message: `Configure ${missing.join(", ")}`,
    };
  }

  return {
    configured: true,
    mode: "private-key",
    teamId,
    keyId,
    privateKey,
    origin,
    message: null,
  };
}

export function getAppleMusicPublicConfiguration(env = process.env) {
  const config = getAppleMusicConfiguration(env);
  return {
    configured: config.configured,
    mode: config.mode,
    origin: config.origin,
    message: config.message,
  };
}

export function getAppleMusicDeveloperToken({ env = process.env, now = Date.now() } = {}) {
  const config = getAppleMusicConfiguration(env);
  if (!config.configured) {
    const error = new Error(config.message || "Apple Music is not configured");
    error.statusCode = 503;
    throw error;
  }
  if (config.mode === "developer-token") return config.developerToken;

  const cacheIdentity = [
    config.teamId,
    config.keyId,
    config.privateKey.identity,
    config.origin || "",
  ].join(":");
  if (
    cachedToken?.identity === cacheIdentity &&
    cachedToken.expiresAt - now > TOKEN_REFRESH_BUFFER_MS
  ) {
    return cachedToken.value;
  }

  const issuedAt = Math.floor(now / 1000) - 30;
  const expiresAtSeconds = issuedAt + TOKEN_LIFETIME_SECONDS;
  const header = encodeJson({ alg: "ES256", kid: config.keyId, typ: "JWT" });
  const payload = {
    iss: config.teamId,
    iat: issuedAt,
    exp: expiresAtSeconds,
  };
  if (config.origin) payload.origin = config.origin;
  const encodedPayload = encodeJson(payload);
  const signingInput = `${header}.${encodedPayload}`;

  let signature;
  try {
    const privateKey = createPrivateKey(config.privateKey.pem);
    signature = sign("sha256", Buffer.from(signingInput), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
  } catch (error) {
    const wrapped = new Error(`Unable to sign Apple Music developer token: ${error.message}`);
    wrapped.statusCode = 503;
    throw wrapped;
  }

  const value = `${signingInput}.${signature}`;
  cachedToken = {
    identity: cacheIdentity,
    value,
    expiresAt: expiresAtSeconds * 1000,
  };
  return value;
}

export function clearAppleMusicDeveloperTokenCache() {
  cachedToken = null;
}
