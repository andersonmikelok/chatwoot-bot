import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const CHATWOOT_URL = process.env.CHATWOOT_URL;                 // https://chat.smsnet.com.br
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;   // 195
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;     // token do Perfil > Token de acesso

function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!CHATWOOT_API_TOKEN) missing.push("CHATWOOT_API_TOKEN");
  if (missing.length) throw new Error("Faltando ENV: " + missing.join(", "));
}

function buildHeaders() {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    // ✅ Forma oficial do Chatwoot (mas pode ser removida pelo proxy)
    "api_access_token": CHATWOOT_API_TOKEN,
    // ✅ Algumas instalações aceitam bearer
    "Authorization": `Bearer ${CHATWOOT_API_TOKEN}`,
  };
}

function withTokenInQuery(url) {
  const u = new URL(url);
  // ✅ Fallback que costuma passar por qualquer proxy
  u.searchParams.set("api_access_token", CHATWOOT_API_TOKEN);
  return u.toString();
}

app.get("/", (req, res) => res.status(200).send("Bot online 🚀"));

// ✅ Teste rápido de autenticação
app.get("/test-chatwoot", async (req, res) => {
  try {
    assertEnv();
    const url = withTokenInQuery(`${CHATWOOT_URL}/api/v1/profile`);
    const resp = await fetch(url, { headers: buildHeaders() });
    const text = await resp.text();
    return res.status(200).json({ status: resp.status, body: text });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.post("/chatwoot-webhook", async (req, res) => {
  try {
    assertEnv();

    const event = req.body?.event;
    console.log("Webhook recebido:", event);

    if (event !== "message_created") return res.status(200).send("ok");

    // evita loop: só responde mensagem do cliente
    const messageType = req.body?.message_type; // incoming | outgoing | template ...
    if (messageType !== "incoming") {
      console.log("Ignorando message_type:", messageType);
      return res.status(200).send("ok");
    }

    // no Chatwoot, esse costuma ser o ID da conversa
    const conversationId = req.body?.conversation?.id;
    if (!conversationId) {
      console.log("Sem conversation.id no payload");
      return res.status(200).send("ok");
    }

    const base = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;
    const url = withTokenInQuery(base);

    const resp = await fetch(url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({
        content: "🤖 Olá! Sou o bot automático. Como posso ajudar?",
      }),
    });

    const text = await resp.text();
    if (!resp.ok) {
      console.log("Chatwoot API erro:", resp.status, text);
    } else {
      console.log("Mensagem enviada OK:", text);
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
