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

// ✅ Regras solicitadas
const AUTO_ENABLE_GPT = (process.env.AUTO_ENABLE_GPT || "true").toLowerCase() === "true";
const AUTO_ENABLE_MIN_CHARS = Number(process.env.AUTO_ENABLE_MIN_CHARS || 4); // evita "oi"
const AUTO_ENABLE_TRIES = Number(process.env.AUTO_ENABLE_TRIES || 3); // ✅ 3 tentativas fora do menu
const AUTO_ENABLE_NOTICE_TEXT =
  process.env.AUTO_ENABLE_NOTICE_TEXT || "Entendi. Vou te atender por aqui sem precisar do menu.";

// fallback local se custom_attributes não persistir no SMSNET
const localGptMode = new Map(); // conversationId -> boolean

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
  } catch {}

  if (!res.ok) {
    throw new Error(`Falha no /auth/sign_in (${res.status}): ${JSON.stringify(json || text)}`);
  }

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
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}

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

// ----------------------- GPT MODE via custom_attributes -----------------------
async function setGptMode(conversationId, enabled) {
  try {
    await chatwootFetch(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`, {
      method: "PATCH",
      body: {
        custom_attributes: {
          gpt_mode: !!enabled,
          // ✅ contador de fuga e se já mostramos o aviso
          gpt_escape_count: enabled ? 0 : undefined,
        },
      },
    });

    localGptMode.set(conversationId, !!enabled);
    return true;
  } catch {
    localGptMode.set(conversationId, !!enabled);
    return true;
  }
}

async function getGptFlags(conversationId) {
  // retorna { gpt_mode, gpt_escape_count, gpt_notice_sent }
  try {
    const convo = await getConversation(conversationId);
    const ca = convo?.custom_attributes || {};
    const flags = {
      gpt_mode: ca.gpt_mode === true,
      gpt_escape_count: Number(ca.gpt_escape_count || 0),
      gpt_notice_sent: ca.gpt_notice_sent === true,
    };
    localGptMode.set(conversationId, flags.gpt_mode);
    return flags;
  } catch {
    return {
      gpt_mode: localGptMode.get(conversationId) === true,
      gpt_escape_count: 0,
      gpt_notice_sent: false,
    };
  }
}

async function setCustomAttributes(conversationId, attrs) {
  // merge de atributos
  try {
    await chatwootFetch(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`, {
      method: "PATCH",
      body: { custom_attributes: attrs },
    });
    return true;
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
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {}

  if (!res.ok) {
    throw new Error(`OpenAI erro (${res.status}): ${JSON.stringify(json || raw)}`);
  }

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
  if (t.length < AUTO_ENABLE_MIN_CHARS) return false;     // evita "oi", "?"
  if (isMenuNumeric(t)) return false;                     // não é fuga
  // opcional: ignorar mensagens muito curtas tipo "ok"
  if (t.toLowerCase() === "ok" || t.toLowerCase() === "sim" || t.toLowerCase() === "não") return false;
  return true;
}

// ----------------------- Rotas -----------------------
app.get("/", (_req, res) => res.send("Bot online 🚀"));

app.post("/chatwoot-webhook", async (req, res) => {
  res.status(200).send("ok");

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

    // 1) comandos GPT
    const cmd = normalizeCommand(customerText);
    if (cmd === "#gpt on") {
      await setCustomAttributes(conversationId, {
        gpt_mode: true,
        gpt_escape_count: 0,
        gpt_notice_sent: true, // se ativou manualmente, não precisa avisar
      });
      await sendMessageToConversation(conversationId, "✅ GPT ativado nesta conversa.");
      return;
    }
    if (cmd === "#gpt off") {
      await setCustomAttributes(conversationId, {
        gpt_mode: false,
        gpt_escape_count: 0,
        gpt_notice_sent: false,
      });
      await sendMessageToConversation(conversationId, "🛑 GPT desativado nesta conversa.");
      return;
    }

    // 2) menu numérico -> não interfere
    if (isMenuNumeric(customerText)) {
      console.log("🔢 Menu numérico detectado. Ignorando.");
      return;
    }

    // 3) lê estado atual
    const flags = await getGptFlags(conversationId);

    // 4) Autoativação somente após 3 fugas
    let gptOn = flags.gpt_mode;

    if (!gptOn && AUTO_ENABLE_GPT && isEligibleForAutoEnable(customerText)) {
      const nextCount = (flags.gpt_escape_count || 0) + 1;

      // grava o contador
      await setCustomAttributes(conversationId, { gpt_escape_count: nextCount });

      console.log("🟡 fuga do menu:", { conversationId, nextCount });

      if (nextCount >= AUTO_ENABLE_TRIES) {
        // ativa
        await setCustomAttributes(conversationId, {
          gpt_mode: true,
          gpt_escape_count: 0,
        });
        gptOn = true;

        // ✅ aviso só 1 vez por conversa
        if (!flags.gpt_notice_sent && AUTO_ENABLE_NOTICE_TEXT) {
          await sendMessageToConversation(conversationId, AUTO_ENABLE_NOTICE_TEXT);
          await setCustomAttributes(conversationId, { gpt_notice_sent: true });
        }
      } else {
        // ainda não chegou em 3 fugas -> deixa SMSNET atuar
        return;
      }
    }

    // 5) Se GPT ainda OFF, não responde
    if (!gptOn) {
      console.log("🚫 GPT OFF (gpt_mode=false). Ignorando.");
      return;
    }

    // 6) GPT ON -> responde
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
