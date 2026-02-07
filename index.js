import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;

const CW_UID = process.env.CW_UID;
const CW_PASSWORD = process.env.CW_PASSWORD;

let CW_ACCESS_TOKEN = process.env.CW_ACCESS_TOKEN || "";
let CW_CLIENT = process.env.CW_CLIENT || "";
let CW_TOKEN_TYPE = process.env.CW_TOKEN_TYPE || "Bearer";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Regras
const AUTO_ENABLE_GPT = (process.env.AUTO_ENABLE_GPT || "true").toLowerCase() === "true";
const AUTO_ENABLE_TRIES = Number(process.env.AUTO_ENABLE_TRIES || 3);
const AUTO_ENABLE_MIN_CHARS = Number(process.env.AUTO_ENABLE_MIN_CHARS || 4);
const AUTO_ENABLE_NOTICE_TEXT =
  process.env.AUTO_ENABLE_NOTICE_TEXT || "Entendi. Vou te atender por aqui sem precisar do menu.";

// ✅ Contadores locais (não dependem do SMSNET persistir custom_attributes)
const escapeCountMap = new Map(); // conversationId -> number
const noticeSentMap = new Map(); // conversationId -> boolean

// Limpeza para não crescer infinito
function cleanupMemory() {
  // simples: como Map não tem TTL por padrão, mantemos só os últimos N pelo tamanho
  const MAX = 2000;
  if (escapeCountMap.size > MAX) escapeCountMap.clear();
  if (noticeSentMap.size > MAX) noticeSentMap.clear();
}

function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");

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
  if (!CW_UID || !CW_PASSWORD) throw new Error("Sem CW_UID/CW_PASSWORD para renovar tokens.");

  const url = `${CHATWOOT_URL}/auth/sign_in`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: CW_UID, password: CW_PASSWORD }),
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) throw new Error(`Falha no /auth/sign_in (${res.status}): ${JSON.stringify(json || text)}`);

  const accessToken = res.headers.get("access-token") || "";
  const client = res.headers.get("client") || "";
  const tokenType = res.headers.get("token-type") || "Bearer";

  if (!accessToken || !client) throw new Error("Sign-in OK, mas não retornou access-token/client.");

  CW_ACCESS_TOKEN = accessToken;
  CW_CLIENT = client;
  CW_TOKEN_TYPE = tokenType;

  console.log("🔄 Tokens renovados via sign_in:", {
    uid: CW_UID,
    client: CW_CLIENT.slice(0, 6) + "…",
    access: CW_ACCESS_TOKEN.slice(0, 6) + "…",
  });
}

function buildChatwootHeaders() {
  return {
    "Content-Type": "application/json",
    "access-token": CW_ACCESS_TOKEN,
    client: CW_CLIENT,
    uid: CW_UID || "",
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
    try { json = text ? JSON.parse(text) : null; } catch {}

    return { res, text, json };
  };

  let { res, text, json } = await doRequest();

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
    { method: "POST", body: { content, message_type: "outgoing" } }
  );
}

async function getConversation(conversationId) {
  return chatwootFetch(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`, {
    method: "GET",
  });
}

// ----------------------- GPT MODE via custom_attributes (só ON/OFF) -----------------------
async function setGptMode(conversationId, enabled) {
  try {
    await chatwootFetch(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`, {
      method: "PATCH",
      body: { custom_attributes: { gpt_mode: !!enabled } },
    });
    return true;
  } catch (e) {
    console.log("⚠️ Falhou setar gpt_mode via custom_attributes:", String(e?.message || e));
    return false;
  }
}

async function getGptMode(conversationId) {
  try {
    const convo = await getConversation(conversationId);
    return convo?.custom_attributes?.gpt_mode === true;
  } catch {
    return false;
  }
}

// ----------------------- OpenAI -----------------------
function extractResponsesText(json) {
  if (typeof json?.output_text === "string" && json.output_text.trim()) return json.output_text.trim();

  const out = json?.output;
  if (Array.isArray(out)) {
    const parts = [];
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === "string" && c.text.trim()) parts.push(c.text.trim());
        }
      }
    }
    if (parts.length) return parts.join("\n").trim();
  }

  const legacy = json?.choices?.[0]?.message?.content;
  if (typeof legacy === "string" && legacy.trim()) return legacy.trim();

  return "";
}

