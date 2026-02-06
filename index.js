import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;

// Preferir tokens do login (devise token auth)
let CW_ACCESS_TOKEN =
  process.env.CW_ACCESS_TOKEN || process.env.ACCESS_TOKEN || "";
let CW_CLIENT = process.env.CW_CLIENT || process.env.CLIENT || "";
let CW_UID = process.env.CW_UID || process.env.UID || "";
let CW_TOKEN_TYPE = process.env.CW_TOKEN_TYPE || "Bearer";

// Fallback (geralmente NÃO funciona na sua instalação)
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || "";

function assertEnvBasic() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (missing.length) console.error("❌ Faltando ENV:", missing.join(" / "));
  return missing.length === 0;
}

function hasHeaderTokens() {
  return Boolean(CW_ACCESS_TOKEN && CW_CLIENT && CW_UID);
}

function buildAuthHeaders() {
  if (hasHeaderTokens()) {
    return {
      "Content-Type": "application/json",
      "access-token": CW_ACCESS_TOKEN,
      client: CW_CLIENT,
      uid: CW_UID,
      "token-type": CW_TOKEN_TYPE,
    };
  }

  // fallback
  const headers = { "Content-Type": "application/json" };
  if (CHATWOOT_API_TOKEN) {
    headers["api_access_token"] = CHATWOOT_API_TOKEN;
    headers["Authorization"] = `Bearer ${CHATWOOT_API_TOKEN}`;
  }
  return headers;
}

async function chatwootFetch(path, { method = "GET", body } = {}) {
  const url = `${CHATWOOT_URL}${path}`;
  const headers = buildAuthHeaders();

  // log seguro (não imprime token completo)
  console.log("🔐 Auth mode:", hasHeaderTokens() ? "header-tokens" : "api_token");
  if (hasHeaderTokens()) {
    console.log("🔐 Using uid/client:", {
      uid: CW_UID,
      client: CW_CLIENT?.slice(0, 6) + "…",
      accessToken: CW_ACCESS_TOKEN?.slice(0, 6) + "…",
    });
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    throw {
      ok: false,
      status: res.status,
      url,
      body: json || text,
      message: `Chatwoot API ${res.status}`,
    };
  }

  return json || { ok: true };
}

async function sendMessageToConversation(conversationId, content) {
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    {
      method: "POST",
      body: { content, message_type: "outgoing" },
    }
  );
}

app.get("/", (req, res) => res.send("Bot online 🚀"));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    basicEnvOk: assertEnvBasic(),
    hasHeaderTokens: hasHeaderTokens(),
    accountId: CHATWOOT_ACCOUNT_ID,
    url: CHATWOOT_URL,
  });
});

app.get("/test-chatwoot", async (req, res) => {
  try {
    if (!assertEnvBasic()) return res.status(500).json({ ok: false, error: "Missing basic ENV" });
    const profile = await chatwootFetch("/api/v1/profile");
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(500).json(e);
  }
});

// Teste direto de envio: /test-send?conv=11419
app.get("/test-send", async (req, res) => {
  try {
    if (!assertEnvBasic()) return res.status(500).json({ ok: false, error: "Missing basic ENV" });
    const conv = req.query.conv;
    if (!conv) return res.status(400).json({ ok: false, error: "Informe ?conv=ID" });

    const sent = await sendMessageToConversation(conv, "✅ teste envio direto do bot (/test-send)");
    res.json({ ok: true, sent });
  } catch (e) {
    res.status(500).json(e);
  }
});

app.post("/chatwoot-webhook", async (req, res) => {
  res.status(200).send("ok");

  try {
    if (!assertEnvBasic()) return;

    console.log("📩 ACESSO DO WEBHOOK", new Date().toISOString());
    console.log("CORPO BRUTO:", JSON.stringify(req.body));

    const event = req.body?.event;
    console.log("event:", event);

    if (event !== "message_created") return;

    const conversationId =
      req.body?.conversation?.id ||
      req.body?.conversation_id ||
      req.body?.id;

    if (!conversationId) {
      console.log("Sem conversationId no payload");
      return;
    }

    // incoming pode vir como 0 ou "incoming"
    const mt = req.body?.message_type;
    const isIncoming = mt === 0 || mt === "incoming";
    if (!isIncoming) {
      console.log("Ignorando (não incoming). message_type:", mt);
      return;
    }

    // evita privadas
    if (req.body?.private === true) return;

    const content = (req.body?.content || "").trim();
    if (!content) return;

    const reply = "🤖 Olá! Sou o bot automático. Como posso ajudar?";
    const sent = await sendMessageToConversation(conversationId, reply);

    console.log("✅ Resposta enviada", { conversationId, sentId: sent?.id });
  } catch (e) {
    console.error("❌ Erro no webhook:", e);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Rodando na porta", port));
