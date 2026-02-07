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
 * RECEITANET_APP=chatbot
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
const RECEITANET_APP = process.env.RECEITANET_APP || "chatbot";

// ----------------------- Labels / Config -----------------------
const LABEL_GPT_ON = "gpt_on";
const LABEL_GPT_WELCOME_SENT = "gpt_welcome_sent";

const fugaCount = new Map();
const FUGA_LIMIT = Number(process.env.AUTO_GPT_THRESHOLD || 3);

// anti-spam simples (evita repetir a mesma frase)
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

function isMenuInput(text) {
  const t = normalizeText(text);
  return ["1", "2", "3"].includes(t);
}
function isYes(text) {
  const t = normalizeText(text).toLowerCase();
  return ["sim", "s", "claro", "isso", "sou"].includes(t);
}
function isNo(text) {
  const t = normalizeText(text).toLowerCase();
  return ["nao", "não", "n", "negativo"].includes(t);
}

function looksLikeCPFOrCNPJ(text) {
  const d = onlyDigits(text);
  return d.length === 11 || d.length === 14;
}

function extractWhatsAppFromPayload(payload) {
  const w =
    payload?.sender?.additional_attributes?.whatsapp ||
    payload?.remetente?.atributos_adicionais?.whatsapp ||
    payload?.conversation?.meta?.sender?.additional_attributes?.whatsapp ||
    payload?.conversation?.meta?.remetente?.atributos_adicionais?.whatsapp ||
    null;

  const digits = onlyDigits(w);
  return digits || null;
}

function extractAttachments(payload) {
  const a1 = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const a2 = Array.isArray(payload?.anexos) ? payload.anexos : [];
  const a3 = Array.isArray(payload?.message?.attachments) ? payload.message.attachments : [];
  const a4 = Array.isArray(payload?.mensagem?.anexos) ? payload.mensagem.anexos : [];
  return [...a1, ...a2, ...a3, ...a4].filter(Boolean);
}

function pickAttachmentInfo(att) {
  const fileType = att.file_type || att.tipo_de_arquivo || "unknown";
  const dataUrl = att.data_url || att.dataUrl || null;
  return { fileType, dataUrl };
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
  if (throttleSend(conversationId, content, 5000)) return;
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

// ✅ guarda "estado" na conversa
async function setConversationCustomAttributes(conversationId, attrs = {}) {
  // Chatwoot aceita custom_attributes no body (varia por versão).
  // Tentamos POST e se falhar, tentamos PATCH.
  const path = `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/custom_attributes`;

  try {
    return await chatwootFetch(path, { method: "POST", body: { custom_attributes: attrs } });
  } catch (e) {
    // fallback
    try {
      return await chatwootFetch(path, { method: "PATCH", body: { custom_attributes: attrs } });
    } catch {
      console.log("⚠️ Não consegui salvar custom_attributes (endpoint pode variar).", e?.status || "");
      return null;
    }
  }
}

// ----------------------- Attachment download test -----------------------
async function downloadAttachmentFromDataUrl(dataUrl) {
  const res = await fetch(dataUrl, { headers: buildChatwootHeaders() });
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: res.ok, status: res.status, bytes: buf.length };
}

