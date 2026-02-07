import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));

/**
 * ENV (Render)
 * CHATWOOT_URL=https://chat.smsnet.com.br
 * CHATWOOT_ACCOUNT_ID=195
 * CW_UID=...
 * CW_PASSWORD=...
 * OPENAI_API_KEY=...
 * OPENAI_MODEL=gpt-5.2
 *
 * ReceitaNet:
 * RECEITANET_BASE_URL=https://sistema.receitanet.net/api/novo/chatbot
 * RECEITANET_CHATBOT_TOKEN=...
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
const LABEL_RN_NEED_CPF = "rn_need_cpf";
const LABEL_RN_SALES_MODE = "rn_sales_mode";

const fugaCount = new Map();
const FUGA_LIMIT = 3;

// anti-spam simples
const recentSent = new Map();
function throttleSend(conversationId, text, ms = 6000) {
  const now = Date.now();
  const prev = recentSent.get(conversationId);
  if (prev && prev.text === text && now - prev.ts < ms) return true;
  recentSent.set(conversationId, { text, ts: now });
  return false;
}

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

function extractWhatsAppFromPayload(payload) {
  // seus exemplos mostram "sender.additional_attributes.whatsapp"
  const w =
    payload?.sender?.additional_attributes?.whatsapp ||
    payload?.remetente?.atributos_adicionais?.whatsapp ||
    payload?.conversation?.meta?.sender?.additional_attributes?.whatsapp ||
    payload?.conversation?.meta?.remetente?.atributos_adicionais?.whatsapp ||
    null;

  const digits = onlyDigits(w);
  if (!digits) return null;
  // padrão que veio: 55 + DDD + número
  return digits;
}

function extractAttachments(payload) {
  // Pode vir em inglês ou PT (seu JSON trouxe os dois!)
  const a1 = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const a2 = Array.isArray(payload?.anexos) ? payload.anexos : [];
  const a3 = Array.isArray(payload?.message?.attachments) ? payload.message.attachments : [];
  const a4 = Array.isArray(payload?.mensagem?.anexos) ? payload.mensagem.anexos : [];
  return [...a1, ...a2, ...a3, ...a4].filter(Boolean);
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

  if (!res.ok) {
    throw { ok: false, status: res.status, url, body: json || text, message: "Falha no /auth/sign_in" };
  }

  const accessToken = res.headers.get("access-token") || "";
  const client = res.headers.get("client") || "";
  const tokenType = res.headers.get("token-type") || "Bearer";

  if (!accessToken || !client) throw new Error("Sign-in OK, mas não retornou access-token/client.");

  CW_ACCESS_TOKEN = accessToken;
  CW_CLIENT = client;
  CW_TOKEN_TYPE = tokenType;

  console.log("🔄 Tokens renovados via sign_in");
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
    console.log("⚠️ 401 no Chatwoot. Renovando tokens...");
    await chatwootSignIn();
    ({ res, text, json } = await doRequest());
  }

  if (!res.ok) {
    throw { ok: false, status: res.status, url, body: json || text, message: `Chatwoot API ${res.status}` };
  }

  return json || { ok: true };
}

async function sendMessageToConversation(conversationId, content) {
  if (throttleSend(conversationId, content, 6000)) return;
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

async function downloadAttachmentFromDataUrl(dataUrl) {
  // tentativa: baixar usando headers do chatwoot
  const res = await fetch(dataUrl, { headers: buildChatwootHeaders() });
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: res.ok, status: res.status, bytes: buf.length };
}

// ----------------------- OpenAI -----------------------
async function openaiReply({ customerText, mode }) {
  const system = `
Você é a atendente virtual da i9NET (provedor de internet).
Modo: ${mode}

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
  try { json = text ? JSON.parse(text) : null; } catch {}

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
  res.status(200).send("ok");

  try {
    if (!assertEnv()) return;

    const event = req.body?.event || req.body?.evento;
    if (event !== "message_created" && event !== "mensagem_criada") return;

    const messageType = req.body?.message_type || req.body?.tipo_de_mensagem;
    const isIncoming =
      messageType === "incoming" || messageType === 0 || messageType === "0" || messageType === "recebida";

    if (!isIncoming) return;

    const conversationId = req.body?.conversation?.id || req.body?.conversa?.id;
    const customerText = normalizeText(req.body?.content || req.body?.conteudo || "");

    const attachments = extractAttachments(req.body);

    console.log("🔥 webhook: message_created | tipo:", isIncoming ? "incoming" : "outgoing");
    console.log("📩 PROCESSANDO:", { conversaId: conversationId, customerText: customerText || "(vazio)", anexos: attachments.length });

    if (!conversationId) return;

    // ✅ Se vier anexo com content vazio -> PROCESSA
    if (!customerText && attachments.length > 0) {
      const a = attachments[0];

      const fileType = a.file_type || a.tipo_de_arquivo || "unknown";
      const dataUrl = a.data_url || a.dataUrl || null;

      console.log("📎 ANEXO DETECTADO:", {
        fileType,
        dataUrlPreview: dataUrl ? dataUrl.slice(0, 80) + "..." : null,
      });

      // tenta baixar (só para confirmar acesso)
      if (dataUrl) {
        const dl = await downloadAttachmentFromDataUrl(dataUrl);
        console.log("⬇️ download teste:", dl);
      }

      await sendMessageToConversation(
        conversationId,
        "📎 Recebi seu arquivo! Ele é um comprovante/pagamento? Se sim, me diga: foi PIX ou boleto (código de barras)?"
      );
      return;
    }

    // a partir daqui: fluxo normal texto
    if (!customerText) return;

    const conv = await getConversation(conversationId);
    const labels = (conv?.labels || []).map((x) => (typeof x === "string" ? x : x?.title)).filter(Boolean);
    const labelSet = new Set(labels);

    // Autoativação depois de 3 fugas do menu
    if (!labelSet.has(LABEL_GPT_ON)) {
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

    // (por enquanto) resposta GPT normal
    const wa = extractWhatsAppFromPayload(req.body);
    const mode = labelSet.has(LABEL_RN_SALES_MODE) ? "vendas" : labelSet.has(LABEL_RN_CLIENT_KNOWN) ? "cliente" : "triagem";
    const reply = await openaiReply({ customerText: `WhatsApp:${wa || "n/a"}\nMensagem:${customerText}`, mode });

    await sendMessageToConversation(conversationId, reply);
  } catch (e) {
    console.error("❌ Erro no webhook:", e);
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Bot online na porta", port));
