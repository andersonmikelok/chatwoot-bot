import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * ENV (Render)
 * CHATWOOT_URL=https://chat.smsnet.com.br
 * CHATWOOT_ACCOUNT_ID=195
 *
 * Auth por sessão (funcionou no seu caso):
 * CW_UID=anderson_mikel@hotmail.com
 * CW_PASSWORD=*****
 *
 * OpenAI:
 * OPENAI_API_KEY=sk-...
 * OPENAI_MODEL=gpt-4o-mini   (ou o modelo que você usa)
 *
 * Controle:
 * GPT_LABEL=gpt_on
 * IGNORE_MENU_NUMBERS=true
 */

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;

const CW_UID = process.env.CW_UID;
const CW_PASSWORD = process.env.CW_PASSWORD;

let CW_ACCESS_TOKEN = process.env.CW_ACCESS_TOKEN || "";
let CW_CLIENT = process.env.CW_CLIENT || "";
let CW_TOKEN_TYPE = process.env.CW_TOKEN_TYPE || "Bearer";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const GPT_LABEL = process.env.GPT_LABEL || "gpt_on";
const IGNORE_MENU_NUMBERS = (process.env.IGNORE_MENU_NUMBERS || "true").toLowerCase() === "true";

function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");

  // Se não tiver token, precisa ter UID/PASSWORD pra renovar.
  if (!CW_ACCESS_TOKEN || !CW_CLIENT) {
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
    throw new Error(`Falha no /auth/sign_in (${res.status}): ${JSON.stringify(json || text)}`);
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
    "client": CW_CLIENT,
    "uid": CW_UID || "",
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
    throw new Error(`Chatwoot API ${res.status} (${url}): ${JSON.stringify(json || text)}`);
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

async function getConversation(conversationId) {
  return chatwootFetch(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`, {
    method: "GET",
  });
}

// Tenta adicionar/remover label com endpoints comuns; fallback: PATCH labels
async function setConversationLabels(conversationId, labels) {
  // fallback genérico: PATCH conversation com labels
  return chatwootFetch(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`, {
    method: "PATCH",
    body: { labels },
  });
}

async function enableGptOnConversation(conversationId, enabled) {
  const convo = await getConversation(conversationId);
  const current = Array.isArray(convo?.labels) ? convo.labels : [];
  const s = new Set(current);
  if (enabled) s.add(GPT_LABEL);
  else s.delete(GPT_LABEL);
  await setConversationLabels(conversationId, Array.from(s));
  return Array.from(s);
}

// ----------------------- OpenAI -----------------------
async function openaiReply({ customerText, context }) {
  const system = `
Você é a atendente virtual da i9NET (provedor de internet).
Objetivo: entender mensagens livres (fora do menu) e ajudar rápido.

Regras:
- Responda em PT-BR, curto e objetivo.
- Se o cliente pedir BOLETO / 2ª via / fatura: peça CPF/CNPJ ou número do contrato.
- Se reclamar de internet lenta/sem sinal: faça 3 passos básicos (desligar ONU/roteador 2 min, ligar, testar cabo/wifi) e faça 1 pergunta de triagem.
- Se pedir "falar com atendente": confirme e diga que vai encaminhar.
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
      max_output_tokens: 220,
    }),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    throw new Error(`OpenAI API error (${res.status}): ${JSON.stringify(json || text)}`);
  }

  const out =
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    json?.choices?.[0]?.message?.content ||
    null;

  return (out || "Certo! Pode me explicar um pouco melhor o que você precisa?").trim();
}

// ----------------------- Rotas -----------------------
app.get("/", (_req, res) => res.send("Bot online 🚀"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

app.get("/test-chatwoot", async (_req, res) => {
  try {
    if (!assertEnv()) return res.status(500).json({ ok: false, error: "Missing ENV" });
    const profile = await chatwootFetch("/api/v1/profile");
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/chatwoot-webhook", async (req, res) => {
  // ACK rápido pro Chatwoot não reenviar
  res.status(200).send("ok");

  // ✅ LOG para confirmar que o webhook está chegando no Render
  console.log("🔥 WEBHOOK CHEGOU:", new Date().toISOString(), {
    event: req.body?.event,
    message_type: req.body?.message_type,
    conversationId: req.body?.conversation?.id,
    content_preview: (req.body?.content || "").slice(0, 80),
  });

  try {
    if (!assertEnv()) return;

    const event = req.body?.event;
    if (event !== "message_created") return;

    const messageType = req.body?.message_type; // "incoming"/"outgoing" ou 0/1
    const isIncoming = messageType === "incoming" || messageType === 0 || messageType === "0";

    // anti-loop
    if (!isIncoming) return;

    const conversationId = req.body?.conversation?.id;
    const customerText = (req.body?.content || "").trim();

    if (!conversationId || !customerText) return;
    if (req.body?.private) return;

    // Não brigar com menu numérico do SMSNET (1,2,3...)
    if (IGNORE_MENU_NUMBERS && /^\d{1,2}$/.test(customerText)) {
      console.log("🔢 Menu numérico detectado. Ignorando.", { conversationId, customerText });
      return;
    }

    console.log("📩 PROCESSANDO:", {
      conversationId,
      customerText,
    });

    // ✅ comandos para ligar/desligar GPT sem precisar clicar no painel
    const lower = customerText.toLowerCase();
    if (lower === "#gpt on" || lower === "#gpt off") {
      const enabled = lower.endsWith("on");
      const labels = await enableGptOnConversation(conversationId, enabled);

      await sendMessageToConversation(
        conversationId,
        enabled
          ? `✅ GPT ativado nesta conversa. (label: ${GPT_LABEL})`
          : `🛑 GPT desativado nesta conversa. (label removida: ${GPT_LABEL})`
      );

      console.log("🟣 GPT toggle via comando:", { conversationId, enabled, labels });
      return;
    }

    // ✅ TRAVA PRINCIPAL: só responde se tiver label gpt_on
    const convo = await getConversation(conversationId);
    const labels = Array.isArray(convo?.labels) ? convo.labels : [];
    const gptEnabled = labels.includes(GPT_LABEL);

    if (!gptEnabled) {
      console.log("🚫 GPT OFF (sem label). Ignorando.", { conversationId, labels });
      return;
    }

    const context = `can_reply=${req.body?.conversation?.can_reply}; inbox=${req.body?.inbox?.name || ""}`;

    const reply = await openaiReply({ customerText, context });

    await sendMessageToConversation(conversationId, reply);

    console.log("✅ Resposta enviada", { conversationId });
  } catch (e) {
    console.error("❌ Erro no webhook:", String(e?.message || e));
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Bot escutando na porta", port));
