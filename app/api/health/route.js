import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "bida-reels-payments",
    paymongoConfigured: Boolean(process.env.PAYMONGO_SECRET_KEY),
    firebaseConfigured: Boolean(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON && process.env.FIREBASE_DATABASE_URL
    ),
    webhookConfigured: Boolean(process.env.PAYMONGO_WEBHOOK_SECRET)
  });
}
