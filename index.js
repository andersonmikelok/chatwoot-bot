import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" })); // aumenta por segurança

/**
 * ENV (Render)
 * CHATWOOT_URL=https://chat.smsnet.com.br
 * CHATWOOT_ACCOUNT_ID=195
 * CW_UID=seuemail
 * CW_PASSWORD=suasenha
 * OPENAI_API_KEY=sk-...
 * OPENAI_MODEL=gpt-5.2 (opcional)
 *
 * ReceitaNet:
 * RECEITANET_BASE_URL=https://sistema.receitanet.net/api/novo/chatbot
 * RECEITANET_CHATBOT_TOKEN=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
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

const RECEITANET_BASE_URL =
  (process.env.RECEITANET_BASE_URL || "https://sistema.receitanet.net/api/novo/chatbot").replace(/\/+$/, "");
const RECEITANET_CHATBOT_TOKEN = process.env.RECEITANET_CHATBOT_TOKEN || "";

// ----------------------- FLAGS / LABELS -----------------------
const LABEL_GPT_ON = "gpt_on";
const LABEL_GPT_WELCOME_SENT = "gpt_welcome_sent";

const LABEL_RN_PHONE_CHECKED = "rn_phone_checked";
const LABEL_RN_CLIENT_KNOWN = "rn_client_known";
const LABEL_RN_NEED_CLIENT_STATUS = "rn_need_client_status";
const LABEL_RN_ASKED_CLIENT_STATUS = "rn_asked_client_status";
const LABEL_RN_NEED_CPF = "rn_need_cpf";
const LABEL_RN_ASKED_CPF = "rn_asked_cpf";
const LABEL_RN_SALES_MODE = "rn_sales_mode";

const seenMsgIds = new Set();
const recentSent = new Map();

const fugaCount = new Map();
const FUGA_LIMIT = 3;

// ----------------------- Helpers -----------------------
function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!RECEITANET_CHATBOT_TOKEN) missing.push("RECEITANET_CHATBOT_TOKEN");

  if (!CW_ACCESS_TOKEN || !CW_CLIENT) {
    if (!CW_UID) missing.push("CW_UID (ou CW_ACCESS_TOKEN/CW_CLIENT)");
    if (!CW_PASSWORD) missing.push("CW_PASSWORD (ou CW_ACCESS_TOKEN/CW_CLIENT)");
  }

  if (missing.length) {
    console.error("❌ Faltando ENV:", missing.join(" / "));
    return false;
  }
  return true;
}

function normalizeText(s) {
  return (s || "").toString().trim();
}
function onlyDigits(s) {
  return (s || "").replace(/\D+/g, "");
}

function isYes(text) {
  const t = normalizeText(text).toLowerCase();
  return ["sim", "s", "claro", "isso", "sou"].includes(t);
}
function isNo(text) {
  const t = normalizeText(text).toLowerCase();
  return ["nao", "não", "n", "negativo"].includes(t);
}

function isMenuInput(text) {
  const t = normalizeText(text);
  return ["1", "2", "3"].includes(t);
}

function throttleSend(conversationId, text, ms = 8000) {
  const now = Date.now();
  const prev = recentSent.get(conversationId);
  if (prev && prev.text === text && now - prev.ts < ms) return true;
  recentSent.set(conversationId, { text, ts: now });
  return false;
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
    throw {
      ok: false,
      status: res.status,
      url,
      body: json || text,
      message: "Falha no /auth/sign_in",
    };
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

  return true;
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
  if (throttleSend(conversationId, content, 8000)) return;
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    { method: "POST", body: { content, message_type: "outgoing" } }
  );
}

async function getConversation(conversationId) {
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`,
    { method: "GET" }
  );
}

async function addConversationLabels(conversationId, labelsToAdd = []) {
  const uniq = [...new Set(labelsToAdd.filter(Boolean))];
  if (!uniq.length) return;

  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/labels`,
    { method: "POST", body: { labels: uniq } }
  );
}

async function removeConversationLabels(conversationId, labelsToRemove = []) {
  const uniq = [...new Set(labelsToRemove.filter(Boolean))];
  if (!uniq.length) return;

  for (const lb of uniq) {
    try {
      await chatwootFetch(
        `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/labels/${encodeURIComponent(lb)}`,
        { method: "DELETE" }
      );
    } catch {}
  }
}

// ----------------------- ReceitaNet -----------------------
async function receitanetClientesLookup({ phone, cpfcnpj, idCliente } = {}) {
  const url = `${RECEITANET_BASE_URL}/clientes`;

  const form = new FormData();
  form.append("token", RECEITANET_CHATBOT_TOKEN);
  form.append("app", "chatbot");
  if (phone) form.append("phone", phone);
  if (cpfcnpj) form.append("cpfcnpj", cpfcnpj);
  if (idCliente) form.append("idCliente", String(idCliente));

  const res = await fetch(url, { method: "POST", body: form });
  const text = await res.text();

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) return { ok: false, status: res.status, body: json || text };
  return { ok: true, status: res.status, body: json };
}

function extractPhoneFromPayload(payload) {
  const senderPhone =
    payload?.sender?.phone_number ||
    payload?.sender?.phone ||
    payload?.message?.sender?.phone_number ||
    payload?.conversation?.meta?.sender?.phone_number ||
    payload?.conversation?.meta?.sender?.phone ||
    null;

  const digits = onlyDigits(senderPhone);
  if (!digits) return null;
  if (digits.startsWith("55") && digits.length >= 12) return digits.slice(2);
  return digits;
}

// ----------------------- OpenAI -----------------------
async function openaiReply({ customerText, mode }) {
  const system = `
Você é a atendente virtual da i9NET (provedor de internet).
Modo atual: ${mode}

Regras:
- PT-BR, curto e objetivo.
- Não mande menu numérico.
- Se pedir boleto: peça CPF/CNPJ (somente números).
- Se pedir suporte: checklist rápido e peça endereço/telefone.
- Se vendas: apresente e chame para fechar.
`.trim();

  const input = [
    { role: "system", content: system },
    { role: "user", content: customerText },
  ];

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: OPENAI_MODEL, input, max_output_tokens: 220 }),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) throw { ok: false, status: res.status, body: json || text };

  const out =
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    json?.choices?.[0]?.message?.content ||
    null;

  return (out || "Certo! Pode me explicar um pouco melhor o que você precisa?").trim();
}

// ----------------------- ROTAS -----------------------
app.get("/", (_req, res) => res.send("🚀 Bot online"));

app.post("/chatwoot-webhook", async (req, res) => {
  // ACK rápido
  res.status(200).send("ok");

  try {
    if (!assertEnv()) return;

    // ✅ DEBUG TEMP: só loga payload completo se tiver anexo
    const hasAttachments =
      (Array.isArray(req.body?.attachments) && req.body.attachments.length > 0) ||
      (Array.isArray(req.body?.message?.attachments) && req.body.message.attachments.length > 0);

    if (hasAttachments) {
      console.log("📎 WEBHOOK COM ANEXO (payload completo):");
      console.log(JSON.stringify(req.body, null, 2));
    }

    const event = req.body?.event;
    if (event !== "message_created") return;

    const messageType = req.body?.message_type;
    const isIncoming =
      messageType === "incoming" || messageType === 0 || messageType === "0";
    if (!isIncoming) return;

    const conversationId = req.body?.conversation?.id;
    const messageId = req.body?.id || req.body?.message?.id;
    const customerText = normalizeText(req.body?.content);

    if (!conversationId || !customerText) return;
    if (req.body?.private) return;

    if (messageId) {
      const mid = String(messageId);
      if (seenMsgIds.has(mid)) return;
      seenMsgIds.add(mid);
      if (seenMsgIds.size > 5000) {
        const arr = [...seenMsgIds];
        for (let i = 0; i < 2500; i++) seenMsgIds.delete(arr[i]);
      }
    }

    console.log("📩 PROCESSANDO:", { conversaId: conversationId, customerText });

    const conv = await getConversation(conversationId);
    const labels = (conv?.labels || [])
      .map((x) => (typeof x === "string" ? x : x?.title))
      .filter(Boolean);
    const labelSet = new Set(labels);

    // 1) Autoativação após 3 fugas do menu
    const gptEnabled = labelSet.has(LABEL_GPT_ON);

    if (!gptEnabled) {
      if (isMenuInput(customerText)) {
        fugaCount.set(conversationId, 0);
        return;
      }

      const next = (fugaCount.get(conversationId) || 0) + 1;
      fugaCount.set(conversationId, next);
      console.log("🟡 fuga do menu:", { conversationId, nextCount: next });

      if (next < FUGA_LIMIT) return;

      await addConversationLabels(conversationId, [LABEL_GPT_ON]);

      if (!labelSet.has(LABEL_GPT_WELCOME_SENT)) {
        await addConversationLabels(conversationId, [LABEL_GPT_WELCOME_SENT]);
        await sendMessageToConversation(conversationId, "✅ Entendi. Vou te atender por aqui sem precisar do menu.");
      }
      return;
    }

    // 2) ReceitaNet: checa telefone 1 vez
    let phone = extractPhoneFromPayload(req.body);

    if (!labelSet.has(LABEL_RN_PHONE_CHECKED)) {
      await addConversationLabels(conversationId, [LABEL_RN_PHONE_CHECKED]);

      if (phone) {
        console.log("🔎 ReceitaNet lookup phone:", phone);
        const rn = await receitanetClientesLookup({ phone });

        if (rn.ok && rn.body?.success !== false) {
          await addConversationLabels(conversationId, [LABEL_RN_CLIENT_KNOWN]);
          await sendMessageToConversation(conversationId, "✅ Encontrei seu cadastro pelo WhatsApp. Como posso te ajudar? (boleto, suporte, planos)");
          return;
        }
      }

      // não achou telefone -> pergunta só 1x
      await addConversationLabels(conversationId, [LABEL_RN_NEED_CLIENT_STATUS, LABEL_RN_ASKED_CLIENT_STATUS]);
      await sendMessageToConversation(conversationId, "Você já é cliente i9NET? (Responda: SIM ou NÃO)");
      return;
    }

    // 3) Se aguardando SIM/NÃO
    if (labelSet.has(LABEL_RN_NEED_CLIENT_STATUS)) {
      if (isYes(customerText)) {
        await removeConversationLabels(conversationId, [LABEL_RN_NEED_CLIENT_STATUS]);
        await addConversationLabels(conversationId, [LABEL_RN_NEED_CPF, LABEL_RN_ASKED_CPF]);
        await sendMessageToConversation(conversationId, "Para eu localizar seu cadastro, me envie seu CPF/CNPJ (somente números), por favor.");
        return;
      }
      if (isNo(customerText)) {
        await removeConversationLabels(conversationId, [LABEL_RN_NEED_CLIENT_STATUS]);
        await addConversationLabels(conversationId, [LABEL_RN_SALES_MODE]);
        // cai pro GPT vendas
      } else {
        await sendMessageToConversation(conversationId, "Só para confirmar: responda SIM ou NÃO 🙂");
        return;
      }
    }

    // 4) Se aguardando CPF
    if (labelSet.has(LABEL_RN_NEED_CPF)) {
      const digits = onlyDigits(customerText);
      const looksCpf = digits.length === 11;
      const looksCnpj = digits.length === 14;

      if (!looksCpf && !looksCnpj) {
        await sendMessageToConversation(conversationId, "Me envie o CPF (11 dígitos) ou CNPJ (14 dígitos), somente números 🙂");
        return;
      }

      console.log("🔎 ReceitaNet lookup CPF/CNPJ...");
      const rn = await receitanetClientesLookup({ cpfcnpj: digits });

      if (rn.ok && rn.body?.success !== false) {
        await removeConversationLabels(conversationId, [LABEL_RN_NEED_CPF]);
        await addConversationLabels(conversationId, [LABEL_RN_CLIENT_KNOWN]);
        await sendMessageToConversation(conversationId, "✅ Cadastro localizado! Como posso te ajudar agora? (boleto, suporte, planos, etc.)");
        return;
      } else {
        console.log("⚠️ ReceitaNet CPF não localizado:", rn.status, rn.body);
        await sendMessageToConversation(conversationId, "Não consegui localizar esse CPF/CNPJ. Pode confirmar os números (somente números) ou me dizer se você ainda não é cliente?");
        return;
      }
    }

    // 5) GPT normal
    const mode = labelSet.has(LABEL_RN_SALES_MODE)
      ? "vendas"
      : labelSet.has(LABEL_RN_CLIENT_KNOWN)
      ? "cliente"
      : "triagem";

    const reply = await openaiReply({ customerText, mode });
    await sendMessageToConversation(conversationId, reply);
  } catch (e) {
    console.error("❌ Erro no webhook:", e);
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Bot online na porta", port));
