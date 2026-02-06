import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// CONFIG — coloque seus dados aqui depois
const CHATWOOT_URL = "https://chat.smsnet.com.br";
const ACCOUNT_ID = "SEU_ACCOUNT_ID";
const API_TOKEN = "SEU_TOKEN";

app.get("/", (req, res) => {
  res.send("Bot online 🚀");
});

app.post("/chatwoot-webhook", async (req, res) => {
  console.log("Webhook recebido:", req.body.event);

  if (req.body.event === "message_created") {
    const conversationId = req.body.id;

    await fetch(
      `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          api_access_token: API_TOKEN
        },
        body: JSON.stringify({
          content: "🤖 Olá! Sou o bot automático. Como posso ajudar?"
        })
      }
    );
  }

  res.status(200).send("ok");
});

app.listen(process.env.PORT || 3000);

