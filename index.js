import express from "express";
import axios from "axios";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "2mb" }));

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const PORT = Number(process.env.PORT || 10000);

const CW_UID = process.env.CW_UID; // email
const CW_PASSWORD = process.env.CW_PASSWORD;

const BOT_REPLY_PREFIX = process.env.BOT_REPLY_PREFIX || "🤖 ";
const ENABLE_VALIDATE_TOKEN =
  (process.env.ENABLE_VALIDATE_TOKEN || "true").toLowerCase() === "true";

function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!CW_UID) missing.push("CW_UID");
  if (!CW_PASSWORD) missing.push("CW_PASSWORD");

  if (missing.length) {
    console.error("Faltando ENV:", missing.join(" / "));
    return false;
  }
  return true;
}

// --- Auth cache (Devise Token Auth)
let auth = {
  accessToken: process.env.CW_ACCESS_TOKEN || null,
  client: process.env.CW_CLIENT || null,
  uid: process.env.CW_UID || CW_UID || null,
  tokenType: "Bearer",
  expiry: process.env.CW_EXPIRY ? Number(process.env.CW_EXPIRY) : 0, // epoch seconds
};

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
  return auth.expiry - nowSec < 120;
}

async function signIn() {
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
  return true;
}

async function ensureAuth() {
  if (!auth.accessToken || !auth.client || !auth.uid || isExpiredSoon()) {
    await signIn();
    return;
  }
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
    if (e?.response?.status === 401) {
      await signIn();
      const res2 = await fn();
      setAuthFromHeaders(res2.headers);
      return res2;
    }
    throw e;
  }
}

async function chatwootSendMessage(conversationId, content) {
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

// --- Dedupe simples pra evitar respostas duplicadas
const seen = new Map();
const DEDUPE_TTL_MS = 2 * 60 * 1000;

function cleanupSeen() {
  const cutoff = Date.now() - DEDUPE_TTL_MS;
  for (const [k, t] of seen.entries()) if (t < cutoff) seen.delete(k);
}
function hasSeen(key) {
  cleanupSeen();
  return seen.has(key);
}
function markSeen(key) {
  cleanupSeen();
  seen.set(key, Date.now());
}

// Health
app.get("/", (_req, res) => res.send("Bot online 🚀"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// Teste: valida se auth funciona
app.get("/test-chatwoot", async (_req, res) => {
  try {
    if (!assertEnv()) return res.status(500).json({ ok: false, error: "Missing ENV" });
    const r = await requestWithAuth(() =>
      axios.get(`${CHATWOOT_URL}/api/v1/profile`, { headers: authHeaders(), timeout: 15000 })
    );
    res.json({ ok: true, profile: r.data, auth: { uid: auth.uid, expiry: auth.expiry } });
  } catch (e) {
    res.status(500).json({ ok: false, status: e?.response?.status, data: e?.response?.data, message: e?.message });
  }
});

// Webhook
app.post("/chatwoot-webhook", async (req, res) => {
  // responde logo pra evitar retry por timeout
  res.status(200).send("ok");

  try {
    if (!assertEnv()) return;

    const payload = req.body || {};
    const event = payload?.event || payload?.type || payload?.event_name;
    if (event !== "message_created") return;

    // message_type no webhook geralmente é número: 0 incoming, 1 outgoing
    const messageType = payload?.message_type ?? payload?.message?.message_type;
    if (messageType !== 0) return; // ignora outgoing e outros

    const conversationId =
      payload?.conversation?.id ?? payload?.conversation_id ?? payload?.message?.conversation_id;
    const content = payload?.content ?? payload?.message?.content ?? "";
    const messageId = payload?.id ?? payload?.message?.id;

    if (!conversationId || !content) return;
    if (payload?.private === true) return;

    const dedupeKey = crypto
      .createHash("sha1")
      .update(`${conversationId}:${messageId || ""}:${content}`)
      .digest("hex");

    if (hasSeen(dedupeKey)) return;
    markSeen(dedupeKey);

    // Resposta simples (troque aqui pela sua lógica do Receitanet/ChatGPT)
    const reply = `${BOT_REPLY_PREFIX}Recebi: "${content}". Como posso ajudar?`;

    const sent = await chatwootSendMessage(conversationId, reply);
    console.log("✅ Reply sent", { conversationId, sentId: sent?.id });
  } catch (e) {
    console.error("❌ Webhook error", { status: e?.response?.status, data: e?.response?.data, message: e?.message });
  }
});

app.listen(PORT, () => console.log("Rodando na porta", PORT));
