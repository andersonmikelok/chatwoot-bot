import express from "express";

// Node 18+ tem fetch nativo. Se der erro no seu ambiente, me avise.
const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * ENV no Render (configure em Environment Variables):
 *
 * CHATWOOT_URL=https://chat.smsnet.com.br
 * CHATWOOT_ACCOUNT_ID=195
 *
 * # Opção A (recomendada - a que funcionou no seu curl):
 * CW_ACCESS_TOKEN=xxxx
 * CW_CLIENT=xxxx
 * CW_UID=anderson_mikel@hotmail.com
 * CW_TOKEN_TYPE=Bearer   (opcional, default Bearer)
 *
 * # (Opcional) Opção B (token do perfil - no seu caso deu 401):
 * CHATWOOT_API_TOKEN=xxxx
 *
 * # (Opcional) Se você quiser o bot logar e também conseguir renovar tokens via login:
 * CW_EMAIL=anderson_mikel@hotmail.com
 * CW_PASSWORD=xxxx
 */

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;

// Opção B (token “Perfil/Settings”)
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || "";

// Opção A (tokens do DevTools / auth/sign_in)
let CW_ACCESS_TOKEN = process.env.CW_ACCESS_TOKEN || "";
let CW_CLIENT = process.env.CW_CLIENT || "";
let CW_UID = process.env.CW_UID || "";
let CW_TOKEN_TYPE = process.env.CW_TOKEN_TYPE || "Bearer";

const CW_EMAIL = process.env.CW_EMAIL || "";
const CW_PASSWORD = process.env.CW_PASSWORD || "";

// ========= Helpers =========

function assertEnvBasic() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");

  if (missing.length) {
    console.error("❌ Faltando ENV:", missing.join(" / "));
    return false;
  }
  return true;
}

function hasHeaderTokens() {
  return Boolean(CW_ACCESS_TOKEN && CW_CLIENT && CW_UID);
}

function buildAuthHeaders() {
  // Preferir o modo A (header tokens) porque foi o único que autenticou no seu ambiente.
  if (hasHeaderTokens()) {
    return {
      "Content-Type": "application/json",
      "access-token": CW_ACCESS_TOKEN,
      client: CW_CLIENT,
      uid: CW_UID,
      "token-type": CW_TOKEN_TYPE || "Bearer",
    };
  }

  // Fallback: modo B (api_access_token / Authorization)
  const headers = { "Content-Type": "application/json" };
  if (CHATWOOT_API_TOKEN) {
    headers["api_access_token"] = CHATWOOT_API_TOKEN;
    headers["Authorization"] = `Bearer ${CHATWOOT_API_TOKEN}`;
  }
  return headers;
}

async function chatwootFetch(path, { method = "GET", body } = {}) {
  const url = `${CHATWOOT_URL}${path}`;

  const res = await fetch(url, {
    method,
    headers: buildAuthHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // pode vir HTML em erros
  }

  if (!res.ok) {
    const err = {
      ok: false,
      status: res.status,
      url,
      body: json || text,
      message: `Chatwoot API ${res.status}`,
    };
    throw err;
  }

  return json || { ok: true };
}

async function sendMessageToConversation(conversationId, content) {
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    {
      method: "POST",
      body: { content, message_type: "outgoing" }, // alguns chatwoot ignoram, mas não atrapalha
    }
  );
}

