/**
 * server.js — Chatwoot webhook -> auto-reply bot (Devise Token Auth)
 *
 * ✅ Works with Chatwoot instances that authenticate with:
 *    access-token, client, uid, token-type (Bearer)
 *
 * ENV required:
 *   CHATWOOT_URL=https://chat.smsnet.com.br
 *   CHATWOOT_ACCOUNT_ID=195
 *   CW_UID=bot@seuemail.com   (ou seu email)
 *   CW_PASSWORD=suasenha      (ideal: usuário BOT)
 *
 * Optional ENV:
 *   PORT=10000
 *   BOT_IGNORE_PREFIX=✅ teste bot  (se quiser ignorar mensagens que começam com isso)
 *   BOT_REPLY_PREFIX=🤖            (prefixo das mensagens do bot)
 *   ENABLE_VALIDATE_TOKEN=true|false (default true)
 */

import express from "express";
import axios from "axios";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "2mb" }));

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/$/, "");
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const PORT = Number(process.env.PORT || 10000);

const CW_UID = process.env.CW_UID;
const CW_PASSWORD = process.env.CW_PASSWORD;

const BOT_IGNORE_PREFIX = process.env.BOT_IGNORE_PREFIX || "";
const BOT_REPLY_PREFIX = process.env.BOT_REPLY_PREFIX || "🤖 ";
const ENABLE_VALIDATE_TOKEN = (process.env.ENABLE_VALIDATE_TOKEN || "true").toLowerCase() === "true";

if (!CHATWOOT_URL || !ACCOUNT_ID) {
  console.error("Missing CHATWOOT_URL or CHATWOOT_ACCOUNT_ID in ENV.");
  process.exit(1);
}
if (!CW_UID || !CW_PASSWORD) {
  console.warn("⚠️ Missing CW_UID/CW_PASSWORD. Bot can only work if you hardcode tokens or add login envs.");
}

let auth = {
  accessToken: process.env.CW_ACCESS_TOKEN || null,
  client: process.env.CW_CLIENT || null,
  uid: process.env.CW_UID || CW_UID || null,
  tokenType: "Bearer",
  expiry: process.env.CW_EXPIRY ? Number(process.env.CW_EXPIRY) : 0, // epoch seconds
};

// simple in-memory dedupe to avoid double replies if Chatwoot retries webhook
// key -> timestamp
const seen = new Map();
const DEDUPE_TTL_MS = 2 * 60 * 1000; // 2 minutes

function nowMs() {
  return Date.now();
}
function cleanupSeen() {
  const cutoff = nowMs() - DEDUPE_TTL_MS;
  for (const [k, t] of seen.entries()) {
    if (t < cutoff) seen.delete(k);
  }
}
function markSeen(key) {
  cleanupSeen();
  seen.set(key, nowMs());
}
function hasSeen(key) {
  cleanupSeen();
  return seen.has(key);
}

function setAuthFromHeaders(headers = {}) {
  if (headers["access-token"]) auth.accessToken = headers["access-token"];
  if (headers["client"]) auth.client = headers["client"];
  if (headers["uid"]) auth.uid = headers["uid"];
  if (headers["token-type"]) auth.tokenType = headers["token-type"];
  if (headers["expiry"]) auth.expiry = Number(headers["expiry"]);
}

function authHeaders() {
  if (!auth.accessToken || !auth.client || !auth.uid) return {};
  return {
    "access-token": auth.accessToken,
    client: auth.client,
    uid: auth.uid,
    "token-type": auth.tokenType || "Bearer",
  };
}

function isExpiredSoon() {
  if (!auth.expiry) return true;
  const nowSec = Math.floor(Date.now() / 1000);
  return auth.expiry - nowSec < 120; // renew if <2 min left
}

async function signIn() {
  if (!CW_UID || !CW_PASSWORD) {
    throw new Error("CW_UID/CW_PASSWORD not set. Can't sign in automatically.");
  }
  const res = await axios.post(
    `${CHATWOOT_URL}/auth/sign_in`,
    { email: CW_UID, password: CW_PASSWORD },
    { headers: { "Content-Type": "application/json" }, timeout: 15000 }
  );
  setAuthFromHeaders(res.headers);
  return true;
}

