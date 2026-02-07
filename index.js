import express from "express";

const app = express();
app.use(express.json({ limit: "15mb" }));

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
 * RECEITANET_APP=chatbot
 *
 * AUTO_GPT_THRESHOLD=3
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

const RECEITANET_BASE_URL = (process.env.RECEITANET_BASE_URL ||
  "https://sistema.receitanet.net/api/novo/chatbot").replace(/\/+$/, "");
const RECEITANET_CHATBOT_TOKEN = process.env.RECEITANET_CHATBOT_TOKEN || "";
const RECEITANET_APP = process.env.RECEITANET_APP || "chatbot";

const RECEITANET_CACHE_TTL_MS = Number(process.env.RECEITANET_CACHE_TTL_MS || 10 * 60 * 1000);

// ----------------------- Labels / Config -----------------------
const LABEL_GPT_ON = "gpt_on";
const LABEL_GPT_WELCOME_SENT = "gpt_welcome_sent";

const FUGA_LIMIT = Number(process.env.AUTO_GPT_THRESHOLD || 3);

// memória em runtime (ok pra Render)
const fugaCount = new Map();
const recentSent = new Map();

// ----------------------- Utils -----------------------
function normalizeText(s) {
  return (s || "").toString().trim();
}
function onlyDigits(s) {
  return (s || "").replace(/\D+/g, "");
}
function looksLikeCPFOrCNPJ(text) {
  const d = onlyDigits(text);
  return d.length === 11 || d.length === 14;
}
function normalizePhoneForReceita(raw) {
  let digits = onlyDigits(raw);
  if (!digits) return "";
  // Chatwoot geralmente vem 55 + DDD + numero
  if (digits.startsWith("55") && digits.length >= 12) digits = digits.slice(2);
  return digits;
}
function isYes(text) {
  const t = normalizeText(text).toLowerCase();
  return ["sim", "s", "claro", "isso", "ok", "sou", "confirmo", "confirmar"].includes(t);
}
function isNo(text) {
  const t = normalizeText(text).toLowerCase();
  return ["nao", "não", "n", "negativo", "não sou"].includes(t);
}
function throttleSend(conversationId, text, ms = 6000) {
  const now = Date.now();
  const prev = recentSent.get(conversationId);
  if (prev && prev.text === text && now - prev.ts < ms) return true;
  recentSent.set(conversationId, { text, ts: now });
  return false;
}

// Menu numérico do SMSNET (não é “menu do GPT”)
function mapSmsnetMenuChoice(text) {
  const t = normalizeText(text);
  if (t === "1") return { agent: "anderson", intent: "suporte", note: "Escolheu opção 1 (suporte)" };
  if (t === "2") return { agent: "cassia", intent: "financeiro", note: "Escolheu opção 2 (boleto/financeiro)" };
  if (t === "3") return { agent: "isa", intent: "vendas", note: "Escolheu opção 3 (planos/vendas)" };
  return null;
}

function isConnectivityIssue(text) {
  const t = normalizeText(text).toLowerCase();
  return (
    t.includes("sem internet") ||
    t.includes("sem sinal") ||
    t.includes("caiu") ||
    t.includes("quedas") ||
    t.includes("lent") ||
    t.includes("não conecta") ||
    t.includes("nao conecta")
  );
}

function parseIntentKeywords(text) {
  const t = normalizeText(text).toLowerCase();
  const finance =
    t.includes("boleto") ||
    t.includes("2ª via") ||
    t.includes("2a via") ||
    t.includes("fatura") ||
    t.includes("pag") ||
    t.includes("comprov") ||
    t.includes("pix") ||
    t.includes("código de barras") ||
    t.includes("codigo de barras") ||
    t.includes("inadimpl") ||
    t.includes("bloque") ||
    t.includes("cobr");
  const sales =
    t.includes("plano") ||
    t.includes("contratar") ||
    t.includes("instala") ||
    t.includes("assinar") ||
    t.includes("valor") ||
    t.includes("preço") ||
    t.includes("preco") ||
    t.includes("fibra");
  const support = isConnectivityIssue(text) || t.includes("wifi") || t.includes("roteador") || t.includes("onu") || t.includes("ont");

  if (finance && !sales && !support) return { agent: "cassia", intent: "financeiro" };
  if (support && !sales) return { agent: "anderson", intent: "suporte" };
  if (sales) return { agent: "isa", intent: "vendas" };
  return { agent: "isa", intent: "triagem" };
}