// ========= (Opcional) renovar tokens via login =========
// Isso ajuda se você quiser automatizar e não depender do DevTools.
async function signInAndSetTokens() {
  if (!CW_EMAIL || !CW_PASSWORD) {
    throw new Error("CW_EMAIL/CW_PASSWORD não configurados para sign-in.");
  }

  const url = `${CHATWOOT_URL}/auth/sign_in`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: CW_EMAIL, password: CW_PASSWORD }),
  });

  // pega headers de autenticação
  const accessToken = res.headers.get("access-token");
  const client = res.headers.get("client");
  const uid = res.headers.get("uid");
  const tokenType = res.headers.get("token-type") || "Bearer";

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok || !accessToken || !client || !uid) {
    throw {
      ok: false,
      status: res.status,
      url,
      body: json || text,
      message: "Falha no sign-in /auth/sign_in",
    };
  }

  // seta em memória (vale até reiniciar container)
  CW_ACCESS_TOKEN = accessToken;
  CW_CLIENT = client;
  CW_UID = uid;
  CW_TOKEN_TYPE = tokenType;

  console.log("✅ Sign-in OK. Tokens atualizados em memória:", {
    accessToken: CW_ACCESS_TOKEN,
    client: CW_CLIENT,
    uid: CW_UID,
    tokenType: CW_TOKEN_TYPE,
  });

  return { ok: true, accessToken, client, uid, tokenType };
}

// ========= Rotas =========

app.get("/", (req, res) => {
  res.send("Bot online 🚀");
});

// Debug rápido: mostra se ENV principal está ok (sem vazar tokens)
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasBasicEnv: assertEnvBasic(),
    hasHeaderTokens: hasHeaderTokens(),
    url: CHATWOOT_URL,
    accountId: CHATWOOT_ACCOUNT_ID,
  });
});

// Testa autenticação com Chatwoot
app.get("/test-chatwoot", async (req, res) => {
  try {
    if (!assertEnvBasic()) return res.status(500).json({ ok: false, error: "Missing basic ENV" });

    const profile = await chatwootFetch("/api/v1/profile");
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(500).json(e);
  }
});

// (Opcional) gerar tokens via login (não salva em ENV; só em memória)
app.post("/auth-refresh", async (req, res) => {
  try {
    if (!assertEnvBasic()) return res.status(500).json({ ok: false, error: "Missing basic ENV" });
    const r = await signInAndSetTokens();
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || e });
  }
});

// Webhook do Chatwoot
app.post("/chatwoot-webhook", async (req, res) => {
  // Responde logo para o Chatwoot não reenviar por timeout
  res.status(200).send("ok");

  try {
    if (!assertEnvBasic()) {
      console.error("❌ Missing basic ENV");
      return;
    }

    // LOG “à prova de bala” (não remove até funcionar 100%)
    console.log("📩 WEBHOOK HIT", new Date().toISOString());
    console.log("RAW BODY:", JSON.stringify(req.body));

    const event = req.body?.event;
    console.log("event:", event);

    // Aceitar os eventos principais
    const allowed = new Set(["message_created", "message_updated", "conversation_created"]);
    if (!allowed.has(event)) {
      console.log("Ignorando event:", event);
      return;
    }

    // Pegar conversationId do jeito mais compatível
    const conversationId =
      req.body?.conversation?.id ||
      req.body?.conversation_id ||
      req.body?.id;

    if (!conversationId) {
      console.log("Sem conversationId no payload.");
      return;
    }

    // Evitar loop:
    // Em instalações como a sua, message_type costuma ser número:
    // 0 = incoming (cliente)
    // 1 = outgoing (agente/bot)
    const messageType = req.body?.message_type;

    // Se vier string, tratar também.
    const isIncoming =
      messageType === 0 ||
      messageType === "incoming" ||
      messageType === "Incoming" ||
      req.body?.incoming === true;

    if (!isIncoming) {
      console.log("Ignorando (não incoming). message_type:", messageType);
      return;
    }

    // Não responder mensagens privadas
    if (req.body?.private === true) {
      console.log("Ignorando mensagem privada");
      return;
    }

    // Evita responder “update” repetido sem conteúdo (depende do provedor)
    const content = req.body?.content || req.body?.message?.content || "";
    if (!content || !String(content).trim()) {
      console.log("Ignorando evento sem conteúdo.");
      return;
    }

    // Resposta do bot
    const reply = "🤖 Olá! Sou o bot automático. Como posso ajudar?";

    const sent = await sendMessageToConversation(conversationId, reply);

    console.log("✅ Resposta enviada", {
      conversationId,
      sentId: sent?.id,
    });
  } catch (e) {
    console.error("❌ Erro no webhook:", e);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Rodando na porta", port));