async function openaiReply({ customerText, context }) {
  const system = `
Você é a atendente virtual da i9NET (provedor de internet).
Regras:
- PT-BR, curto e objetivo.
- BOLETO/2ª via: peça CPF/CNPJ ou nº do contrato + nome do titular.
- INTERNET lenta/sem sinal: reiniciar ONU/roteador 2 min, verificar luzes (PON/LOS), testar via cabo.
- "falar com atendente": confirme e diga que vai encaminhar.
- Não use menu numérico.
`.trim();

  const input = [
    { role: "system", content: system },
    { role: "user", content: `Mensagem do cliente: "${customerText}"\nContexto: ${context}` },
  ];

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, input, max_output_tokens: 220 }),
  });

  const raw = await res.text();
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch {}

  if (!res.ok) throw new Error(`OpenAI erro (${res.status}): ${JSON.stringify(json || raw)}`);

  const out = extractResponsesText(json);
  return (out || "Você precisa de boleto, suporte técnico ou falar com atendente?").trim();
}

// ----------------------- Helpers -----------------------
function isIncoming(messageType) {
  return (
    messageType === "incoming" ||
    messageType === "recebida" ||
    messageType === 0 ||
    messageType === "0"
  );
}

function isMenuNumeric(text) {
  return /^\d{1,2}$/.test(text.trim());
}

function normalizeCommand(text) {
  const t = text.trim().toLowerCase();
  if (t === "#gpt on" || t === "#gpt ligar" || t === "#gpt ligado" || t === "#gpt ativar") return "#gpt on";
  if (t === "#gpt off" || t === "#gpt desligar" || t === "#gpt desativar") return "#gpt off";
  return "";
}

function isEligibleForAutoEnable(text) {
  const t = text.trim();
  if (t.length < AUTO_ENABLE_MIN_CHARS) return false;
  if (isMenuNumeric(t)) return false;
  const low = t.toLowerCase();
  if (low === "oi" || low === "olá" || low === "ola" || low === "ok" || low === "sim" || low === "não" || low === "?")
    return false;
  return true;
}

// ----------------------- Rotas -----------------------
app.get("/", (_req, res) => res.send("Bot online 🚀"));

app.post("/chatwoot-webhook", async (req, res) => {
  res.status(200).send("ok");
  cleanupMemory();

  try {
    if (!assertEnv()) return;

    const event = req.body?.event;
    if (event !== "message_created") return;

    const messageType = req.body?.message_type;
    if (!isIncoming(messageType)) return;
    if (req.body?.private) return;

    const conversationId = req.body?.conversation?.id;
    const customerText = (req.body?.content || "").trim();
    if (!conversationId || !customerText) return;

    console.log("📩 PROCESSANDO:", { conversationId, customerText });

    // comandos
    const cmd = normalizeCommand(customerText);
    if (cmd === "#gpt on") {
      await setGptMode(conversationId, true);
      escapeCountMap.set(conversationId, 0);
      noticeSentMap.set(conversationId, true);
      await sendMessageToConversation(conversationId, "✅ GPT ativado nesta conversa.");
      return;
    }
    if (cmd === "#gpt off") {
      await setGptMode(conversationId, false);
      escapeCountMap.set(conversationId, 0);
      noticeSentMap.set(conversationId, false);
      await sendMessageToConversation(conversationId, "🛑 GPT desativado nesta conversa.");
      return;
    }

    // menu numérico -> ignora
    if (isMenuNumeric(customerText)) {
      console.log("🔢 Menu numérico detectado. Ignorando.");
      return;
    }

    // estado atual
    let gptOn = await getGptMode(conversationId);

    // autoativação após 3 fugas (contador local)
    if (!gptOn && AUTO_ENABLE_GPT && isEligibleForAutoEnable(customerText)) {
      const current = escapeCountMap.get(conversationId) || 0;
      const nextCount = current + 1;
      escapeCountMap.set(conversationId, nextCount);

      console.log("🟡 fuga do menu:", { conversationId, nextCount });

      if (nextCount >= AUTO_ENABLE_TRIES) {
        await setGptMode(conversationId, true);
        gptOn = true;
        escapeCountMap.set(conversationId, 0);

        // aviso só 1 vez
        if (!noticeSentMap.get(conversationId)) {
          await sendMessageToConversation(conversationId, AUTO_ENABLE_NOTICE_TEXT);
          noticeSentMap.set(conversationId, true);
        }
      } else {
        // ainda não chegou nas 3 fugas -> deixa SMSNET
        return;
      }
    }

    if (!gptOn) {
      console.log("🚫 GPT DESLIGADO (gpt_mode=false). Ignorando.");
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
app.listen(port, () => console.log("Rodando na porta", port));
