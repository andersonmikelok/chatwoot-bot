import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * ENV (Render):
 * CHATWOOT_URL=https://chat.smsnet.com.br
 * CHATWOOT_ACCOUNT_ID=195
 * CHATWOOT_API_TOKEN=xxxx
 */
const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;

// --- valida ENV logo no boot (evita rodar “meio quebrado”)
function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!CHATWOOT_API_TOKEN) missing.push("CHATWOOT_API_TOKEN");

  if (missing.length) {
    console.error("Faltando ENV:", missing.join(" / "));
    return false;
  }
  return true;
}

function buildAuthHeaders() {
  // Tenta os 2 padrões mais comuns (instalações variam)
  return {
    "Content-Type": "application/json",
    api_access_token: CHATWOOT_API_TOKEN,
    Authorization: `Bearer ${CHATWOOT_API_TOKEN}`,
  };
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
    // algumas instalações podem responder HTML; manteremos text
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
      body: { content },
    }
  );
}

// Endpoint de saúde
app.get("/", (req, res) => res.send("Bot online 🚀"));

// Teste manual: valida se o token autentica
app.get("/test-chatwoot", async (req, res) => {
  try {
    if (!assertEnv()) return res.status(500).json({ ok: false, error: "Missing ENV" });
    const profile = await chatwootFetch("/api/v1/profile");
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(500).json(e);
  }
});

// Webhook do Chatwoot
app.post("/chatwoot-webhook", async (req, res) => {
  try {
    if (!assertEnv()) return res.status(500).send("Missing ENV");

    const event = req.body?.event;
    console.log("Webhook recebido:", event);

    // Responde logo para o Chatwoot não reenviar por timeout
    res.status(200).send("ok");

    if (event !== "message_created") return;

    // Evita loop: não responder mensagens do próprio sistema/agente/bot
    const messageType = req.body?.message_type; // incoming / outgoing / template (varia)
    if (messageType && messageType !== "incoming") {
      console.log("Ignorando message_type:", messageType);
      return;
    }

    // CORRETO: conversationId vem dentro de conversation.id
    const conversationId = req.body?.conversation?.id;
    if (!conversationId) {
      console.log("Sem conversation.id no payload.");
      return;
    }

    // (Opcional) Evitar responder mensagens automáticas / privadas
    if (req.body?.private) return;

    await sendMessageToConversation(
      conversationId,
      "🤖 Olá! Sou o bot automático. Como posso ajudar?"
    );

    console.log("Mensagem enviada na conversa:", conversationId);
  } catch (e) {
    console.error("Erro no webhook:", e);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Rodando na porta", port));
