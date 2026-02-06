import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * ENV (Render)
 * CHATWOOT_URL=https://chat.smsnet.com.br
 * CHATWOOT_ACCOUNT_ID=195
 *
 * // Auth por sessão (recomendado no seu caso, pois funcionou):
 * CW_UID=anderson_mikel@hotmail.com
 * CW_PASSWORD=*****
 * CW_ACCESS_TOKEN=...
 * CW_CLIENT=...
 * CW_TOKEN_TYPE=Bearer
 *
 * // OpenAI:
 * OPENAI_API_KEY=sk-...
 * OPENAI_MODEL=gpt-5.2   (opcional; pode usar gpt-5 mini pra economizar)
 */

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;

const CW_UID = process.env.CW_UID;
const CW_PASSWORD = process.env.CW_PASSWORD;

let CW_ACCESS_TOKEN = process.env.CW_ACCESS_TOKEN || "";
let CW_CLIENT = process.env.CW_CLIENT || "";
let CW_TOKEN_TYPE = process.env.CW_TOKEN_TYPE || "Bearer";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");

  if (!CW_ACCESS_TOKEN || !CW_CLIENT) {
    // ok se tiver uid/password para renovar automaticamente
    if (!CW_UID) missing.push("CW_UID (ou CW_ACCESS_TOKEN/CW_CLIENT)");
    if (!CW_PASSWORD) missing.push("CW_PASSWORD (ou CW_ACCESS_TOKEN/CW_CLIENT)");
  }

  if (missing.length) {
    console.error("Faltando ENV:", missing.join(" / "));
    return false;
  }
  return true;
}

// ----------------------- Chatwoot auth -----------------------
async function chatwootSignIn() {
  if (!CW_UID || !CW_PASSWORD) {
    throw new Error("Sem CW_UID/CW_PASSWORD para renovar tokens.");
  }

  const url = `${CHATWOOT_URL}/auth/sign_in`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: CW_UID, password: CW_PASSWORD }),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!res.ok) {
    throw {
      ok: false,
      status: res.status,
      url,
      body: json || text,
      message: "Falha no /auth/sign_in",
    };
  }

  // Tokens vêm nos headers
  const accessToken = res.headers.get("access-token") || "";
  const client = res.headers.get("client") || "";
  const tokenType = res.headers.get("token-type") || "Bearer";

  if (!accessToken || !client) {
    throw new Error("Sign-in OK, mas não retornou access-token/client.");
  }

  CW_ACCESS_TOKEN = accessToken;
  CW_CLIENT = client;
  CW_TOKEN_TYPE = tokenType;

  console.log("🔄 Tokens renovados via sign_in:", {
    uid: CW_UID,
    client: CW_CLIENT.slice(0, 6) + "…",
    access: CW_ACCESS_TOKEN.slice(0, 6) + "…",
  });

  return true;
}

function buildChatwootHeaders() {
  return {
    "Content-Type": "application/json",
    "access-token": CW_ACCESS_TOKEN,
    client: CW_CLIENT,
    uid: CW_UID || "", // no seu caso existe
    "token-type": CW_TOKEN_TYPE || "Bearer",
  };
}

async function chatwootFetch(path, { method = "GET", body } = {}) {
  const url = `${CHATWOOT_URL}${path}`;

  const doRequest = async () => {
    const res = await fetch(url, {
      method,
      headers: buildChatwootHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // pode vir html/text
    }

    return { res, text, json };
  };

  let { res, text, json } = await doRequest();

  // Se token expirou/401, tenta renovar e repetir 1 vez
  if (res.status === 401) {
    console.log("⚠️ 401 no Chatwoot. Tentando renovar tokens...");
    await chatwootSignIn();
    ({ res, text, json } = await doRequest());
  }

  if (!res.ok) {
    throw {
      ok: false,
      status: res.status,
      url,
      body: json || text,
      message: `Chatwoot API ${res.status}`,
    };
  }

  return json || { ok: true };
}

async function sendMessageToConversation(conversationId, content) {
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    {
      method: "POST",
      body: { content, message_type: "outgoing" },
    }
  );
}

// ----------------------- OpenAI -----------------------
async function openaiReply({ customerText, context }) {
  // Instruções simples: classifica intenção e responde curto, útil, PT-BR.
  const system = `
Você é a atendente virtual da i9NET (provedor de internet).
Objetivo: entender mensagens livres (fora do menu) e ajudar rápido.

Regras:
- Responda em PT-BR, curto e objetivo.
- Se o cliente pedir BOLETO / 2ª via / fatura: peça CPF/CNPJ ou número do contrato e o melhor canal (WhatsApp).
- Se reclamar de internet lenta/sem sinal: faça 3 passos básicos (desligar ONU/roteador 2 min, ligar, testar cabo/wifi) e peça endereço/telefone.
- Se pedir "falar com atendente": confirme e diga que vai encaminhar.
- Se for algo fora do escopo: faça 1 pergunta de triagem.

Contexto técnico:
- O atendimento acontece via Chatwoot/WhatsApp.
- Evite mandar menu numérico; interprete a intenção.
`.trim();

  const input = [
    { role: "system", content: system },
    {
      role: "user",
      content: `Mensagem do cliente: "${customerText}"
Contexto: ${context}`,
    },
  ];

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      // mantém respostas curtas
      max_output_tokens: 220,
    }),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    throw {
      ok: false,
      status: res.status,
      body: json || text,
      message: "OpenAI API error",
    };
  }

  // Respostas API: pegar o texto final de forma tolerante
  const out =
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    json?.choices?.[0]?.message?.content ||
    null;

  return (out || "Certo! Pode me explicar um pouco melhor o que você precisa?").trim();
}

// ----------------------- Rotas -----------------------
app.get("/", (req, res) => res.send("Bot online 🚀"));

app.get("/test-chatwoot", async (req, res) => {
  try {
    if (!assertEnv()) return res.status(500).json({ ok: false, error: "Missing ENV" });
    const profile = await chatwootFetch("/api/v1/profile");
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(500).json(e);
  }
});

app.post("/chatwoot-webhook", async (req, res) => {
  // Responde rápido pro Chatwoot não reenviar
  res.status(200).send("ok");

  try {
    if (!assertEnv()) return;

    const event = req.body?.event;
    if (event !== "message_created") return;

    // O seu payload já vem bem completo:
    const messageType = req.body?.message_type; // pode vir "incoming"/"outgoing" ou 0/1
    const isIncoming =
      messageType === "incoming" || messageType === 0 || messageType === "0";

    // Evita loop: não responder outgoing (mensagens do próprio bot/agente)
    if (!isIncoming) {
      console.log("Ignorando (não entrante). message_type:", messageType);
      return;
    }

    const conversationId = req.body?.conversation?.id;
    const customerText = (req.body?.content || "").trim();

    if (!conversationId || !customerText) return;
    if (req.body?.private) return;

    console.log("📩 Webhook:", new Date().toISOString(), {
      conversationId,
      customerText,
    });

    const context = `can_reply=${req.body?.conversation?.can_reply}; inbox=${req.body?.inbox?.name || ""}`;

    const reply = await openaiReply({ customerText, context });

    await sendMessageToConversation(conversationId, reply);

    console.log("✅ Resposta enviada", { conversationId });
  } catch (e) {
    console.error("❌ Erro no webhook:", e);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Rodando na porta", port));
