import { assertBindings } from "./http.js";

const API_BASE = "https://api.paymongo.com/v1";
const encoder = new TextEncoder();

export async function paymongoRequest(env, path, options = {}) {
  assertBindings(env, ["PAYMONGO_SECRET_KEY"]);
  const key = String(env.PAYMONGO_SECRET_KEY).trim();
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Basic ${btoa(`${key}:`)}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.errors?.[0]?.detail || `PayMongo HTTP ${response.status}`;
    throw new Error(detail);
  }
  return data;
}

function hex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left, right) {
  const a = String(left || "").toLowerCase();
  const b = String(right || "").toLowerCase();
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function verifyPaymongoSignature(env, rawBody, signatureHeader) {
  assertBindings(env, ["PAYMONGO_SECRET_KEY", "PAYMONGO_WEBHOOK_SECRET"]);
  if (!signatureHeader) return false;

  const parts = {};
  for (const item of signatureHeader.split(",")) {
    const index = item.indexOf("=");
    if (index > 0) parts[item.slice(0, index).trim()] = item.slice(index + 1).trim();
  }
  const timestamp = parts.t;
  const live = String(env.PAYMONGO_SECRET_KEY).startsWith("sk_live_");
  const signature = live ? parts.li : parts.te;
  if (!timestamp || !signature) return false;

  const createdAt = Number(timestamp);
  const age = Math.abs(Date.now() / 1000 - createdAt);
  if (!Number.isFinite(createdAt) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(env.PAYMONGO_WEBHOOK_SECRET)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${rawBody}`)
  );
  return constantTimeEqual(hex(new Uint8Array(digest)), signature);
}
