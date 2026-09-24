import { dbGet, dbPatch, dbQuery, dbTransaction } from "./firebase.js";
import { paymongoRequest } from "./paymongo.js";
import { VIP_PLANS } from "./plans.js";

function nested(object, ...paths) {
  for (const path of paths) {
    let current = object;
    for (const part of path) current = current?.[part];
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
}

function resource(value) {
  return value?.data || value || {};
}

function statusIsPaid(value) {
  const status = String(value || "").toLowerCase();
  return status === "paid" || status === "succeeded" || status === "completed";
}

function paymentIntentFrom(session) {
  const attributes = session?.attributes || {};
  return resource(attributes.payment_intent || attributes.paymentIntent);
}

function firebaseKey(value) {
  return String(value || "").replace(/[.#$\[\]\/]/g, "_");
}

export function paidAmountFromCheckout(session) {
  const attributes = session?.attributes || {};
  return Number(nested(
    attributes,
    ["payments", 0, "attributes", "amount"],
    ["payment_intent", "attributes", "amount"],
    ["payment_intent", "data", "attributes", "amount"]
  ));
}

export async function verifyCheckoutPaid(env, session) {
  const attributes = session?.attributes || {};
  const payments = Array.isArray(attributes.payments) ? attributes.payments : [];
  if (
    statusIsPaid(attributes.payment_status) ||
    statusIsPaid(attributes.status) ||
    payments.some((item) => statusIsPaid(resource(item)?.attributes?.status))
  ) {
    return true;
  }

  let intent = paymentIntentFrom(session);
  if (statusIsPaid(intent?.attributes?.status)) return true;

  const intentId = String(intent?.id || attributes.payment_intent_id || "");
  if (!intentId) return false;
  const response = await paymongoRequest(
    env,
    `/payment_intents/${encodeURIComponent(intentId)}`,
    { method: "GET" }
  );
  intent = resource(response);
  return statusIsPaid(intent?.attributes?.status);
}

export async function findCheckoutBySessionId(env, sessionId) {
  const matches = await dbQuery(
    env,
    "paymentCheckouts",
    "checkoutSessionId",
    sessionId,
    1
  );
  for (const [orderId, checkout] of Object.entries(matches || {})) {
    return { orderId, checkout };
  }
  return null;
}

export async function newestPendingCheckout(env, uid) {
  const matches = await dbQuery(env, "paymentCheckouts", "uid", uid);
  let newest = null;
  for (const [orderId, value] of Object.entries(matches || {})) {
    if (!value || value.status === "paid") continue;
    if (!newest || Number(value.createdAt) > Number(newest.value.createdAt)) {
      newest = { orderId, value };
    }
  }
  return newest;
}

export async function grantVipForCheckout(env, {
  orderId,
  checkout,
  resourceId,
  eventId
}) {
  const plan = VIP_PLANS[checkout?.planId];
  if (!plan || !checkout?.uid || !resourceId) {
    throw new Error("Invalid checkout record");
  }

  const paidAt = Date.now();
  const paymentKey = firebaseKey(resourceId);
  const user = await dbTransaction(env, `users/${checkout.uid}`, (current) => {
    const next = current && typeof current === "object" ? { ...current } : {};
    next.appliedPayments = next.appliedPayments && typeof next.appliedPayments === "object"
      ? { ...next.appliedPayments }
      : {};
    if (next.appliedPayments[paymentKey]) return next;

    const oldUntil = Math.max(
      Number(next.vipUntil) || 0,
      Number(next.adsDisabledUntil) || 0
    );
    const newUntil = Math.max(oldUntil, paidAt) + plan.durationMs;
    next.vipPlan = checkout.planId;
    next.vipGrantedAt = paidAt;
    next.vipUntil = newUntil;
    next.adsDisabledUntil = newUntil;
    next.vipGrantedBy = "paymongo";
    next.paymentSource = "paymongo";
    next.subscriptionStatus = "active";
    next.appliedPayments[paymentKey] = true;
    return next;
  });

  const recordedAt = Number(user?.vipGrantedAt) || paidAt;
  await dbPatch(env, "", {
    [`paymentCheckouts/${orderId}/status`]: "paid",
    [`paymentCheckouts/${orderId}/paidAt`]: recordedAt,
    [`paymentCheckouts/${orderId}/eventId`]: eventId || "verified_by_app",
    [`payments/${paymentKey}`]: {
      uid: checkout.uid,
      email: checkout.email || "",
      planId: checkout.planId,
      amount: plan.amount,
      currency: "PHP",
      provider: "paymongo",
      status: "paid",
      orderId,
      eventId: eventId || "verified_by_app",
      paidAt: recordedAt,
      providerResourceId: resourceId
    }
  });

  return {
    vipPlan: checkout.planId,
    vipUntil: Number(user?.vipUntil) || 0
  };
}

export async function paidUserStatus(env, uid, checkout) {
  const user = (await dbGet(env, `users/${uid}`)) || {};
  return {
    vipPlan: user.vipPlan || checkout.planId,
    vipUntil: Number(user.vipUntil) || 0
  };
}