async function validateToken() {
  const res = await axios.get(`${CHATWOOT_URL}/auth/validate_token`, {
    headers: authHeaders(),
    timeout: 15000,
  });
  setAuthFromHeaders(res.headers);
  return res.data;
}

async function ensureAuth() {
  // If no token or expired, sign in
  if (!auth.accessToken || !auth.client || !auth.uid || isExpiredSoon()) {
    await signIn();
    return;
  }

  // Optional validate (some setups rotate token on validate)
  if (ENABLE_VALIDATE_TOKEN) {
    try {
      await validateToken();
    } catch {
      await signIn();
    }
  }
}

async function requestWithAuth(fn) {
  await ensureAuth();
  try {
    const res = await fn();
    setAuthFromHeaders(res.headers);
    return res;
  } catch (e) {
    const status = e?.response?.status;
    if (status === 401) {
      // refresh and retry once
      await signIn();
      const res2 = await fn();
      setAuthFromHeaders(res2.headers);
      return res2;
    }
    throw e;
  }
}

async function sendConversationMessage(conversationId, content) {
  const url = `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/messages`;
  const res = await requestWithAuth(() =>
    axios.post(
      url,
      { content, message_type: "outgoing" },
      {
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        timeout: 20000,
      }
    )
  );
  return res.data;
}

// Basic healthcheck
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

/**
 * Chatwoot webhook endpoint
 * You said Chatwoot sends "message_created" here.
 */
app.post("/chatwoot-webhook", async (req, res) => {
  try {
    const payload = req.body || {};
    const event = payload?.event || payload?.type || payload?.event_name;

    // Always ACK quickly (Chatwoot can retry). We'll still process before returning,
    // but avoid hanging too long.
    // If you prefer: return res.sendStatus(200) and process async (queue).
    // For now: process inline.
    if (!event) {
      return res.sendStatus(200);
    }

    // Only handle message_created
    if (event !== "message_created") {
      return res.sendStatus(200);
    }

    // Extract common fields (Chatwoot payloads vary a bit by version)
    const messageType = payload?.message_type ?? payload?.message?.message_type;
    const messageId = payload?.id ?? payload?.message?.id;
    const conversationId = payload?.conversation?.id ?? payload?.conversation_id ?? payload?.message?.conversation_id;
    const content = payload?.content ?? payload?.message?.content ?? "";

    // Anti-loop: respond only to incoming messages (usually 0)
    if (messageType !== 0) {
      return res.sendStatus(200);
    }

    // If content empty, do nothing
    if (!conversationId || !content || typeof content !== "string") {
      return res.sendStatus(200);
    }

    // Optional: ignore messages that start with some prefix (useful if you echo)
    if (BOT_IGNORE_PREFIX && content.startsWith(BOT_IGNORE_PREFIX)) {
      return res.sendStatus(200);
    }

    // Dedupe: prevent double-reply if webhook is retried
    const dedupeKey = crypto
      .createHash("sha1")
      .update(`${conversationId}:${messageId || ""}:${content}`)
      .digest("hex");

    if (hasSeen(dedupeKey)) {
      return res.sendStatus(200);
    }
    markSeen(dedupeKey);

    // TODO: here you plug Receitanet/OpenAI logic.
    // For now: simple reply
    const reply = `${BOT_REPLY_PREFIX}Recebi sua mensagem: "${content}". (resposta automática)`;

    const sent = await sendConversationMessage(conversationId, reply);

    console.log("✅ Replied", {
      conversationId,
      incomingMessageId: messageId,
      sentMessageId: sent?.id,
    });

    return res.sendStatus(200);
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error("❌ Webhook handler error", { status, data, message: err?.message });
    // Still return 200 to avoid Chatwoot retry loops while you debug
    return res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`Bot listening on port ${PORT}`);
});
