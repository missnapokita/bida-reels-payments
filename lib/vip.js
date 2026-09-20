import { firebaseDatabase } from "./firebase";
import { paymongoRequest } from "./paymongo";
import { VIP_PLANS } from "./plans";

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

export function paidAmountFromCheckout(session) {
  const attributes = session?.attributes || {};
  return Number(nested(attributes,
    ["payments", 0, "attributes", "amount"],
    ["payment_intent", "attributes", "amount"],
    ["payment_intent", "data", "attributes", "amount"]));
}

export async function verifyCheckoutPaid(session) {
  const attributes = session?.attributes || {};
  const payments = Array.isArray(attributes.payments) ? attributes.payments : [];
  if (statusIsPaid(attributes.payment_status)
      || statusIsPaid(attributes.status)
      || payments.some((item) => statusIsPaid(resource(item)?.attributes?.status))) {
    return true;
  }

  let intent = paymentIntentFrom(session);
  if (statusIsPaid(intent?.attributes?.status)) return true;

  const intentId = String(intent?.id || attributes.payment_intent_id || "");
  if (!intentId) return false;
  const response = await paymongoRequest(`/payment_intents/${intentId}`, {
    method: "GET"
  });
  intent = resource(response);
  return statusIsPaid(intent?.attributes?.status);
}

export async function findCheckoutBySessionId(sessionId) {
  const snapshot = await firebaseDatabase().ref("paymentCheckouts")
    .orderByChild("checkoutSessionId")
    .equalTo(sessionId)
    .limitToFirst(1)
    .get();
  let result = null;
  snapshot.forEach((child) => {
    if (!result) result = { orderId: child.key, checkout: child.val() };
  });
  return result;
}

export async function grantVipForCheckout({ orderId, checkout, resourceId, eventId }) {
  const plan = VIP_PLANS[checkout?.planId];
  if (!plan || !checkout?.uid || !resourceId) {
    throw new Error("Invalid checkout record");
  }

  const db = firebaseDatabase();
  const paidAt = Date.now();
  const userRef = db.ref(`users/${checkout.uid}`);
  const transaction = await userRef.transaction((current) => {
    const user = current && typeof current === "object" ? current : {};
    user.appliedPayments = user.appliedPayments || {};
    if (user.appliedPayments[resourceId]) return user;
    const oldUntil = Math.max(Number(user.vipUntil) || 0,
      Number(user.adsDisabledUntil) || 0);
    const newUntil = Math.max(oldUntil, paidAt) + plan.durationMs;
    user.vipPlan = checkout.planId;
    user.vipGrantedAt = paidAt;
    user.vipUntil = newUntil;
    user.adsDisabledUntil = newUntil;
    user.vipGrantedBy = "paymongo";
    user.paymentSource = "paymongo";
    user.subscriptionStatus = "active";
    user.appliedPayments[resourceId] = true;
    return user;
  });
  if (!transaction.committed) throw new Error("Unable to update user account");

  const user = transaction.snapshot.val() || {};
  await Promise.all([
    db.ref(`paymentCheckouts/${orderId}`).update({
      status: "paid",
      paidAt: Number(user.vipGrantedAt) || paidAt,
      eventId: eventId || "verified_by_app"
    }),
    db.ref(`payments/${resourceId}`).update({
      uid: checkout.uid,
      email: checkout.email || "",
      planId: checkout.planId,
      amount: plan.amount,
      currency: "PHP",
      provider: "paymongo",
      status: "paid",
      orderId,
      eventId: eventId || "verified_by_app",
      paidAt: Number(user.vipGrantedAt) || paidAt
    })
  ]);
  return {
    vipPlan: checkout.planId,
    vipUntil: Number(user.vipUntil) || 0
  };
}