// ----------------------- Payload extractors -----------------------
function extractWhatsAppFromPayload(payload) {
  const w =
    payload?.contact?.phone_number ||
    payload?.sender?.additional_attributes?.whatsapp ||
    payload?.remetente?.atributos_adicionais?.whatsapp ||
    payload?.conversation?.meta?.sender?.additional_attributes?.whatsapp ||
    payload?.conversation?.meta?.remetente?.atributos_adicionais?.whatsapp ||
    payload?.conversation?.meta?.contact?.phone_number ||
    payload?.conversation?.messages?.[0]?.sender?.additional_attributes?.whatsapp ||
    payload?.conversation?.messages?.[0]?.remetente?.atributos_adicionais?.whatsapp ||
    null;

  const digits = onlyDigits(w);
  return digits || null;
}

function extractAttachments(payload) {
  const a1 = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const a2 = Array.isArray(payload?.anexos) ? payload.anexos : [];
  const a3 = Array.isArray(payload?.message?.attachments) ? payload.message.attachments : [];
  const a4 = Array.isArray(payload?.mensagem?.anexos) ? payload.mensagem.anexos : [];
  const a5 = Array.isArray(payload?.conversation?.messages?.[0]?.attachments) ? payload.conversation.messages[0].attachments : [];
  const a6 = Array.isArray(payload?.conversation?.messages?.[0]?.anexos) ? payload.conversation.messages[0].anexos : [];
  return [...a1, ...a2, ...a3, ...a4, ...a5, ...a6].filter(Boolean);
}

function pickAttachmentInfo(att) {
  const fileType = att.file_type || att.tipo_de_arquivo || att.fileType || "unknown";
  const dataUrl = att.data_url || att.dataUrl || null;
  return { fileType, dataUrl };
}

// ----------------------- ENV guard -----------------------
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

  if (!res.ok) throw { ok: false, status: res.status, url, body: json || text, message: "Falha no /auth/sign_in" };

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

  if (!res.ok) throw { ok: false, status: res.status, url, body: json || text, message: `Chatwoot API ${res.status}` };

  return json || { ok: true };
}

async function sendMessageToConversation(conversationId, content) {
  if (!content) return;
  if (throttleSend(conversationId, content, 4500)) return;
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    { method: "POST", body: { content, message_type: "outgoing" } }
  );
}

async function getConversation(conversationId) {
  return chatwootFetch(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`, { method: "GET" });
}

async function addConversationLabels(conversationId, labelsToAdd = []) {
  const uniq = [...new Set(labelsToAdd.filter(Boolean))];
  if (!uniq.length) return;
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/labels`,
    { method: "POST", body: { labels: uniq } }
  );
}

async function setConversationCustomAttributes(conversationId, attrs = {}) {
  const path = `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/custom_attributes`;
  try {
    return await chatwootFetch(path, { method: "POST", body: { custom_attributes: attrs } });
  } catch (e) {
    try {
      return await chatwootFetch(path, { method: "PATCH", body: { custom_attributes: attrs } });
    } catch {
      console.log("⚠️ Não consegui salvar custom_attributes.", e?.status || "");
      return null;
    }
  }
}

// ----------------------- Attachment download -----------------------
async function downloadAttachmentAsDataUrl(dataUrl) {
  const res = await fetch(dataUrl, { headers: buildChatwootHeaders() });
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const base64 = buf.toString("base64");
  const dataUri = `data:${contentType};base64,${base64}`;
  return { ok: res.ok, status: res.status, bytes: buf.length, contentType, dataUri };
}

