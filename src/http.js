const JSON_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=UTF-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer"
});

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

export function error(message, status) {
  return json({ ok: false, error: message }, status);
}

export async function readJson(request, maxBytes = 8192) {
  const length = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new HttpError("Request body is too large", 413);
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new HttpError("Request body is too large", 413);
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new HttpError("Invalid JSON body", 400);
  }
}

export function bearerToken(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

export function assertBindings(env, names) {
  for (const name of names) {
    if (!env[name] || !String(env[name]).trim()) {
      throw new Error(`${name} is not configured`);
    }
  }
}

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
