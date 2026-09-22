import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { firebaseAuth, firebaseDatabase } from "../../../lib/firebase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FREE_EPISODES = 5;
const UNLOCK_BATCH = 5;
const UNLOCK_VALID_MS = 60 * 60 * 1000;
const MAX_CLAIMS_PER_HOUR = 20;
const MIN_CLAIM_GAP_MS = 10000;
const CLAIM_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function reply(body, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  try {
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ")) return reply({ ok: false, error: "Sign in required" }, 401);
    const user = await firebaseAuth().verifyIdToken(authorization.slice(7));
    const input = await request.json().catch(() => ({}));
    const seriesKey = typeof input.seriesKey === "string" ? input.seriesKey.trim() : "";
    const claimId = typeof input.claimId === "string" ? input.claimId.trim().toLowerCase() : "";
    if (!seriesKey || seriesKey.length > 180 || !CLAIM_ID.test(claimId)) {
      return reply({ ok: false, error: "Invalid unlock request" }, 400);
    }
    const database = firebaseDatabase();
    const account = (await database.ref(`users/${user.uid}`).get()).val() || {};
    if (account.blocked === true) return reply({ ok: false, error: "Account blocked" }, 403);

    const seriesId = crypto.createHash("sha256")
      .update(seriesKey.toLowerCase(), "utf8").digest("hex").slice(0, 32);
    const ref = database.ref(`episode_unlocks/${user.uid}/${seriesId}`);
    const now = Date.now();
    let refused = "";
    const result = await ref.transaction((current) => {
      const previous = current && typeof current === "object" ? current : {};
      const rawClaims = previous.server_claims && typeof previous.server_claims === "object"
        ? previous.server_claims : {};
      const claims = {};
      for (const [id, timestamp] of Object.entries(rawClaims)) {
        if (CLAIM_ID.test(id) && Number(timestamp) > now - UNLOCK_VALID_MS) {
          claims[id] = Number(timestamp);
        }
      }
      if (Object.prototype.hasOwnProperty.call(claims, claimId)) {
        refused = "duplicate";
        return; // Transaction is aborted; retries cannot grant twice.
      }
      if (Object.keys(claims).length >= MAX_CLAIMS_PER_HOUR) {
        refused = "limit";
        return;
      }
      if (Number(previous.last_server_claim_at) > now - MIN_CLAIM_GAP_MS) {
        refused = "wait";
        return;
      }
      const active = Number(previous.expires_at) > now;
      const through = active ? Math.max(FREE_EPISODES, Number(previous.unlocked_through) || 0)
        : FREE_EPISODES;
      if (through >= 10000) {
        refused = "limit";
        return;
      }
      claims[claimId] = now;
      return {
        ...previous,
        unlocked_through: Math.min(10000, through + UNLOCK_BATCH),
        series_key: seriesKey,
        updated_at: now,
        expires_at: now + UNLOCK_VALID_MS,
        server_claims: claims,
        last_server_claim_at: now
      };
    }, undefined, false);
    const saved = result.snapshot.val() || {};
    if (!result.committed) {
      if (refused === "duplicate" && saved.server_claims?.[claimId]
          && Number(saved.expires_at) > now) {
        return reply({ ok: true, unlockedThrough: Number(saved.unlocked_through) || FREE_EPISODES,
          expiresAt: Number(saved.expires_at) || 0, duplicate: true });
      }
      return reply({ ok: false, error: "Unlock limit reached; please wait" }, 429);
    }
    return reply({ ok: true, unlockedThrough: Number(saved.unlocked_through),
      expiresAt: Number(saved.expires_at) });
  } catch (error) {
    console.error("episode-unlock", error);
    return reply({ ok: false, error: "Unlock unavailable; please try again" }, 503);
  }
}