// ----------------------- OpenAI (só quando necessário) -----------------------
async function openaiReply({ customerText, state, intent }) {
  const system = `
Você é a atendente virtual da i9NET.
Você deve responder SEM confundir o cliente.

Contexto atual:
- state=${state}
- intent=${intent}

Regras:
- Seja direto.
- Não refaça perguntas já respondidas.
- Se intent=COMPROVANTE: peça CPF/CNPJ (se ainda não foi informado) e depois peça mês de referência.
- Se intent=BOLETO: peça CPF/CNPJ (se ainda não foi informado).
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

// ----------------------- Simple intent parse (sem GPT) -----------------------
function parseProofOrBoleto(text) {
  const t = normalizeText(text).toLowerCase();

  const mentionsBoleto = t.includes("boleto") || t.includes("2ª via") || t.includes("2a via") || t.includes("fatura");
  const mentionsProof = t.includes("comprov") || t.includes("paguei") || t.includes("pagamento");

  const mentionsBarcode = t.includes("código de barras") || t.includes("codigo de barras") || t.includes("barras");
  const mentionsPix = t.includes("pix");

  return {
    mentionsBoleto,
    mentionsProof,
    mentionsBarcode,
    mentionsPix,
  };
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
    const customerText = normalizeText(req.body?.content || req.body?.conteudo || "");
    const attachments = extractAttachments(req.body);

    console.log("🔥 webhook: message_created | tipo: incoming");
    console.log("📩 PROCESSANDO:", { conversaId: conversationId, customerText: customerText || "(vazio)", anexos: attachments.length });

    if (!conversationId) return;

    // Sempre pega conversa atual (labels + custom_attributes)
    const conv = await getConversation(conversationId);

    const labels = (conv?.labels || []).map((x) => (typeof x === "string" ? x : x?.title)).filter(Boolean);
    const labelSet = new Set(labels);

    const ca = conv?.custom_attributes || {};
    const state = ca.gpt_state || "idle";
    const intent = ca.gpt_intent || "unknown";
    const cpfcnpjStored = ca.cpfcnpj || "";

    // -------------------- AUTO ATIVAR GPT (3 fugas do menu) --------------------
    if (!labelSet.has(LABEL_GPT_ON)) {
      if (isMenuInput(customerText)) {
        fugaCount.set(conversationId, 0);
        return;
      }
      const next = (fugaCount.get(conversationId) || 0) + 1;
      fugaCount.set(conversationId, next);
      console.log("🟡 fuga do menu:", { conversationId, nextCount: next });

      if (next < FUGA_LIMIT) return;

      console.log("⚡ GPT autoativador (3 testes) -> ativando GPT");
      await addConversationLabels(conversationId, [LABEL_GPT_ON]);

      if (!labelSet.has(LABEL_GPT_WELCOME_SENT)) {
        await addConversationLabels(conversationId, [LABEL_GPT_WELCOME_SENT]);
        await setConversationCustomAttributes(conversationId, {
          gpt_state: "awaiting_need",
          gpt_intent: "unknown",
        });
        await sendMessageToConversation(conversationId, "✅ Entendi. Vou te atender por aqui sem precisar do menu.");
        await sendMessageToConversation(conversationId, "Como posso ajudar: suporte, boleto/2ª via, ou enviar comprovante de pagamento?");
      }
      return;
    }

    // -------------------- GPT ON: fluxo com estado --------------------
    // 1) Se vier ANEXO com content vazio
    if (!customerText && attachments.length > 0) {
      const { fileType, dataUrl } = pickAttachmentInfo(attachments[0]);

      console.log("📎 ANEXO DETECTADO:", {
        fileType,
        dataUrlPreview: dataUrl ? dataUrl.slice(0, 90) + "..." : null,
      });

      if (dataUrl) {
        const dl = await downloadAttachmentFromDataUrl(dataUrl);
        console.log("⬇️ baixar teste:", dl);
      }

      await setConversationCustomAttributes(conversationId, {
        gpt_state: "awaiting_proof_type",
        gpt_intent: "comprovante",
        last_attachment_url: dataUrl || "",
        last_attachment_type: fileType,
      });

      await sendMessageToConversation(
        conversationId,
        "📎 Recebi seu comprovante. Ele foi pago por *PIX* ou por *boleto (código de barras)*?"
      );
      return;
    }

    // se texto vazio e sem anexo, ignora
    if (!customerText) return;

    // 2) Rotas rápidas por estado (SEM GPT)
    const parsed = parseProofOrBoleto(customerText);

    // Estado: esperando tipo (pix ou barras)
    if (state === "awaiting_proof_type") {
      const method = parsed.mentionsPix ? "pix" : parsed.mentionsBarcode ? "barcode" : "";

      if (!method) {
        await sendMessageToConversation(conversationId, "Só para eu seguir certinho: foi *PIX* ou *código de barras*?");
        return;
      }

      await setConversationCustomAttributes(conversationId, {
        gpt_state: "awaiting_cpf",
        payment_method: method,
        gpt_intent: "comprovante",
      });

      await sendMessageToConversation(conversationId, "Perfeito. Agora me envie o *CPF ou CNPJ do titular* (somente números).");
      return;
    }

    // Estado: esperando CPF/CNPJ
    if (state === "awaiting_cpf") {
      if (!looksLikeCPFOrCNPJ(customerText)) {
        await sendMessageToConversation(conversationId, "Opa! Envie apenas o *CPF (11)* ou *CNPJ (14)*, somente números.");
        return;
      }

      const digits = onlyDigits(customerText);
      await setConversationCustomAttributes(conversationId, {
        cpfcnpj: digits,
        gpt_state: "awaiting_cpf_confirm",
      });

      await sendMessageToConversation(conversationId, `Confirma que *${digits}* é seu CPF/CNPJ? (Responda SIM ou NÃO)`);
      return;
    }

    // Estado: confirmar CPF
    if (state === "awaiting_cpf_confirm") {
      if (isNo(customerText)) {
        await setConversationCustomAttributes(conversationId, { gpt_state: "awaiting_cpf", cpfcnpj: "" });
        await sendMessageToConversation(conversationId, "Sem problemas. Me envie o CPF/CNPJ correto (somente números).");
        return;
      }
      if (!isYes(customerText)) {
        await sendMessageToConversation(conversationId, "Responda *SIM* para confirmar ou *NÃO* para corrigir.");
        return;
      }

      await setConversationCustomAttributes(conversationId, { gpt_state: "awaiting_month" });

      // ✅ aqui a conversa NÃO volta para triagem
      await sendMessageToConversation(conversationId, "Show! Qual o *mês de referência* do boleto/fatura? (ex: 01/2026)");
      return;
    }

    // Estado: esperando mês
    if (state === "awaiting_month") {
      // aceitamos qualquer texto curto como mês
      const m = normalizeText(customerText);
      if (m.length < 3) {
        await sendMessageToConversation(conversationId, "Me diga o mês de referência (ex: 01/2026).");
        return;
      }

      await setConversationCustomAttributes(conversationId, { ref_month: m, gpt_state: "awaiting_next_step" });

      await sendMessageToConversation(
        conversationId,
        `Beleza! Vou conferir o pagamento e a fatura de referência *${m}*. Se você quiser, me diga agora: você quer *regularizar* (boleto/2ª via) ou apenas *validar o comprovante*?`
      );
      return;
    }

    // 3) Se não caiu em nenhum estado, usa GPT com contexto (bem menos confuso)
    const wa = extractWhatsAppFromPayload(req.body);
    const reply = await openaiReply({
      customerText: `WhatsApp:${wa || "n/a"}\nEstado:${state}\nIntenção:${intent}\nCPF/CNPJ:${cpfcnpjStored || "n/a"}\nMensagem:${customerText}`,
      state,
      intent,
    });

    await sendMessageToConversation(conversationId, reply);
  } catch (e) {
    console.error("❌ Erro no webhook:", e);
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Bot online na porta", port));
