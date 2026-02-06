import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Render ENV VARS (obrigatório)
const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;

// Validação de ENV
function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!CHATWOOT_API_TOKEN) missing.push("CHATWOOT_API_TOKEN");
  if (missing.length) {
    throw new Error(`Faltando ENV: ${missing.join(" / ")}`);
  }
}

// Helper: chamada à API do Chatwoot
async function chatwootRequest(path, { method = "GET", body } = {}) {
  assertEnv();

  const url = `${CHATWOOT_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      // Header correto do Chatwoot
      api_access_token: CHATWOOT_API_TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`Chatwoot API ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return data;
}

app.get("/", (req, res) => {
  res.send("Bot online 🚀");
});

// Rota de teste: valida se URL + token estão aceitos
app.get("/test-chatwoot", async (req, res) => {
  try {
    const me = await chatwootRequest(`/api/v1/profile`, { method: "GET" });
    res.json({ ok: true, profile: me });
  } catch (e) {
    res.status(500).json({ ok: false, status: e.status, body: e.body, message: e.message });
  }
});

app.post("/chatwoot-webhook", async (req, res) => {
  try {
    const event = req.body?.event;
    console.log("Webhook recebido:", event);

    // Responde rápido pro Chatwoot não re-tentar
    res.status(200).send("ok");

    if (event !== "message_created") return;

    // Ignora mensagens "outgoing" (geradas por agente/bot) pra não entrar em loop
    const messageType = req.body?.message_type; // incoming / outgoing / template etc
    if (messageType !== "incoming") {
      console.log("Ignorando message_type:", messageType);
      return;
    }

    // ID correto da conversa (não use req.body.id aqui)
    const conversationId =
      req.body?.conversation?.id ||
      req.body?.conversation_id;

    if (!conversationId) {
      console.log("Webhook sem conversationId. Payload keys:", Object.keys(req.body || {}));
      return;
    }

    // Exemplo de resposta automática
    await chatwootRequest(
      `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        body: {
          content: "🤖 Olá! Sou o bot automático. Como posso ajudar?",
        },
      }
    );

    console.log("Mensagem enviada para conversa:", conversationId);
  } catch (e) {
    console.log("Erro no webhook:", e.status, e.body || e.message);
  }
});

// Render usa PORT; local pode usar 3000
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Rodando na porta", port));
