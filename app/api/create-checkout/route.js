import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { firebaseAuth, firebaseDatabase } from "../../../lib/firebase";
import { paymongoRequest } from "../../../lib/paymongo";
import { VIP_PLANS } from "../../../lib/plans";

export const runtime = "nodejs";

function error(message, status) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(request) {
  try {
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ")) return error("Authentication required", 401);
    const decoded = await firebaseAuth().verifyIdToken(authorization.slice(7));
    const body = await request.json().catch(() => ({}));
    const planId = String(body.planId || "");
    const plan = VIP_PLANS[planId];
    if (!plan) return error("Invalid VIP plan", 400);

    const orderId = crypto.randomUUID();
    const origin = new URL(request.url).origin;
    const payload = {
      data: {
        attributes: {
          billing: { email: decoded.email || undefined, name: decoded.name || "Bida Reels User" },
          cancel_url: `${origin}/payment-result?status=cancelled&order=${orderId}`,
          description: `${plan.label} for Bida Reels`,
          line_items: [{
            amount: plan.amount,
            currency: "PHP",
            description: "Unlock all episodes and disable ads",
            name: plan.label,
            quantity: 1
          }],
          metadata: { firebase_uid: decoded.uid, order_id: orderId, plan_id: planId },
          payment_method_types: ["card", "gcash"],
          send_email_receipt: true,
          show_description: true,
          show_line_items: true,
          success_url: `${origin}/payment-result?status=success&order=${orderId}`
        }
      }
    };
    const checkout = await paymongoRequest("/checkout_sessions", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const session = checkout?.data;
    const checkoutUrl = session?.attributes?.checkout_url;
    if (!session?.id || !checkoutUrl) throw new Error("PayMongo did not return a checkout URL");

    await firebaseDatabase().ref(`paymentCheckouts/${orderId}`).set({
      uid: decoded.uid,
      email: decoded.email || "",
      planId,
      amount: plan.amount,
      currency: "PHP",
      checkoutSessionId: session.id,
      status: "pending",
      createdAt: Date.now()
    });
    return NextResponse.json({ ok: true, orderId, checkoutUrl });
  } catch (cause) {
    console.error("create-checkout", cause);
    return error("Unable to create checkout", 500);
  }
}