// ----------------------- ReceitaNet (conforme doc: POST /clientes etc.) -----------------------
async function receitanetPost(path, paramsObj = {}) {
  const url = `${RECEITANET_BASE_URL}${path}`;

  // doc mostra token/app como query, mas Postman mostra form-data; URLSearchParams funciona bem em geral.
  const body = new URLSearchParams();
  body.set("token", RECEITANET_CHATBOT_TOKEN);
  body.set("app", RECEITANET_APP);
  for (const [k, v] of Object.entries(paramsObj)) {
    if (v !== undefined && v !== null && String(v).length) body.set(k, String(v));
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (res.status === 404) return { ok: false, status: 404, body: json || text };
  if (!res.ok) throw { ok: false, status: res.status, url, body: json || text, message: `ReceitaNet ${res.status}` };

  return { ok: true, status: res.status, data: json };
}

async function receitanetFindClient({ phone, cpfcnpj }) {
  // POST /clientes busca por cpfcnpj ou phone :contentReference[oaicite:4]{index=4}
  const params = {};
  if (phone) params.phone = phone;
  if (cpfcnpj) params.cpfcnpj = cpfcnpj;
  return receitanetPost("/clientes", params);
}

async function receitanetDebitos({ cpfcnpj, page = 1, status = 0, data_inicio, data_fim }) {
  // POST /debitos (tem filtros) :contentReference[oaicite:5]{index=5}
  const params = { page, status };
  if (cpfcnpj) params.cpfcnpj = cpfcnpj;
  if (data_inicio) params.data_inicio = data_inicio; // dd-mm-yyyy
  if (data_fim) params.data_fim = data_fim;
  return receitanetPost("/debitos", params);
}

async function receitanetEnviarBoleto({ idCliente, contato, tipo }) {
  // POST /boletos enviar boleto pendente por email ou sms :contentReference[oaicite:6]{index=6}
  return receitanetPost("/boletos", { idCliente, contato, tipo });
}

async function receitanetVerificarAcesso({ idCliente, contato }) {
  // POST /verificar-acesso :contentReference[oaicite:7]{index=7}
  return receitanetPost("/verificar-acesso", { idCliente, contato });
}

function extractReceitaClientSummary(data) {
  // Pode variar; mantemos robusto
  const nome =
    data?.razaoSocial ||
    data?.razao_social ||
    data?.nome ||
    data?.cliente?.nome ||
    data?.cliente?.razaoSocial ||
    "";
  const idCliente =
    data?.idCliente ||
    data?.id ||
    data?.cliente?.idCliente ||
    data?.cliente?.id ||
    null;

  return { nome, idCliente };
}

async function getReceitaCache(conversationId, ca, { phone, cpfcnpj }) {
  const cache = ca?.receitanet_cache || {};
  const key = `${phone || ""}|${cpfcnpj || ""}`;
  const fresh = cache?.key === key && cache?.ts && Date.now() - cache.ts < RECEITANET_CACHE_TTL_MS;
  if (fresh) return cache;

  const resp = await receitanetFindClient({ phone, cpfcnpj });
  const next = {
    key,
    ts: Date.now(),
    found: resp.ok,
    status: resp.status,
    raw: resp.ok ? resp.data : resp.body,
  };

  if (resp.ok) next.summary = extractReceitaClientSummary(resp.data || {});
  await setConversationCustomAttributes(conversationId, { receitanet_cache: next });
  return next;
}

// ----------------------- Agentes (personas) -----------------------
const AGENTS = {
  isa: {
    name: "Isa (Triagem)",
    style:
      "Atendente de triagem. Curta, objetiva, acolhedora. NÃO usa menu numérico. Faz no máximo 1 pergunta por vez.",
  },
  cassia: {
    name: "Cássia (Financeiro)",
    style:
      "Financeiro. Foco em boleto/2ª via, comprovante, inadimplência. NÃO usa menu numérico. Evita repetir perguntas já respondidas.",
  },
  anderson: {
    name: "Anderson (Suporte)",
    style:
      "Suporte técnico. Diagnóstico rápido. NÃO usa menu numérico. Se suspeitar bloqueio, encaminha para financeiro.",
  },
};

function buildSystemPrompt({ agentKey, context }) {
  const a = AGENTS[agentKey] || AGENTS.isa;
  return `
Você é ${a.name} da i9NET.
${a.style}

REGRAS IMPORTANTES:
- Nunca peça para o cliente escolher "1/2/3". Nunca mostre menu numérico.
- Se o cliente mandar apenas "1", "2" ou "3", interprete como escolha do menu do sistema anterior (SMS) e siga o atendimento sem perguntar "o que significa".
- Não repita perguntas já respondidas.
- Sempre use o estado e dados já conhecidos (CPF/CNPJ, WhatsApp, anexos).
- Faça apenas 1 pergunta objetiva quando faltar algo.
- Se houver comprovante (imagem/PDF), diga o que identificou e peça somente o que faltar.
- Se o cliente disser "sem internet", primeiro verifique se pode ser bloqueio por débito; se for, ofereça 2ª via / regularização.

CONTEXTO (confiável):
${context}
`.trim();
}

// ----------------------- OpenAI -----------------------
async function openaiText({ agentKey, userText, context }) {
  const system = buildSystemPrompt({ agentKey, context });

  const input = [
    { role: "system", content: system },
    { role: "user", content: userText },
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
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw { ok: false, status: res.status, body: json || text };

  const out =
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    json?.choices?.[0]?.message?.content ||
    null;

  return (out || "Certo! Me diga em poucas palavras como posso ajudar.").trim();
}

async function openaiAnalyzeImage({ noteText, imageDataUrl, context }) {
  const system = `
Você é Cássia (Financeiro) da i9NET.
Analise o comprovante/imagem e extraia o máximo possível SEM inventar.
Retorne JSON com:
{
 "tipo": "pix" | "boleto" | "desconhecido",
 "valor": "string ou vazio",
 "data": "string ou vazio",
 "barras_ultimos4": "string ou vazio",
 "qrcode_pix": "true/false",
 "nome_beneficiario": "string ou vazio"
}
Se não conseguir algo, deixe vazio. Depois do JSON, em 1 frase diga o que achou.
NÃO faça menu numérico.
Contexto: ${context}
`.trim();

  const input = [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "input_text", text: noteText || "Analise o comprovante." },
        { type: "input_image", image_url: imageDataUrl },
      ],
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
      max_output_tokens: 260,
    }),
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw { ok: false, status: res.status, body: json || text };

  const out =
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    json?.choices?.[0]?.message?.content ||
    "";

  // tenta capturar JSON no começo
  const firstBrace = out.indexOf("{");
  const lastBrace = out.lastIndexOf("}");
  let parsed = null;
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const maybe = out.slice(firstBrace, lastBrace + 1);
    try { parsed = JSON.parse(maybe); } catch {}
  }
  return { text: out.trim(), parsed };
}

