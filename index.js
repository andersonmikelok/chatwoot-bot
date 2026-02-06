import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ENV obrigatórias
const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/$/, "");
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;

// Opcional
const BOT_NAME = process.env.BOT_NAME || "Bot IA";
const BOT_REPLY =
  process.env.BOT_REPLY || "🤖 Olá! Sou o bot automático. Como posso ajudar?";

// Validação simples de ENV
function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!CHATWOOT_API_TOKEN) missing.push("CHATWOOT_API_TOKEN");
  if (missing.length) {
    console.log("Faltando ENV:", missing.join(" / "));
    return false;
  }
  return true;
}

app.get("/", (req, res) => res.send("Bot online 🚀"));

/**
 * Teste rápido do token (abra no navegador):
 * https://SEU-SERVICO.onrender.com/test-chatwoot
 *
 * Se retornar 200, token/URL ok.
 * Se retornar 401, o Chatwoot não aceitou o token.
 */
app.get("/test-chatwoot", async (req, res) => {
  if (!assertEnv()) return res.status(500).json({ error: "ENV faltando" });

  // Endpoint leve para validar autenticação
  const url = `${CHATWOOT_URL}/api/v1/profile`;

  try {
    const r = await fetch(url, {
      method: "GET",
      headers: {
        api_access_token: CHATWOOT_API_TOKEN,
      },
    });

    const body = await r.text();
    return res.status(200).json({ status: r.status, body });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

async function sendMessageToConversation(conversationId, content) {
  const url = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      api_access_token: CHATWOOT_API_TOKEN,
    },
    body: JSON.stringify({
      content,
      message_type: "outgoing",
      private: false,
    }),
  });

  const text = await r.text();
  if (!r.ok) {
    console.log("Chatwoot API erro:", r.status, text);
    const err = new Error(`Chatwoot API ${r.status}`);
    err.status = r.status;
    err.body = text;
    throw err;
  }
  return text;
}

app.post("/chatwoot-webhook", async (req, res) => {
  // sempre responder rápido pro Chatwoot
  res.status(200).send("ok");

  try {
    if (!assertEnv()) return;

    const payload = req.body;
    const event = payload?.event;

    console.log("Webhook recebido:", event);

    // Queremos responder apenas quando for mensagem criada
    if (event !== "message_created") return;

    // Evita loop: ignora mensagens que o próprio bot/agente envia
    const messageType = payload?.message_type; // incoming/outgoing/template...
    if (messageType !== "incoming") {
      console.log("Ignorando message_type:", messageType);
      return;
    }

    // Pega conversation_id de forma robusta (depende do payload)
    const conversationId =
      payload?.conversation?.id ||
      payload?.conversation_id ||
      payload?.conversationId;

    if (!conversationId) {
      console.log("Não achei conversationId no payload.");
      return;
    }

    await sendMessageToConversation(conversationId, BOT_REPLY);
    console.log(`${BOT_NAME} respondeu na conversa`, conversationId);
  } catch (err) {
    console.log("Erro no webhook:", err?.status || "", err?.body || "", err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Rodando na porta", PORT));
