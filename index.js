import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ENV (Render)
const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/$/, ""); // remove "/" final
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;

// Mensagem padrão (opcional)
const BOT_REPLY =
  process.env.BOT_REPLY || "🤖 Olá! Sou o bot automático. Como posso ajudar?";

function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!CHATWOOT_API_TOKEN) missing.push("CHATWOOT_API_TOKEN");

  if (missing.length) {
    console.error("Faltando ENV:", missing.join(" / "));
    return false;
  }

  console.log("ENV OK:", {
    CHATWOOT_URL,
    CHATWOOT_ACCOUNT_ID,
    TOKEN_LEN: CHATWOOT_API_TOKEN.length,
  });
  return true;
}

app.get("/", (req, res) => res.send("Bot online 🚀"));
app.get("/healthz", (req, res) => res.status(200).send("ok"));

app.post("/chatwoot-webhook", async (req, res) => {
  try {
    const event = req.body?.event;
    console.log("Webhook recebido:", event);

    // Sempre responde 200 rápido pro Chatwoot não re-tentar
    res.status(200).send("ok");

    if (!assertEnv()) return;

    if (event !== "message_created") return;

    // IMPORTANTE: evitar loop (responder apenas mensagens INCOMING)
    // No payload do Chatwoot normalmente vem message_type: "incoming"|"outgoing"
    const messageType = req.body?.message_type;
    if (messageType && messageType !== "incoming") {
      console.log("Ignorando message_type:", messageType);
      return;
    }

    // Pegar conversation_id de forma compatível com diferentes payloads
    const conversationId =
      req.body?.conversation?.id ||
      req.body?.conversation_id ||
      req.body?.conversationId;

    if (!conversationId) {
      console.log("Não achei conversationId no payload. Campos disponíveis:", Object.keys(req.body || {}));
      return;
    }

    const url = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // ESTE HEADER É O CORRETO NO CHATWOOT
        api_access_token: CHATWOOT_API_TOKEN,
      },
      body: JSON.stringify({ content: BOT_REPLY }),
    });

    const text = await r.text();

    if (!r.ok) {
      console.error("Chatwoot API erro:", r.status, text);
      return;
    }

    console.log("Resposta enviada com sucesso:", text);
  } catch (err) {
    console.error("Erro no webhook:", err?.message || err);
    // não faz res.send aqui porque já respondemos 200 acima
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Rodando na porta", PORT));