// ----------------------- WEBHOOK -----------------------
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
    if (!conversationId) return;

    const customerText = normalizeText(req.body?.content || req.body?.conteudo || "");
    const attachments = extractAttachments(req.body);

    console.log("🔥 webhook: message_created | incoming");
    console.log("📩 PROCESSANDO:", { conversaId: conversationId, customerText: customerText || "(vazio)", anexos: attachments.length });

    const conv = await getConversation(conversationId);
    const labels = (conv?.labels || [])
      .map((x) => (typeof x === "string" ? x : x?.title))
      .filter(Boolean);
    const labelSet = new Set(labels);

    const ca = conv?.custom_attributes || {};
    const gptState = ca.gpt_state || "idle";
    const agentKey = ca.agent_key || "isa";
    const cpfcnpjStored = ca.cpfcnpj || "";
    const waRaw = extractWhatsAppFromPayload(req.body);
    const waPhone = normalizePhoneForReceita(waRaw || ca.whatsapp_phone || "");

    // salva whatsapp na conversa
    if (waPhone && waPhone !== ca.whatsapp_phone) {
      await setConversationCustomAttributes(conversationId, { whatsapp_phone: waPhone });
    }

    // Se vier CPF/CNPJ no texto, salva
    if (looksLikeCPFOrCNPJ(customerText)) {
      const doc = onlyDigits(customerText);
      if (doc && doc !== cpfcnpjStored) await setConversationCustomAttributes(conversationId, { cpfcnpj: doc });
    }

    // -------------------- AUTO ATIVAR GPT (3 fugas) --------------------
    if (!labelSet.has(LABEL_GPT_ON)) {
      // Se cliente só manda números (menu do SMSNET), NÃO conta como fuga do menu
      if (mapSmsnetMenuChoice(customerText)) {
        fugaCount.set(conversationId, 0);
        return;
      }

      const next = (fugaCount.get(conversationId) || 0) + 1;
      fugaCount.set(conversationId, next);
      console.log("🟡 fuga do menu:", { conversationId, nextCount: next });

      if (next < FUGA_LIMIT) return;

      console.log("⚡ GPT autoativador -> ativando GPT");
      await addConversationLabels(conversationId, [LABEL_GPT_ON]);

      if (!labelSet.has(LABEL_GPT_WELCOME_SENT) && !ca.gpt_welcome_sent) {
        await addConversationLabels(conversationId, [LABEL_GPT_WELCOME_SENT]);
        await setConversationCustomAttributes(conversationId, {
          gpt_state: "awaiting_need",
          agent_key: "isa",
          gpt_welcome_sent: true,
        });
        await sendMessageToConversation(conversationId, "✅ Entendi. Vou te atender por aqui sem precisar do menu.");
        await sendMessageToConversation(conversationId, "Você precisa de *suporte*, *boleto/2ª via* ou *validar comprovante*?");
      }
      return;
    }

    // -------------------- GPT ON --------------------
    // 0) Se recebeu opção 1/2/3 do menu SMSNET, roteia direto (sem perguntar o significado)
    const menuChoice = mapSmsnetMenuChoice(customerText);
    if (menuChoice) {
      await setConversationCustomAttributes(conversationId, {
        agent_key: menuChoice.agent,
        gpt_state: "awaiting_need",
        last_routed_by: "smsnet_menu",
      });
      const msg =
        menuChoice.intent === "suporte"
          ? "Certo — me diga rapidamente: está *sem internet*, *lento* ou *caindo*?"
          : menuChoice.intent === "financeiro"
          ? "Certo — você precisa de *boleto/2ª via* ou quer *validar um comprovante*?"
          : "Certo — você quer contratar internet? Me diga seu bairro/cidade para eu ver disponibilidade.";
      await sendMessageToConversation(conversationId, msg);
      return;
    }

    // 1) Se vier anexo, força financeiro (Cássia) e analisa
    if (attachments.length > 0) {
      const { fileType, dataUrl } = pickAttachmentInfo(attachments[0]);
      const isSame = dataUrl && dataUrl === ca.last_attachment_url && ca.attachment_processed === true;

      console.log("📎 ANEXO DETECTADO:", { fileType, dataUrlPreview: dataUrl ? dataUrl.slice(0, 80) + "..." : null });

      await setConversationCustomAttributes(conversationId, {
        agent_key: "cassia",
        gpt_state: "awaiting_finance_action",
        last_attachment_url: dataUrl || "",
        last_attachment_type: fileType,
      });

      // se for imagem e não foi processado ainda
      if (!isSame && dataUrl) {
        const dl = await downloadAttachmentAsDataUrl(dataUrl);
        console.log("⬇️ baixar teste:", { ok: dl.ok, status: dl.status, bytes: dl.bytes, contentType: dl.contentType });

        if (dl.ok && dl.bytes <= 4 * 1024 * 1024 && dl.contentType.startsWith("image/")) {
          const context = `whatsapp=${waPhone || "n/a"} cpfcnpj=${cpfcnpjStored || "n/a"} state=${gptState}`;
          try {
            const analysis = await openaiAnalyzeImage({
              noteText: customerText || "Comprovante enviado.",
              imageDataUrl: dl.dataUri,
              context,
            });

            await setConversationCustomAttributes(conversationId, {
              attachment_processed: true,
              last_payment_extract: analysis.parsed || null,
            });

            // mensagem curta + pede só o que faltar
            await sendMessageToConversation(conversationId, analysis.text);

            // se ainda não tem CPF/CNPJ, pede agora (uma vez)
            if (!cpfcnpjStored) {
              await setConversationCustomAttributes(conversationId, { gpt_state: "awaiting_cpf" });
              await sendMessageToConversation(conversationId, "Para localizar seu cadastro, me envie o *CPF ou CNPJ do titular* (somente números).");
            } else {
              await setConversationCustomAttributes(conversationId, { gpt_state: "awaiting_finance_action" });
              await sendMessageToConversation(conversationId, "Você quer *regularizar* (boleto/2ª via) ou apenas *validar esse comprovante*?");
            }
            return;
          } catch (e) {
            console.log("⚠️ falha análise imagem OpenAI", e?.status || "");
          }
        }
      }

      // anexo sem texto -> pergunta objetiva
      if (!customerText) {
        await sendMessageToConversation(conversationId, "📎 Recebi seu arquivo. Ele é *comprovante de pagamento* ou *boleto/2ª via*?");
        return;
      }
    }

    // se texto vazio e sem anexo -> ignora
    if (!customerText && attachments.length === 0) return;

    // 2) Estado travado: aguardando CPF
    if ((ca.gpt_state || "idle") === "awaiting_cpf") {
      if (!looksLikeCPFOrCNPJ(customerText)) {
        await sendMessageToConversation(conversationId, "Opa! Envie *CPF (11)* ou *CNPJ (14)*, somente números.");
        return;
      }
      const doc = onlyDigits(customerText);
      await setConversationCustomAttributes(conversationId, { cpfcnpj: doc, gpt_state: "awaiting_need" });

      // tenta localizar já com cpfcnpj
      const cache = await getReceitaCache(conversationId, ca, { phone: waPhone, cpfcnpj: doc });
      if (cache.found && cache.summary?.nome) {
        await sendMessageToConversation(conversationId, `Perfeito, ${cache.summary.nome}! Como posso ajudar hoje?`);
      } else {
        await sendMessageToConversation(conversationId, "Perfeito! Como posso ajudar: *suporte*, *boleto/2ª via* ou *validar comprovante*?");
      }
      return;
    }

    // 3) Roteamento automático de agente por palavras (se não estiver travado)
    let routedAgent = agentKey;
    if (!ca.agent_locked) {
      // se o cliente falar “sem internet”, vai pro suporte
      const kw = parseIntentKeywords(customerText);
      routedAgent = kw.agent;
      await setConversationCustomAttributes(conversationId, { agent_key: routedAgent });
    }

    // 4) Se for suporte e menciona “sem internet”: checa ReceitaNet e orienta
    if (routedAgent === "anderson" && isConnectivityIssue(customerText)) {
      const doc = ca.cpfcnpj || "";
      const cache = await getReceitaCache(conversationId, ca, { phone: waPhone, cpfcnpj: doc });

      if (!cache.found) {
        // não localizou: pede confirmação se é cliente, mas SEM loop
        await setConversationCustomAttributes(conversationId, { gpt_state: "awaiting_customer_status", agent_key: "isa" });
        await sendMessageToConversation(conversationId, "Não localizei seu cadastro pelo WhatsApp. Você já é cliente i9NET? (Responda *SIM* ou *NÃO*)");
        return;
      }

      // Com cadastro: checar débitos (se tiver CPF/CNPJ)
      if (doc) {
        const deb = await receitanetDebitos({ cpfcnpj: doc, page: 1, status: 0 }).catch(() => null);
        const hasDebits = Array.isArray(deb?.data) && deb.data.length > 0;

        if (hasDebits) {
          await setConversationCustomAttributes(conversationId, { agent_key: "cassia", gpt_state: "awaiting_finance_action" });
          await sendMessageToConversation(conversationId, "Encontrei indício de *pendência financeira* que pode causar bloqueio. Você quer que eu gere a *2ª via do boleto* para regularizar?");
          return;
        }
      }

      await sendMessageToConversation(conversationId, "Vamos rápido: desligue a ONU/roteador por 2 minutos, ligue e teste. Se continuar, me diga se a luz *PON* está verde fixa ou piscando.");
      return;
    }

    // 5) Estado: confirmar se é cliente (sem loop)
    if ((ca.gpt_state || "idle") === "awaiting_customer_status") {
      if (isYes(customerText)) {
        await setConversationCustomAttributes(conversationId, { gpt_state: "awaiting_cpf", agent_key: "isa" });
        await sendMessageToConversation(conversationId, "Perfeito! Me envie o *CPF ou CNPJ do titular* (somente números).");
        return;
      }
      if (isNo(customerText)) {
        await setConversationCustomAttributes(conversationId, { gpt_state: "sales_flow", agent_key: "isa" });
        await sendMessageToConversation(conversationId, "Sem problemas 😊 Me diga *bairro/cidade* e se prefere *residencial ou empresarial*.");
        return;
      }
      await sendMessageToConversation(conversationId, "Só para confirmar: você já é cliente? Responda *SIM* ou *NÃO*.");
      return;
    }

    // 6) Resposta via GPT com persona correta (SEM menu numérico)
    const context = JSON.stringify(
      {
        waPhone,
        state: ca.gpt_state || "idle",
        agent: routedAgent,
        cpfcnpj: ca.cpfcnpj || "",
        hasAttachment: attachments.length > 0,
        lastExtract: ca.last_payment_extract || null,
      },
      null,
      2
    );

    const reply = await openaiText({
      agentKey: routedAgent,
      userText: customerText,
      context,
    });

    await sendMessageToConversation(conversationId, reply);
  } catch (e) {
    console.error("❌ Erro no webhook:", e);
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Bot online na porta", port));
