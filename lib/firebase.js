import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
  const parsed = JSON.parse(raw);
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
}

function app() {
  if (getApps().length) return getApps()[0];
  const databaseURL = process.env.FIREBASE_DATABASE_URL;
  if (!databaseURL) throw new Error("FIREBASE_DATABASE_URL is not configured");
  return initializeApp({ credential: cert(serviceAccount()), databaseURL });
}

export function firebaseAuth() {
  return getAuth(app());
}

export function firebaseDatabase() {
  return getDatabase(app());
}
