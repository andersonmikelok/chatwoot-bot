import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ENV (Render)
const CHATWOOT_URL = process.env.CHATWOOT_URL;                 // ex: https://chat.smsnet.com.br
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;   // ex: 195
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;     // token do Perfil > Token de acesso

function requiredEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!CHATWOOT_API_TOKEN) missing.push("CHATWOOT_API_TOKEN");
  return missing;
}

app.get("/", (req, res) => res.status(200).send("Bot online 🚀"));

app.post("/chatwoot-webhook", async (req, res) => {
  try {
    const missing = requiredEnv();
    if (missing.length) {
      console.log("Faltando ENV:", missing.join(", "));
      return res.status(200).send("ok");
    }

    const event = req.body?.event;
    console.log("Webhook recebido:", event);

    if (event !== "message_created") {
      return res.status(200).send("ok");
    }

    // Evita loop: só responde quando a mensagem for do cliente (incoming)
    const messageType = req.body?.message_type; // "incoming" | "outgoing"
    if (messageType !== "incoming") {
      console.log("Ignorando message_type:", messageType);
      return res.status(200).send("ok");
    }

    // ⚠️ No webhook do Chatwoot, em message_created:
    // req.body.conversation?.id costuma ser o ID da conversa (o req.body.id pode ser o ID da mensagem)
    const conversationId = req.body?.conversation?.id;
    if (!conversationId) {
      console.log("Não achei conversation.id no payload. Keys:", Object.keys(req.body || {}));
      return res.status(200).send("ok");
    }

    const url = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        // ✅ evita problema de proxy removendo api_access_token
        "Authorization": `Bearer ${CHATWOOT_API_TOKEN}`,
      },
      body: JSON.stringify({
        content: "🤖 Olá! Sou o bot automático. Como posso ajudar?"
      }),
    });

    const text = await resp.text();
    if (!resp.ok) {
      console.log("Chatwoot API erro:", resp.status, text);
    } else {
      console.log("Mensagem enviada com sucesso:", text);
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.log("Erro no webhook:", err);
    return res.status(200).send("ok");
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Rodando na porta", process.env.PORT || 3000);
});
