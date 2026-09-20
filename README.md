# Bida Reels Payments

Secure PayMongo checkout and Firebase VIP activation service for Bida Reels.

## VIP plans

- 1 week: PHP 29
- 1 month: PHP 79
- 3 months: PHP 199
- 1 year: PHP 599

## Required Vercel environment variables

- `PAYMONGO_SECRET_KEY`
- `PAYMONGO_WEBHOOK_SECRET`
- `FIREBASE_DATABASE_URL`
- `FIREBASE_SERVICE_ACCOUNT_JSON`

Never commit any secret value to GitHub.

## API

- `GET /api/health`
- `POST /api/create-checkout` with Firebase ID token and `{ "planId": "1_month" }`
- `POST /api/paymongo-webhook` for PayMongo

The checkout price is always selected from the server-side plan table. The app cannot supply or change the amount.
