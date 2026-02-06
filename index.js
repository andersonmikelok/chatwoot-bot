import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ENV (Render)
const CHATWOOT_URL = process.env.CHATWOOT_URL?.replace(/\/$/, ""); // remove barra final
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;

function requireEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!CHATWOOT_API_TOKEN) missing.push("CHATWOOT_API_TOKEN");
  return missing;
}

async function chatwootFetch(path, { method = "GET", body } = {}) {
  const url = `${CHATWOOT_URL}${path}`;

  // Alguns setups aceitam api_access_token; outros aceitam Bearer.
  // Enviamos os dois para maximizar compatibilidade.
  const headers = {
    "Content-Type": "application/json",
    api_access_token: CHATWOOT_API_TOKEN,
    Authorization: `Bearer ${CHATWOOT_API_TOKEN}`,
  };

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!resp.ok) {
    const err = new Error(`Chatwoot API ${resp.status}`);
    err.status = resp.status;
    err.body = data;
    throw err;
  }

  return data;
}

async function sendMessageToConversation(conversationId, content) {
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    {
      method: "POST",
      body: {
        content,
        message_type: "outgoing",
        private: false,
      },
    }
  );
}

app.get("/", (req, res) => {
  res.send("Bot online 🚀");
});

// ROTA DE TESTE: valida se o token funciona mesmo
app.get("/test-chatwoot", async (req, res) => {
  const missing = requireEnv();
  if (missing.length) {
    return res.status(500).json({ ok: false, error: `Faltando ENV: ${missing.join(", ")}` });
  }

  try {
    const profile = await chatwootFetch("/api/v1/profile");
    return res.json({ ok: true, profile });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      status: e.status,
      body: e.body,
      message: e.message,
      tip:
        "Se continuar 401 aqui, o token não está sendo aceito pela API (token/tipo/URL/proxy).",
    });
  }
});

app.post("/chatwoot-webhook", async (req, res) => {
  const event = req.body?.event;
  console.log("Webhook recebido:", event);

  // sempre responde 200 rápido (evita retry)
  res.status(200).send("ok");

  const missing = requireEnv();
  if (missing.length) {
    console.log("Faltando ENV:", missing.join(", "));
    return;
  }

  try {
    if (event !== "message_created") return;

    // Evita loop: só responde quando for mensagem INCOMING do contato
    const messageType = req.body?.message_type; // "incoming" ou "outgoing"
    const senderType = req.body?.sender?.type;  // "contact", "user", "agent_bot", etc.

    if (messageType !== "incoming" || senderType !== "contact") {
      console.log("Ignorando message_type/sender:", { messageType, senderType });
      return;
    }

    // Conversation ID correto vem dentro de conversation.id (não é o req.body.id)
    const conversationId =
      req.body?.conversation?.id || req.body?.conversation_id;

    if (!conversationId) {
      console.log("Não achei conversationId no payload. Keys:", Object.keys(req.body || {}));
      return;
    }

    await sendMessageToConversation(
      conversationId,
      "🤖 Olá! Sou o bot automático. Como posso ajudar?"
    );

    console.log("Resposta enviada na conversa:", conversationId);
  } catch (e) {
    console.log("Erro no webhook:", e.status, e.body || e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Rodando na porta", PORT));
