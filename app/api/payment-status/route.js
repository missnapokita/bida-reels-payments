import { NextResponse } from "next/server";
import { firebaseAuth, firebaseDatabase } from "../../../lib/firebase";
import { paymongoRequest } from "../../../lib/paymongo";
import {
  grantVipForCheckout,
  paidAmountFromCheckout,
  verifyCheckoutPaid
} from "../../../lib/vip";
import { VIP_PLANS } from "../../../lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function reply(body, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

export async function POST(request) {
  try {
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ")) {
      return reply({ ok: false, error: "Authentication required" }, 401);
    }
    const decoded = await firebaseAuth().verifyIdToken(authorization.slice(7));
    const body = await request.json().catch(() => ({}));
    let orderId = String(body.orderId || "");
    if (orderId && !/^[a-zA-Z0-9-]{10,80}$/.test(orderId)) {
      return reply({ ok: false, error: "Invalid order" }, 400);
    }

    const db = firebaseDatabase();
    if (!orderId) {
      const candidates = await db.ref("paymentCheckouts")
        .orderByChild("uid")
        .equalTo(decoded.uid)
        .get();
      let newest = null;
      candidates.forEach((child) => {
        const value = child.val() || {};
        if (value.status === "paid") return;
        if (!newest || Number(value.createdAt) > Number(newest.value.createdAt)) {
          newest = { orderId: child.key, value };
        }
      });
      if (!newest) return reply({ ok: true, status: "none" });
      orderId = newest.orderId;
    }
    const checkoutRef = db.ref(`paymentCheckouts/${orderId}`);
    const checkout = (await checkoutRef.get()).val();
    if (!checkout || checkout.uid !== decoded.uid) {
      return reply({ ok: false, error: "Order not found" }, 404);
    }
    if (checkout.status === "paid") {
      const user = (await db.ref(`users/${decoded.uid}`).get()).val() || {};
      return reply({
        ok: true,
        status: "paid",
        orderId,
        vipPlan: user.vipPlan || checkout.planId,
        vipUntil: Number(user.vipUntil) || 0
      });
    }

    const sessionResponse = await paymongoRequest(
      `/checkout_sessions/${encodeURIComponent(checkout.checkoutSessionId)}`,
      { method: "GET" }
    );
    const session = sessionResponse?.data || {};
    if (String(session.id || "") !== String(checkout.checkoutSessionId || "")) {
      throw new Error("Checkout session mismatch");
    }
    const metadata = session?.attributes?.metadata || {};
    if ((metadata.firebase_uid && metadata.firebase_uid !== checkout.uid)
        || (metadata.order_id && metadata.order_id !== orderId)
        || (metadata.plan_id && metadata.plan_id !== checkout.planId)) {
      throw new Error("Checkout metadata mismatch");
    }

    const plan = VIP_PLANS[checkout.planId];
    const amount = paidAmountFromCheckout(session);
    if (Number.isFinite(amount) && amount > 0 && amount !== plan.amount) {
      throw new Error("Paid amount mismatch");
    }
    if (!(await verifyCheckoutPaid(session))) {
      return reply({ ok: true, status: "pending", orderId });
    }

    const vip = await grantVipForCheckout({
      orderId,
      checkout,
      resourceId: String(session.id),
      eventId: "verified_by_app"
    });
    return reply({ ok: true, status: "paid", orderId, ...vip });
  } catch (cause) {
    console.error("payment-status", cause);
    return reply({ ok: false, error: "Unable to verify payment" }, 500);
  }
}
