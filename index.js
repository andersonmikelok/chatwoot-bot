import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ====== ENV (Render -> Environment Variables) ======
const CHATWOOT_URL = process.env.CHATWOOT_URL; // ex: https://chat.smsnet.com.br (sem / no final)
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID; // ex: 195
const API_TOKEN = process.env.CHATWOOT_API_TOKEN; // token do Chatwoot (novo)
const BOT_REPLY =
  process.env.BOT_REPLY || "🤖 Olá! Sou o bot automático. Como posso ajudar?";

// validação simples
if (!CHATWOOT_URL || !ACCOUNT_ID || !API_TOKEN) {
  console.error(
    "Faltando ENV: CHATWOOT_URL / CHATWOOT_ACCOUNT_ID / CHATWOOT_API_TOKEN"
  );
}

// ====== Rotas básicas ======
app.get("/", (req, res) => res.send("Bot online 🚀"));
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// helper: remove barra final
const baseUrl = (CHATWOOT_URL || "").replace(/\/+$/, "");

// helper: chamar API do Chatwoot
async function chatwootRequest(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = {
    "Content-Type": "application/json",
    api_access_token: API_TOKEN, // header correto do Chatwoot
    ...(options.headers || {})
  };

  const res = await fetch(url, { ...options, headers });
  const text = await res.text();

  // tenta parsear JSON quando possível
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    console.error("Chatwoot API erro:", res.status, data);
    const err = new Error(`Chatwoot API ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

// ====== Webhook do Chatwoot ======
app.post("/chatwoot-webhook", async (req, res) => {
  try {
    const event = req.body?.event;
    console.log("Webhook recebido:", event);

    // você marcou message_created e conversation_created
    if (event !== "message_created") {
      return res.status(200).send("ok");
    }

    // Evitar loop: só responder mensagens INCOMING (do cliente)
    const messageType = req.body?.message_type; // "incoming" ou "outgoing"
    if (messageType !== "incoming") {
      return res.status(200).send("ok");
    }

    // Pegar conversationId corretamente
    const conversationId =
      req.body?.conversation?.id ?? req.body?.conversation_id;

    if (!conversationId) {
      console.error("Não achei conversationId no payload");
      return res.status(200).send("ok");
    }

    // Enviar mensagem para a conversa
    await chatwootRequest(
      `/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          content: BOT_REPLY
        })
      }
    );

    return res.status(200).send("ok");
  } catch (err) {
    // Mesmo dando erro, responda 200 para o Chatwoot não ficar re-tentando em loop
    console.error("Erro no webhook:", err?.status || "", err?.data || err);
    return res.status(200).send("ok");
  }
});

// Render injeta PORT automaticamente
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Rodando na porta ${PORT}`);
});
