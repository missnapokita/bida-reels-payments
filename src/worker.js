import { dbGet, dbSet } from "./firebase.js";
import { error, HttpError, json, readJson } from "./http.js";
import { verifyFirebaseIdToken } from "./firebase.js";
import { paymongoRequest, verifyPaymongoSignature } from "./paymongo.js";
import { VIP_PLANS } from "./plans.js";
import {
  findCheckoutBySessionId,
  grantVipForCheckout,
  newestPendingCheckout,
  paidAmountFromCheckout,
  paidUserStatus,
  verifyCheckoutPaid
} from "./vip.js";

const ORDER_PATTERN = /^[a-zA-Z0-9-]{10,80}$/;

function value(object, ...paths) {
  for (const path of paths) {
    let current = object;
    for (const part of path) current = current?.[part];
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
}

async function createCheckout(request, env) {
  const user = await verifyFirebaseIdToken(request, env);
  const body = await readJson(request);
  const planId = String(body.planId || "");
  const plan = VIP_PLANS[planId];
  if (!plan) return error("Invalid VIP plan", 400);

  const orderId = crypto.randomUUID();
  const origin = new URL(request.url).origin;
  const payload = {
    data: {
      attributes: {
        billing: {
          email: user.email || undefined,
          name: user.name || "Bida Reels User"
        },
        cancel_url: `${origin}/payment-result?status=cancelled&order=${encodeURIComponent(orderId)}`,
        description: `${plan.label} for Bida Reels`,
        line_items: [{
          amount: plan.amount,
          currency: "PHP",
          description: "Unlock all episodes and disable ads",
          name: plan.label,
          quantity: 1
        }],
        metadata: {
          firebase_uid: user.uid,
          order_id: orderId,
          plan_id: planId
        },
        payment_method_types: ["card", "gcash"],
        send_email_receipt: true,
        show_description: true,
        show_line_items: true,
        success_url: `${origin}/payment-result?status=success&order=${encodeURIComponent(orderId)}`
      }
    }
  };

  const result = await paymongoRequest(env, "/checkout_sessions", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const session = result?.data;
  const checkoutUrl = String(session?.attributes?.checkout_url || "");
  if (!session?.id || !checkoutUrl.startsWith("https://")) {
    throw new Error("PayMongo did not return a secure checkout URL");
  }

  await dbSet(env, `paymentCheckouts/${orderId}`, {
    uid: user.uid,
    email: user.email || "",
    planId,
    amount: plan.amount,
    currency: "PHP",
    checkoutSessionId: String(session.id),
    status: "pending",
    createdAt: Date.now()
  });
  return json({ ok: true, orderId, checkoutUrl });
}

async function paymentStatus(request, env) {
  const user = await verifyFirebaseIdToken(request, env);
  const body = await readJson(request);
  let orderId = String(body.orderId || "");
  if (orderId && !ORDER_PATTERN.test(orderId)) {
    return error("Invalid order", 400);
  }

  if (!orderId) {
    const newest = await newestPendingCheckout(env, user.uid);
    if (!newest) return json({ ok: true, status: "none" });
    orderId = newest.orderId;
  }

  const checkout = await dbGet(env, `paymentCheckouts/${orderId}`);
  if (!checkout || checkout.uid !== user.uid) {
    return error("Order not found", 404);
  }
  const plan = VIP_PLANS[checkout.planId];
  if (!plan || Number(checkout.amount) !== plan.amount) {
    throw new Error("Stored checkout plan is invalid");
  }
  if (checkout.status === "paid") {
    const vip = await paidUserStatus(env, user.uid, checkout);
    return json({ ok: true, status: "paid", orderId, ...vip });
  }

  const sessionResult = await paymongoRequest(
    env,
    `/checkout_sessions/${encodeURIComponent(checkout.checkoutSessionId)}`,
    { method: "GET" }
  );
  const session = sessionResult?.data || {};
  if (String(session.id || "") !== String(checkout.checkoutSessionId || "")) {
    throw new Error("Checkout session mismatch");
  }
  const metadata = session?.attributes?.metadata || {};
  if (
    (metadata.firebase_uid && metadata.firebase_uid !== checkout.uid) ||
    (metadata.order_id && metadata.order_id !== orderId) ||
    (metadata.plan_id && metadata.plan_id !== checkout.planId)
  ) {
    throw new Error("Checkout metadata mismatch");
  }

  const paidAmount = paidAmountFromCheckout(session);
  if (Number.isFinite(paidAmount) && paidAmount > 0 && paidAmount !== plan.amount) {
    throw new Error("Paid amount mismatch");
  }
  if (!(await verifyCheckoutPaid(env, session))) {
    return json({ ok: true, status: "pending", orderId });
  }

  const vip = await grantVipForCheckout(env, {
    orderId,
    checkout,
    resourceId: String(session.id),
    eventId: "verified_by_app"
  });
  return json({ ok: true, status: "paid", orderId, ...vip });
}

async function paymongoWebhook(request, env) {
  const length = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > 256 * 1024) {
    return error("Webhook body is too large", 413);
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 256 * 1024) {
    return error("Webhook body is too large", 413);
  }
  const signature = request.headers.get("paymongo-signature") || "";
  if (!(await verifyPaymongoSignature(env, rawBody, signature))) {
    return error("Invalid signature", 401);
  }

  const event = JSON.parse(rawBody);
  const eventId = String(event?.data?.id || "");
  const eventType = String(event?.data?.attributes?.type || "");
  if (eventType !== "checkout_session.payment.paid") {
    return json({ ok: true, ignored: true });
  }

  const resource = event?.data?.attributes?.data || {};
  const attributes = resource?.attributes || {};
  const metadata = attributes.metadata || {};
  let orderId = String(metadata.order_id || "");
  const resourceId = String(resource.id || "");
  if (!eventId || !resourceId) throw new Error("Webhook is missing identifiers");

  let checkout = orderId ? await dbGet(env, `paymentCheckouts/${orderId}`) : null;
  if (!checkout) {
    const match = await findCheckoutBySessionId(env, resourceId);
    orderId = match?.orderId || "";
    checkout = match?.checkout || null;
  }
  if (!checkout) throw new Error("Unknown checkout order");

  const plan = VIP_PLANS[checkout.planId];
  if (
    !plan ||
    Number(checkout.amount) !== plan.amount ||
    (metadata.firebase_uid && checkout.uid !== metadata.firebase_uid) ||
    (metadata.plan_id && checkout.planId !== metadata.plan_id) ||
    (metadata.order_id && orderId !== metadata.order_id) ||
    checkout.checkoutSessionId !== resourceId
  ) {
    throw new Error("Checkout verification mismatch");
  }

  const paidAmount = Number(value(
    attributes,
    ["payments", 0, "attributes", "amount"],
    ["payment_intent", "attributes", "amount"]
  ));
  if (Number.isFinite(paidAmount) && paidAmount > 0 && paidAmount !== plan.amount) {
    throw new Error("Paid amount mismatch");
  }

  await grantVipForCheckout(env, { orderId, checkout, resourceId, eventId });
  return json({ ok: true });
}

function paymentResult(request) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") === "success" ? "success" : "cancelled";
  const order = ORDER_PATTERN.test(url.searchParams.get("order") || "")
    ? url.searchParams.get("order")
    : "";
  const deepLink = `bidareels://payment?status=${encodeURIComponent(status)}&order=${encodeURIComponent(order)}`;
  const success = status === "success";
  const title = success ? "Payment received" : "Payment cancelled";
  const detail = success
    ? "Return to Bida Reels while we verify and activate your VIP access."
    : "No VIP time was added. You can return to Bida Reels safely.";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090909;color:#fff;font-family:Arial,sans-serif}.card{width:min(86vw,420px);padding:32px 24px;text-align:center;background:#171717;border:1px solid #5a421b;border-radius:24px;box-shadow:0 18px 60px #000}.mark{width:64px;height:64px;margin:auto;display:grid;place-items:center;border-radius:50%;background:linear-gradient(135deg,#ffd21f,#ff9400);color:#111;font-size:30px;font-weight:800}h1{font-size:24px;margin:18px 0 8px}p{color:#aaa;line-height:1.55;margin:0 0 22px}a{display:block;padding:15px 18px;border-radius:16px;background:linear-gradient(90deg,#ffd21f,#ff9400);color:#111;text-decoration:none;font-weight:800}</style></head><body><main class="card"><div class="mark">${success ? "✓" : "×"}</div><h1>${title}</h1><p>${detail}</p><a href="${deepLink}">RETURN TO BIDA REELS</a></main><script>setTimeout(function(){location.href=${JSON.stringify(deepLink)}},500);</script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; navigate-to 'self' bidareels:",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    }
  });
}

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/health") {
    const required = [
      "PAYMONGO_SECRET_KEY",
      "PAYMONGO_WEBHOOK_SECRET",
      "FIREBASE_DATABASE_URL",
      "FIREBASE_SERVICE_ACCOUNT_JSON"
    ];
    const configured = required.every((name) => Boolean(env[name] && String(env[name]).trim()));
    return json({ ok: true, service: "bida-reels-payments-worker", configured });
  }
  if (request.method === "GET" && url.pathname === "/payment-result") {
    return paymentResult(request);
  }
  if (request.method === "POST" && url.pathname === "/api/create-checkout") {
    return createCheckout(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/payment-status") {
    return paymentStatus(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/paymongo-webhook") {
    return paymongoWebhook(request, env);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { Allow: "GET, POST, OPTIONS", "Cache-Control": "no-store" }
    });
  }
  return error("Not found", 404);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (cause) {
      const status = cause instanceof HttpError ? cause.status : 500;
      const publicMessage = cause instanceof HttpError
        ? cause.message
        : "Payment service is temporarily unavailable";
      if (status >= 500) console.error("payment-worker", cause?.message || cause);
      return error(publicMessage, status);
    }
  }
};
