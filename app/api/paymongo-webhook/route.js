import { NextResponse } from "next/server";
import { firebaseDatabase } from "../../../lib/firebase";
import { verifyPaymongoSignature } from "../../../lib/paymongo";
import { findCheckoutBySessionId, grantVipForCheckout } from "../../../lib/vip";
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
    let orderId = String(metadata.order_id || "");
    const resourceId = String(resource.id || "");
    if (!eventId || !resourceId) throw new Error("Webhook is missing identifiers");

    const db = firebaseDatabase();
    let checkout = orderId
      ? (await db.ref(`paymentCheckouts/${orderId}`).get()).val()
      : null;
    if (!checkout) {
      const match = await findCheckoutBySessionId(resourceId);
      orderId = match?.orderId || "";
      checkout = match?.checkout || null;
    }
    if (!checkout) throw new Error("Unknown checkout order");

    const plan = VIP_PLANS[checkout.planId];
    if (!plan || checkout.amount !== plan.amount
        || (metadata.firebase_uid && checkout.uid !== metadata.firebase_uid)
        || (metadata.plan_id && checkout.planId !== metadata.plan_id)
        || (metadata.order_id && orderId !== metadata.order_id)
        || checkout.checkoutSessionId !== resourceId) {
      throw new Error("Checkout verification mismatch");
    }

    const paidAmount = Number(value(attributes,
      ["payments", 0, "attributes", "amount"],
      ["payment_intent", "attributes", "amount"]));
    if (Number.isFinite(paidAmount) && paidAmount > 0 && paidAmount !== plan.amount) {
      throw new Error("Paid amount mismatch");
    }

    await grantVipForCheckout({ orderId, checkout, resourceId, eventId });
    return NextResponse.json({ ok: true });
  } catch (cause) {
    console.error("paymongo-webhook", cause);
    return NextResponse.json({ ok: false, error: "Webhook processing failed" }, { status: 500 });
  }
}
