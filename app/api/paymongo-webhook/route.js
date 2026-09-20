import { NextResponse } from "next/server";
import { firebaseDatabase } from "../../../lib/firebase";
import { verifyPaymongoSignature } from "../../../lib/paymongo";
import { VIP_PLANS } from "../../../lib/plans";

export const runtime = "nodejs";

function value(object, ...paths) {
  for (const path of paths) {
    let current = object;
    for (const part of path) current = current?.[part];
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
}

export async function POST(request) {
  const rawBody = await request.text();
  const signature = request.headers.get("paymongo-signature") || "";
  if (!verifyPaymongoSignature(rawBody, signature)) {
    return NextResponse.json({ ok: false, error: "Invalid signature" }, { status: 401 });
  }

  try {
    const event = JSON.parse(rawBody);
    const eventId = String(event?.data?.id || "");
    const eventType = String(event?.data?.attributes?.type || "");
    if (eventType !== "checkout_session.payment.paid") {
      return NextResponse.json({ ok: true, ignored: true });
    }

    const resource = event?.data?.attributes?.data || {};
    const attributes = resource?.attributes || {};
    const metadata = attributes.metadata || {};
    const orderId = String(metadata.order_id || "");
    if (!eventId || !orderId) throw new Error("Webhook is missing identifiers");

    const db = firebaseDatabase();
    const checkoutRef = db.ref(`paymentCheckouts/${orderId}`);
    const checkoutSnapshot = await checkoutRef.get();
    const checkout = checkoutSnapshot.val();
    if (!checkout) throw new Error("Unknown checkout order");

    const plan = VIP_PLANS[checkout.planId];
    const resourceId = String(resource.id || "");
    if (!plan || checkout.amount !== plan.amount
        || checkout.uid !== metadata.firebase_uid
        || checkout.planId !== metadata.plan_id
        || checkout.checkoutSessionId !== resourceId) {
      throw new Error("Checkout verification mismatch");
    }

    const paidAmount = Number(value(attributes,
      ["payments", 0, "attributes", "amount"],
      ["payment_intent", "attributes", "amount"]));
    if (Number.isFinite(paidAmount) && paidAmount > 0 && paidAmount !== plan.amount) {
      throw new Error("Paid amount mismatch");
    }

    const paidAt = Date.now();
    const userRef = db.ref(`users/${checkout.uid}`);
    const transaction = await userRef.transaction((user) => {
      if (!user) return;
      user.appliedPayments = user.appliedPayments || {};
      if (user.appliedPayments[resourceId]) return user;
      const oldUntil = Math.max(Number(user.vipUntil) || 0, Number(user.adsDisabledUntil) || 0);
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
    if (!transaction.committed) throw new Error("User account is unavailable");

    await Promise.all([
      checkoutRef.update({ status: "paid", paidAt, eventId }),
      db.ref(`payments/${resourceId}`).set({
        uid: checkout.uid,
        email: checkout.email || "",
        planId: checkout.planId,
        amount: plan.amount,
        currency: "PHP",
        provider: "paymongo",
        status: "paid",
        orderId,
        eventId,
        paidAt
      })
    ]);
    return NextResponse.json({ ok: true });
  } catch (cause) {
    console.error("paymongo-webhook", cause);
    return NextResponse.json({ ok: false, error: "Webhook processing failed" }, { status: 500 });
  }
}
