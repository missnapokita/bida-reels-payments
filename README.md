# Bida Reels Payments — Cloudflare Worker

Cloudflare Workers replacement for the old Vercel payment backend.

## Routes

- `GET /api/health`
- `POST /api/create-checkout`
- `POST /api/payment-status`
- `POST /api/paymongo-webhook`
- `GET /payment-result`

The Android response format and plan IDs remain compatible with the existing
`BidaReelsPaymentScreen`.

## Required Worker secrets

Add these under **Cloudflare > Workers & Pages > bida-reels-payments >
Settings > Variables and Secrets**. Select **Secret** for every value.

- `PAYMONGO_SECRET_KEY`
- `PAYMONGO_WEBHOOK_SECRET`
- `FIREBASE_DATABASE_URL`
- `FIREBASE_SERVICE_ACCOUNT_JSON`

These are the same four values from the old Vercel production environment.
Do not commit any real value to GitHub, `.env`, `.dev.vars`, README, or Java.

The same secrets can be added through Wrangler:

```bash
npx wrangler secret put PAYMONGO_SECRET_KEY
npx wrangler secret put PAYMONGO_WEBHOOK_SECRET
npx wrangler secret put FIREBASE_DATABASE_URL
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
```

## Deploy from a computer

```bash
npm install
npx wrangler login
npm run deploy
```

Expected URL for the configured Worker name and existing account subdomain:

`https://bida-reels-payments.zencorpuz729.workers.dev`

Test after deploying:

`https://bida-reels-payments.zencorpuz729.workers.dev/api/health`

It should return:

```json
{"ok":true,"service":"bida-reels-payments-worker","configured":true}
```

## PayMongo webhook cutover

Create or update the PayMongo webhook endpoint to:

`https://bida-reels-payments.zencorpuz729.workers.dev/api/paymongo-webhook`

Subscribe to `checkout_session.payment.paid`. If PayMongo issues a new webhook
signing secret for this endpoint, save that new value as the Worker's
`PAYMONGO_WEBHOOK_SECRET`. An old endpoint's signing secret may not match a new
endpoint.

## Safe migration order

1. Deploy the Worker.
2. Add all four secrets.
3. Confirm `/api/health` returns `"configured": true`.
4. Configure and test the PayMongo webhook.
5. Replace `BidaReelsPaymentScreen.java` in Sketchware and build the app.
6. Run one test checkout and confirm Firebase updates `paymentCheckouts`,
   `payments`, and the user's `vipUntil`.
7. Keep Vercel available during testing. Disable the old Vercel deployment and
   old webhook only after the Worker flow is confirmed.

## Security retained

- Firebase ID tokens are checked against the official Google Secure Token
  certificates, including signature, issuer, audience, expiry, and user ID.
- Realtime Database writes use short-lived service-account OAuth tokens.
- PayMongo webhook HMAC signatures and their five-minute timestamp window are
  verified with Web Crypto.
- Prices and VIP durations remain server-side and cannot be supplied by the APK.
- VIP grants use Firebase ETag transactions and payment-resource idempotency to
  prevent the same checkout from adding VIP twice.
- Only HTTPS checkout URLs are returned to the app.
