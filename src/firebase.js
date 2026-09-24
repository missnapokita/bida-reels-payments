import { assertBindings, HttpError } from "./http.js";
import { verify as verifySignature } from "node:crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let oauthCache = { token: "", expiresAt: 0 };
let certificateCache = { certificates: {}, expiresAt: 0 };

function base64UrlBytes(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlText(value) {
  return base64UrlBytes(encoder.encode(value));
}

function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeJwtJson(value) {
  try {
    return JSON.parse(decoder.decode(decodeBase64Url(value)));
  } catch (_) {
    throw new HttpError("Invalid authentication token", 401);
  }
}

function pemToBytes(pem) {
  const clean = String(pem || "")
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (!clean) throw new Error("Firebase private key is missing");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function serviceAccount(env) {
  assertBindings(env, ["FIREBASE_SERVICE_ACCOUNT_JSON"]);
  let account;
  try {
    account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (_) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!account.client_email || !account.private_key || !account.project_id) {
    throw new Error("Firebase service account is incomplete");
  }
  return account;
}

async function createServiceAccountAssertion(account) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlText(JSON.stringify({
    iss: account.client_email,
    sub: account.client_email,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    scope: [
      "https://www.googleapis.com/auth/firebase.database",
      "https://www.googleapis.com/auth/userinfo.email"
    ].join(" ")
  }));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(unsigned)
  );
  return `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;
}

async function firebaseAdminToken(env) {
  if (oauthCache.token && oauthCache.expiresAt > Date.now() + 60_000) {
    return oauthCache.token;
  }

  const account = serviceAccount(env);
  const assertion = await createServiceAccountAssertion(account);
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error("Unable to authorize Firebase database access");
  }
  oauthCache = {
    token: String(data.access_token),
    expiresAt: Date.now() + Math.max(300, Number(data.expires_in) || 3600) * 1000
  };
  return oauthCache.token;
}

export async function verifyFirebaseIdToken(request, env) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    throw new HttpError("Authentication required", 401);
  }
  const idToken = authorization.slice(7).trim();
  if (!idToken || idToken.length > 8192) {
    throw new HttpError("Invalid authentication token", 401);
  }

  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new HttpError("Authentication token is invalid or expired", 401);
  }

  const header = decodeJwtJson(parts[0]);
  const claims = decodeJwtJson(parts[1]);
  if (header.alg !== "RS256" || !header.kid) {
    throw new HttpError("Authentication token is invalid or expired", 401);
  }
  const account = serviceAccount(env);
  const projectId = String(account.project_id);
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.aud !== projectId ||
    claims.iss !== `https://securetoken.google.com/${projectId}` ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    claims.sub.length > 128 ||
    !Number.isFinite(Number(claims.exp)) ||
    Number(claims.exp) <= now ||
    !Number.isFinite(Number(claims.iat)) ||
    Number(claims.iat) > now + 30 ||
    (claims.auth_time !== undefined && Number(claims.auth_time) > now + 30)
  ) {
    throw new HttpError("Authentication token is invalid or expired", 401);
  }

  let certificate = await firebaseCertificate(String(header.kid), false);
  if (!certificate) certificate = await firebaseCertificate(String(header.kid), true);
  if (!certificate) {
    throw new HttpError("Authentication token is invalid or expired", 401);
  }
  const signatureValid = verifySignature(
    "RSA-SHA256",
    encoder.encode(`${parts[0]}.${parts[1]}`),
    certificate,
    decodeBase64Url(parts[2])
  );
  if (!signatureValid) {
    throw new HttpError("Authentication token is invalid or expired", 401);
  }

  return {
    uid: String(claims.sub),
    email: String(claims.email || ""),
    name: String(claims.name || "Bida Reels User")
  };
}

async function firebaseCertificate(keyId, forceRefresh) {
  if (
    !forceRefresh &&
    certificateCache.expiresAt > Date.now() &&
    certificateCache.certificates[keyId]
  ) {
    return certificateCache.certificates[keyId];
  }
  const response = await fetch(
    "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com",
    { headers: { Accept: "application/json" } }
  );
  const certificates = await response.json().catch(() => ({}));
  if (!response.ok || !certificates || typeof certificates !== "object") {
    throw new Error("Unable to load Firebase token certificates");
  }
  const cacheControl = response.headers.get("cache-control") || "";
  const match = cacheControl.match(/max-age=(\d+)/i);
  const maxAge = match ? Math.max(60, Number(match[1])) : 3600;
  certificateCache = {
    certificates,
    expiresAt: Date.now() + maxAge * 1000
  };
  return certificates[keyId] || "";
}

function databaseRoot(env) {
  assertBindings(env, ["FIREBASE_DATABASE_URL"]);
  const value = String(env.FIREBASE_DATABASE_URL).trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-zA-Z0-9.-]+$/.test(value)) {
    throw new Error("FIREBASE_DATABASE_URL is invalid");
  }
  return value;
}

function cleanPath(path) {
  return String(path || "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function databaseRequest(env, path, options = {}) {
  const token = await firebaseAdminToken(env);
  const clean = cleanPath(path);
  const url = new URL(`${databaseRoot(env)}/${clean ? `${clean}.json` : ".json"}`);
  const query = options.query || {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json"
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.wantEtag) headers["X-Firebase-ETag"] = "true";
  if (options.ifMatch) headers["If-Match"] = options.ifMatch;

  const response = await fetch(url.toString(), {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok && response.status !== 412) {
    throw new Error(`Firebase database request failed (HTTP ${response.status})`);
  }
  return {
    status: response.status,
    data,
    etag: response.headers.get("etag") || ""
  };
}

export async function dbGet(env, path) {
  return (await databaseRequest(env, path)).data;
}

export async function dbSet(env, path, value) {
  return (await databaseRequest(env, path, { method: "PUT", body: value })).data;
}

export async function dbPatch(env, path, value) {
  return (await databaseRequest(env, path, { method: "PATCH", body: value })).data;
}

export async function dbQuery(env, path, child, equalValue, limitToFirst = 0) {
  const query = {
    orderBy: JSON.stringify(child),
    equalTo: JSON.stringify(equalValue)
  };
  if (limitToFirst > 0) query.limitToFirst = limitToFirst;
  return (await databaseRequest(env, path, { query })).data || {};
}

export async function dbTransaction(env, path, updater, maxAttempts = 8) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = await databaseRequest(env, path, { wantEtag: true });
    if (!current.etag) throw new Error("Firebase did not return a transaction ETag");
    const next = updater(current.data);
    const saved = await databaseRequest(env, path, {
      method: "PUT",
      body: next,
      ifMatch: current.etag
    });
    if (saved.status !== 412) return saved.data;
  }
  throw new Error("Firebase transaction was busy; please retry");
}
