import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Lê do Render Environment Variables
const CHATWOOT_URL = process.env.CHATWOOT_URL; // https://chat.smsnet.com.br
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID; // ex: 195
const API_TOKEN = process.env.CHATWOOT_API_TOKEN; // seu token

app.get("/", (req, res) => res.status(200).send("OK - bot online 🚀"));

app.post("/chatwoot-webhook", async (req, res) => {
  try {
    const event = req.body?.event;
    if (event !== "message_created") {
      return res.status(200).json({ ok: true, ignored: "not message_created" });
    }

    // Anti-loop: só responde quando é mensagem do CLIENTE
    const messageType = req.body?.message_type; // incoming | outgoing
    if (messageType !== "incoming") {
      return res.status(200).json({ ok: true, ignored: "not incoming" });
    }

    const conversationId = req.body?.conversation?.id;
    if (!conversationId) {
      console.log("Payload sem conversation.id:", JSON.stringify(req.body, null, 2));
      return res.status(200).json({ ok: true, ignored: "no conversation id" });
    }

    if (!CHATWOOT_URL || !ACCOUNT_ID || !API_TOKEN) {
      console.log("Faltando ENV: CHATWOOT_URL / CHATWOOT_ACCOUNT_ID / CHATWOOT_API_TOKEN");
      return res.status(200).json({ ok: true, ignored: "missing env" });
    }

    const api = `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/messages`;

    const resp = await fetch(api, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        api_access_token: API_TOKEN,
      },
      body: JSON.stringify({
        content: "🤖 Olá! Sou o bot automático. Me diga: 1) 2ª via  2) Financeiro  3) Suporte  4) Mudança de plano",
      }),
    });

    const bodyText = await resp.text();
    console.log("Resposta Chatwoot:", resp.status, bodyText);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Erro no webhook:", err);
    return res.status(200).json({ ok: true, error: "handled" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
