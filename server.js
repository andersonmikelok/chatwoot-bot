// server.js
import express from "express";

import {
  normalizeText,
  normalizePhoneBR,
  isIncomingMessage,
  extractConversationId,
  extractMessageText,
  extractAttachments,
  pickFirstAttachment,
  detectIntent,
  mapNumericChoice,
  shouldIgnoreDuplicateEvent,
  buildPersonaHeader,
} from "./lib/utils.js";

import {
  chatwootSignInIfNeeded,
  getConversation,
  sendMessage,
  addLabels, // ✅ MERGE seguro (não apaga labels existentes)
  addLabel,
  removeLabel,
  setCustomAttributesMerge,
  buildAuthHeaders,
  downloadAttachmentAsDataUrl,
} from "./lib/chatwoot.js";

import {
  rnFindClient,
  rnListDebitos,
  rnVerificarAcesso,
  rnNotificacaoPagamento,
} from "./lib/receitanet.js";

import { openaiAnalyzeImage, openaiChat } from "./lib/openai.js";

// =====================
// ENV
// =====================
const PORT = process.env.PORT || 10000;

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = String(process.env.CHATWOOT_ACCOUNT_ID || "");
const CW_UID = process.env.CW_UID || "";
const CW_PASSWORD = process.env.CW_PASSWORD || "";

const RECEITANET_BASE_URL = (
  process.env.RECEITANET_BASE_URL || "https://sistema.receitanet.net/api/novo/chatbot"
).replace(/\/+$/, "");
const RECEITANET_TOKEN = process.env.RECEITANET_TOKEN || process.env.RECEITANET_CHATBOT_TOKEN || "";
const RECEITANET_APP = process.env.RECEITANET_APP || "chatbot";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

// Labels
const LABEL_GPT_ON = "gpt_on";
const LABEL_WELCOME_SENT = "gpt_welcome_sent";
const LABEL_GPT_MANUAL = "gpt_manual_on";

// =====================
// Helpers (gerais)
// =====================
function onlyDigits(s) {
  return (s || "").toString().replace(/\D+/g, "");
}
function normalizeDigits(s) {
  return (s || "").toString().replace(/\D+/g, "");
}
function parseMoneyToNumber(v) {
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  const cleaned = s.replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}
function amountsClose(a, b, tol = 0.05) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tol;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function safeLabelList(conv) {
  return (conv?.labels || []).map((x) => (typeof x === "string" ? x : x?.title)).filter(Boolean);
}
function extractWhatsAppFromPayload(payload) {
  const w =
    payload?.sender?.additional_attributes?.whatsapp ||
    payload?.remetente?.atributos_adicionais?.whatsapp ||
    payload?.conversation?.meta?.sender?.additional_attributes?.whatsapp ||
    payload?.conversation?.meta?.remetente?.atributos_adicionais?.whatsapp ||
    payload?.contact?.phone_number ||
    null;

  return normalizePhoneBR(w || "");
}
function extractCpfCnpjDigits(text) {
  const d = onlyDigits(text || "");
  if (d.length === 11 || d.length === 14) return d;
  return null;
}
function isPaymentIntent(text) {
  const t = normalizeText(text).toLowerCase();
  return (
    t.includes("paguei") ||
    t.includes("pagamento") ||
    t.includes("comprov") ||
    t.includes("pix") ||
    t.includes("transfer") ||
    t.includes("depositei")
  );
}
function isBoletoIntent(text) {
  const t = normalizeText(text).toLowerCase();
  return t.includes("boleto") || t.includes("2ª") || t.includes("2a") || t.includes("fatura") || t.includes("segunda via");
}
function chunkString(str, maxLen = 1200) {
  const s = String(str || "");
  if (!s) return [];
  const parts = [];
  for (let i = 0; i < s.length; i += maxLen) parts.push(s.slice(i, i + maxLen));
  return parts;
}
function isSmsnetSystemMessage(text) {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;

  if (t.includes("digite o número")) return true;
  if (t.includes("por favor digite um número válido")) return true;
  if (t.includes("consultar planos")) return true;
  if (t.includes("já sou cliente")) return true;
  if (t.includes("contatos / endereço")) return true;
  if (t.includes("[1]") || t.includes("[2]") || t.includes("[3]")) return true;
  if (t.startsWith("menu")) return true;

  return false;
}
function receiptMatchesBoleto({ analysis, boleto }) {
  const boletoLine = normalizeDigits(boleto?.barras || "");
  const recLine = normalizeDigits(analysis?.barcode_or_line || "");
  const strong = boletoLine && recLine && boletoLine === recLine;

  const boletoAmount = parseMoneyToNumber(boleto?.valor);
  const paidAmount = parseMoneyToNumber(analysis?.amount);

  const amountOk = amountsClose(paidAmount, boletoAmount, 0.10);
  const hasDate = Boolean(String(analysis?.date || "").trim());
  const medium = amountOk && hasDate;

  return {
    ok: strong || medium,
    level: strong ? "strong" : medium ? "medium" : "none",
    amountOk,
    strong,
    boletoAmount,
    paidAmount,
  };
}

function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!CW_UID) missing.push("CW_UID");
  if (!CW_PASSWORD) missing.push("CW_PASSWORD");
  if (!RECEITANET_BASE_URL) missing.push("RECEITANET_BASE_URL");
  if (!RECEITANET_TOKEN) missing.push("RECEITANET_TOKEN (ou RECEITANET_CHATBOT_TOKEN)");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");

  if (missing.length) {
    console.error("❌ Faltando ENV:", missing.join(" / "));
    return false;
  }
  return true;
}

// ====== ✅ ReceitaNet /debitos date-range (DOC: dd-mm-yyyy) ======
function pad2(n) {
  return String(n).padStart(2, "0");
}
function formatDDMMYYYYDash(date) {
  const d = new Date(date);
  const dd = pad2(d.getDate());
  const mm = pad2(d.getMonth() + 1);
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function buildDebitosDateRange() {
  const now = new Date();
  return {
    data_inicio: formatDDMMYYYYDash(addDays(now, -120)),
    data_fim: formatDDMMYYYYDash(addDays(now, 400)),
  };
}

// =====================
// ✅ Picker robusto: escolhe BOLETO PENDENTE certo
// =====================
function isNumericKey(k) {
  return /^[0-9]+$/.test(String(k));
}
function normalizeBoletoCollection(boletos) {
  if (!boletos) return [];
  if (Array.isArray(boletos)) return boletos.filter(Boolean);

  if (typeof boletos === "object") {
    const keys = Object.keys(boletos).filter(isNumericKey).sort((a, b) => Number(a) - Number(b));
    if (keys.length) return keys.map((k) => boletos[k]).filter(Boolean);
    return Object.values(boletos).filter(Boolean);
  }
  return [];
}
function mapBoletoFields(raw) {
  const r = raw && typeof raw === "object" ? raw : {};

  const vencimento =
    r.vencimento ||
    r.data_vencimento ||
    r.dt_vencimento ||
    r.dt_venc ||
    r.vcto ||
    r.venc ||
    "";

  const valor = r.valor ?? r.valor_boleto ?? r.vlr ?? r.total ?? "";
  const link = r.link || r.url || r.boleto_link || r.link_boleto || r.url_boleto || "";
  const qrcode_pix = r.qrcode_pix || r.pix || r.pix_copia_cola || r.copia_cola || r.qr_pix || "";
  const barras = r.barras || r.codigo_barras || r.linha_digitavel || r.linha || "";
  const pdf = r.pdf || r.pdf_url || r.url_pdf || r.boleto_pdf || "";

  const statusRaw =
    r.status ||
    r.situacao ||
    r.sit ||
    r.estado ||
    r.state ||
    "";

  const status = String(statusRaw || "").toLowerCase();

  return { vencimento, valor, link, qrcode_pix, barras, pdf, status_raw: statusRaw, status };
}
function parseDateAny(s) {
  const t = String(s || "").trim();
  if (!t) return null;

  // YYYY-MM-DD
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0));

  // DD/MM/YYYY
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (m) return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 0, 0, 0));

  // DD-MM-YYYY
  m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(t);
  if (m) return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 0, 0, 0));

  return null;
}
function boletoHasContent(b) {
  return Boolean((b.link || "").trim() || (b.qrcode_pix || "").trim() || (b.barras || "").trim() || (b.pdf || "").trim());
}
function isPendenteStatus(statusLower) {
  const s = String(statusLower || "");
  if (!s) return null; // desconhecido
  if (s.includes("baix")) return false;
  if (s.includes("pend")) return true;
  if (s.includes("abert")) return true;
  if (s.includes("pendente")) return true;
  return null;
}

/**
 * Regra:
 * - Considera apenas boletos "Pendente" (se status existir).
 * - Se houver vencidos: pega o vencido MAIS ANTIGO.
 * - Se não houver vencidos: pega o mais próximo (futuro mais próximo).
 * - Se status não existir, tenta por conteúdo + data.
 */
function pickBestPendenteBoletoFromDebitos(debitos) {
  if (!Array.isArray(debitos) || debitos.length === 0) return { boleto: null, overdueCount: 0, pendCount: 0 };

  const all = [];
  for (const d of debitos) {
    const lista = normalizeBoletoCollection(d?.boletos);
    for (const raw of lista) {
      const mapped = mapBoletoFields(raw);
      const dt = parseDateAny(mapped.vencimento);
      const statusFlag = isPendenteStatus(mapped.status);
      all.push({
        ...mapped,
        _dt: dt,
        _statusFlag: statusFlag, // true pendente / false baixado / null desconhecido
        debito_id: d?.id || "",
        nome: d?.nome || "",
      });
    }
  }

  if (all.length === 0) return { boleto: null, overdueCount: 0, pendCount: 0 };

  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));

  // 1) filtra pendentes quando possível
  const pendentes = all.filter((b) => b._statusFlag === true);
  const pendCount = pendentes.length;

  const base = pendCount > 0 ? pendentes : all.filter((b) => b._statusFlag !== false);

  // 2) só os que têm data (se tiver)
  const withDates = base.filter((b) => b._dt instanceof Date && !Number.isNaN(b._dt.getTime()));

  const working = withDates.length > 0 ? withDates : base;

  // 3) se tiver vencidos
  const overdue = working.filter((b) => b._dt && b._dt < todayUTC);
  if (overdue.length > 0) {
    overdue.sort((a, b) => a._dt - b._dt);
    const best = overdue.find(boletoHasContent) || overdue[0];
    return { boleto: best, overdueCount: overdue.length, pendCount };
  }

  // 4) sem vencidos -> futuro mais próximo
  const future = working.filter((b) => b._dt && b._dt >= todayUTC);
  if (future.length > 0) {
    future.sort((a, b) => a._dt - b._dt);
    const best = future.find(boletoHasContent) || future[0];
    return { boleto: best, overdueCount: 0, pendCount };
  }

  // 5) fallback: primeiro com conteúdo
  const any = working.find(boletoHasContent) || working[0];
  return { boleto: any, overdueCount: 0, pendCount };
}

// =====================
// Chatwoot auth helpers
// =====================
async function cwAuth({ force = false }) {
  const auth = await chatwootSignInIfNeeded({
    baseUrl: CHATWOOT_URL,
    email: CW_UID,
    password: CW_PASSWORD,
    force,
  });
  return buildAuthHeaders({ ...auth, uid: auth.uid || CW_UID });
}

async function cwGetConversationRetry({ conversationId, headers }) {
  try {
    return await getConversation({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers,
    });
  } catch (e) {
    console.warn("⚠️ getConversation falhou -> forçando reauth e retry", e?.message || e);
    const h2 = await cwAuth({ force: true });
    return await getConversation({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: h2,
    });
  }
}

async function cwSendMessageRetry({ conversationId, headers, content }) {
  try {
    return await sendMessage({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers,
      content,
    });
  } catch (e) {
    console.warn("⚠️ sendMessage falhou -> forçando reauth e retry", e?.message || e);
    const h2 = await cwAuth({ force: true });
    return await sendMessage({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: h2,
      content,
    });
  }
}

async function cwSetAttrsRetry({ conversationId, headers, attrs }) {
  try {
    return await setCustomAttributesMerge({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers,
      attrs,
    });
  } catch (e) {
    console.warn("⚠️ setCustomAttributes falhou -> forçando reauth e retry", e?.message || e);
    const h2 = await cwAuth({ force: true });
    return await setCustomAttributesMerge({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: h2,
      attrs,
    });
  }
}

async function cwAddLabelsMergeRetry({ conversationId, headers, labels }) {
  try {
    return await addLabels({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers,
      labels,
    });
  } catch (e) {
    console.warn("⚠️ addLabels falhou -> forçando reauth e retry", e?.message || e);
    const h2 = await cwAuth({ force: true });
    return await addLabels({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: h2,
      labels,
    });
  }
}

async function cwRemoveLabelRetry({ conversationId, headers, label }) {
  try {
    return await removeLabel({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers,
      label,
    });
  } catch (e) {
    console.warn("⚠️ removeLabel falhou -> forçando reauth e retry", e?.message || e);
    const h2 = await cwAuth({ force: true });
    return await removeLabel({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: h2,
      label,
    });
  }
}

async function cwDownloadAttachmentRetry({ headers, dataUrl }) {
  try {
    return await downloadAttachmentAsDataUrl({ baseUrl: CHATWOOT_URL, headers, dataUrl });
  } catch (e) {
    console.warn("⚠️ downloadAttachment falhou -> forçando reauth e retry", e?.message || e);
    const h2 = await cwAuth({ force: true });
    return await downloadAttachmentAsDataUrl({ baseUrl: CHATWOOT_URL, headers: h2, dataUrl });
  }
}

// =====================
// Finance helpers (mensagens copiáveis)
// =====================
async function financeSendBoletoPieces({ conversationId, headers, boleto }) {
  const venc = boleto?.vencimento || "";
  const valor = boleto?.valor;
  const link = (boleto?.link || "").trim();
  const pix = (boleto?.qrcode_pix || "").trim();
  const barras = (boleto?.barras || "").trim();
  const pdf = (boleto?.pdf || "").trim();

  const header = [];
  header.push("📄 *Boleto em aberto*");
  if (venc) header.push(`🗓️ *Vencimento:* ${venc}`);
  if (valor !== undefined && valor !== null && String(valor).trim() !== "") {
    header.push(`💰 *Valor:* R$ ${String(valor).replace(".", ",")}`);
  }
  await cwSendMessageRetry({ conversationId, headers, content: header.join("\n") });
  await sleep(250);

  if (link) {
    await cwSendMessageRetry({ conversationId, headers, content: `🔗 *Link do boleto:*\n${link}` });
    await sleep(250);
  }

  if (barras) {
    await cwSendMessageRetry({ conversationId, headers, content: `🏷️ *Código de barras:*\n${barras}` });
    await sleep(250);
  }

  if (pix) {
    const parts = chunkString(pix, 1200);
    if (parts.length === 1) {
      await cwSendMessageRetry({ conversationId, headers, content: `📌 *PIX copia e cola:*\n${parts[0]}` });
      await sleep(250);
    } else {
      await cwSendMessageRetry({
        conversationId,
        headers,
        content: `📌 *PIX copia e cola (parte 1/${parts.length}):*\n${parts[0]}`,
      });
      await sleep(250);
      for (let i = 1; i < parts.length; i++) {
        await cwSendMessageRetry({
          conversationId,
          headers,
          content: `📌 *PIX copia e cola (parte ${i + 1}/${parts.length}):*\n${parts[i]}`,
        });
        await sleep(250);
      }
    }
  }

  if (pdf) {
    await cwSendMessageRetry({ conversationId, headers, content: `📎 *PDF:*\n${pdf}` });
    await sleep(250);
  }

  // ✅ se o boleto veio "pendente" mas sem conteúdo, manda o portal pra garantir
  if (!link && !pix && !barras && !pdf) {
    await cwSendMessageRetry({
      conversationId,
      headers,
      content:
        "⚠️ Esse boleto veio sem link/PIX/código no retorno da API.\n" +
        "Para emitir agora, use o Portal do Assinante:\nhttps://i9net.centralassinante.com.br/",
    });
    await sleep(200);
  }
}

async function financeSendBoletoByDoc({ conversationId, headers, cpfcnpj, wa, silent = false }) {
  const waNorm = normalizePhoneBR(wa || "");

  const client = await rnFindClient({
    baseUrl: RECEITANET_BASE_URL,
    token: RECEITANET_TOKEN,
    app: RECEITANET_APP,
    cpfcnpj,
    phone: waNorm || "",
  });

  if (!client?.found) {
    if (!silent) {
      await cwSendMessageRetry({
        conversationId,
        headers,
        content:
          "Não consegui localizar esse CPF/CNPJ no sistema.\nMe envie o *CPF ou CNPJ do titular do contrato* (somente números), por favor.",
      });
    }
    return { ok: false, reason: "not_found" };
  }

  const idCliente = String(client?.data?.idCliente || "").trim();

  const range = buildDebitosDateRange();

  // ✅ status=2 (pendentes) + range
  let debitos = await rnListDebitos({
    baseUrl: RECEITANET_BASE_URL,
    token: RECEITANET_TOKEN,
    app: RECEITANET_APP,
    cpfcnpj,
    status: 2,
    data_inicio: range.data_inicio,
    data_fim: range.data_fim,
  });

  // fallback
  if (!Array.isArray(debitos) || debitos.length === 0) {
    debitos = await rnListDebitos({
      baseUrl: RECEITANET_BASE_URL,
      token: RECEITANET_TOKEN,
      app: RECEITANET_APP,
      cpfcnpj,
      status: 0,
      data_inicio: range.data_inicio,
      data_fim: range.data_fim,
    });
  }

  const list = Array.isArray(debitos) ? debitos : [];
  if (list.length === 0) {
    if (!silent) {
      await cwSendMessageRetry({
        conversationId,
        headers,
        content:
          "✅ Encontrei seu cadastro, mas *não consta boleto em aberto* no momento.\nSe você já pagou, pode enviar o *comprovante* aqui que eu confirmo.",
      });
    }
    return { ok: true, hasOpen: false, idCliente };
  }

  // ✅ picker robusto
  const picked = pickBestPendenteBoletoFromDebitos(list);
  const boleto = picked?.boleto || null;
  const overdueCount = picked?.overdueCount || 0;

  if (!boleto) {
    if (!silent) {
      await cwSendMessageRetry({
        conversationId,
        headers,
        content:
          "Encontrei débitos, mas não consegui montar o boleto automaticamente.\n" +
          "Para ver e emitir todos os boletos, acesse o Portal do Assinante:\nhttps://i9net.centralassinante.com.br/",
      });
    }
    return { ok: false, reason: "no_boleto", idCliente };
  }

  if (silent) return { ok: true, hasOpen: true, boleto, overdueCount, idCliente };

  await cwSendMessageRetry({
    conversationId,
    headers,
    content: "Perfeito 😊 Já localizei aqui.\nVou te enviar agora as informações do boleto (link / PIX / código de barras).",
  });
  await sleep(200);

  await financeSendBoletoPieces({ conversationId, headers, boleto });

  await cwSendMessageRetry({
    conversationId,
    headers,
    content: "Pode pagar pela opção que for mais prática pra você 🙂\n⚡ Pagando via *PIX*, a liberação costuma ser *imediata*.",
  });
  await sleep(200);

  await cwSendMessageRetry({
    conversationId,
    headers,
    content: "👉 Se você já realizou o pagamento, pode enviar o comprovante aqui. Vou validar o *mês correto* e agilizar! ✅",
  });

  if (overdueCount > 1) {
    await sleep(200);
    await cwSendMessageRetry({
      conversationId,
      headers,
      content:
        "⚠️ Identifiquei *mais de 1 boleto vencido*.\nPara ver e emitir todos os boletos, acesse o Portal do Assinante:\nhttps://i9net.centralassinante.com.br/",
    });
  }

  return { ok: true, hasOpen: true, boleto, overdueCount, idCliente };
}

// =====================
// Server
// =====================
export function startServer() {
  const app = express();
  app.use(express.json({ limit: "15mb" }));

  app.get("/", (_req, res) => res.send("🚀 Bot online"));

  app.post("/chatwoot-webhook", async (req, res) => {
    res.status(200).send("ok");

    try {
      if (!assertEnv()) return;
      if (!isIncomingMessage(req.body)) return;
      if (shouldIgnoreDuplicateEvent(req.body)) return;

      const conversationId = extractConversationId(req.body);
      if (!conversationId) return;

      const customerTextRaw = extractMessageText(req.body);
      const customerText = normalizeText(customerTextRaw);
      const attachments = extractAttachments(req.body);

      if (isSmsnetSystemMessage(customerText)) return;

      let cwHeaders = await cwAuth({ force: false });
      const conv = await cwGetConversationRetry({ conversationId, headers: cwHeaders });

      const labels = safeLabelList(conv);
      const labelSet = new Set(labels);

      const ca = conv?.custom_attributes || {};
      const state = ca.bot_state || "triage";
      const agent = ca.bot_agent || "isa";

      const waPayload = extractWhatsAppFromPayload(req.body) || normalizePhoneBR(ca.whatsapp_phone || "");
      const wa = normalizePhoneBR(waPayload || "");

      const gptOn = labelSet.has(LABEL_GPT_MANUAL);

      console.log("🔥 chegando", {
        conversationId,
        text: customerText || "(vazio)",
        anexos: attachments.length,
        state,
        agent,
        wa: wa || null,
        labels,
        gpt_on: gptOn,
        gpt_labels: {
          has_gpt_on: labelSet.has(LABEL_GPT_ON),
          has_gpt_manual: labelSet.has(LABEL_GPT_MANUAL),
        },
      });

      if (wa && wa !== normalizePhoneBR(ca.whatsapp_phone || "")) {
        await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { whatsapp_phone: wa } });
      }

      const lower = normalizeText(customerText).toLowerCase();

      // ============================
      // COMANDO: #gpt_on
      // ============================
      if (lower === "#gpt_on") {
        console.log("🟢 comando #gpt_on -> ativando GPT (manual)");

        await cwAddLabelsMergeRetry({
          conversationId,
          headers: cwHeaders,
          labels: [LABEL_GPT_ON, LABEL_GPT_MANUAL],
        });

        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { gpt_on: true, bot_state: "triage", bot_agent: "isa" },
        });

        const welcomeSent = labelSet.has(LABEL_WELCOME_SENT) || ca.welcome_sent === true;

        if (!welcomeSent) {
          await cwAddLabelsMergeRetry({
            conversationId,
            headers: cwHeaders,
            labels: [LABEL_WELCOME_SENT],
          });

          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { welcome_sent: true },
          });

          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "✅ Modo teste ativado. Vou te atender por aqui.",
          });

          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content:
              "Oi! Eu sou a *Isa*, da i9NET. 😊\nMe diga o que você precisa:\n1) *Sem internet / suporte*\n2) *Financeiro (boleto/2ª via/pagamento)*\n3) *Planos/contratar*\n\n(Se preferir, escreva: “sem internet”, “boleto”, “planos”…)",
          });
        }

        return;
      }

      // ============================
      // COMANDO: #gpt_off
      // ============================
      if (lower === "#gpt_off") {
        console.log("🔴 comando #gpt_off -> desativando GPT");

        await cwRemoveLabelRetry({ conversationId, headers: cwHeaders, label: LABEL_GPT_ON });
        await cwRemoveLabelRetry({ conversationId, headers: cwHeaders, label: LABEL_GPT_MANUAL });

        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: {
            gpt_on: false,
            bot_state: "triage",
            bot_agent: "isa",
            finance_need: null,
            last_cpfcnpj: null,
            last_receipt_json: null,
            last_receipt_ts: null,
          },
        });

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content: "✅ Modo teste desativado. Voltando para o atendimento padrão do menu.",
        });

        return;
      }

      // limpeza opcional
      if (labelSet.has(LABEL_GPT_ON) && !labelSet.has(LABEL_GPT_MANUAL)) {
        await cwRemoveLabelRetry({ conversationId, headers: cwHeaders, label: LABEL_GPT_ON });
      }

      if (!gptOn) return;

      // ============================
      // ANEXO (imagem/pdf)
      // ============================
      if (attachments.length > 0) {
        const att = pickFirstAttachment(attachments);
        const dataUrl = att?.data_url || att?.dataUrl || null;
        const fileType = att?.file_type || att?.tipo_de_arquivo || "unknown";

        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: {
            bot_agent: "cassia",
            bot_state: "finance_wait_doc",
            last_attachment_url: dataUrl || "",
            last_attachment_type: fileType,
          },
        });

        if (dataUrl) {
          const dl = await cwDownloadAttachmentRetry({ headers: cwHeaders, dataUrl });

          console.log("📎 anexo baixado", {
            ok: dl.ok,
            status: dl.status,
            bytes: dl.bytes,
            contentType: dl.contentType,
          });

          if (dl.ok && dl.bytes <= 4 * 1024 * 1024 && (dl.contentType || "").startsWith("image/")) {
            const analysis = await openaiAnalyzeImage({
              apiKey: OPENAI_API_KEY,
              model: OPENAI_MODEL,
              imageDataUrl: dl.dataUri,
            });

            console.log("🧾 comprovante extraído (parcial)", {
              has: !!analysis,
              amount: analysis?.amount,
              date: analysis?.date,
              hasLine: !!analysis?.barcode_or_line,
            });

            await cwSetAttrsRetry({
              conversationId,
              headers: cwHeaders,
              attrs: { last_receipt_json: analysis || null, last_receipt_ts: Date.now() },
            });

            await cwSendMessageRetry({
              conversationId,
              headers: cwHeaders,
              content:
                "📎 *Recebi seu comprovante.*\n" +
                (analysis?.summaryText || "Consegui ler o comprovante.") +
                "\n\nPara eu conferir se foi o *mês correto* no sistema, me envie o *CPF ou CNPJ do titular* (somente números).",
            });

            return;
          }
        }

        if (!customerText) {
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "📎 Recebi seu arquivo. Me envie o *CPF ou CNPJ do titular* (somente números) para eu localizar no sistema.",
          });
          return;
        }
      }

      if (!customerText && attachments.length === 0) return;

      // ============================
      // TRIAGEM (Isa)
      // ============================
      const numericChoice = mapNumericChoice(customerText);
      const intent = detectIntent(customerText, numericChoice);

      if (state === "triage") {
        if (intent === "support") {
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_agent: "anderson", bot_state: "support_check" },
          });
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "Certo! Eu sou o *Anderson*, do suporte. 👍\nVocê está *sem internet* agora ou está *lento/instável*?",
          });
          return;
        }

        if (intent === "finance") {
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_agent: "cassia", bot_state: "finance_wait_need" },
          });
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content:
              "Oi! Eu sou a *Cassia*, do financeiro. 💳\nVocê precisa de:\n1) *Boleto/2ª via*\n2) *Informar pagamento / validar comprovante*\n\n(Responda 1/2 ou escreva “boleto” / “paguei”)",
          });
          return;
        }

        if (intent === "sales") {
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_agent: "isa", bot_state: "sales_flow" },
          });
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "Perfeito! Me diga seu *bairro* e *cidade* para eu te informar cobertura e planos. 😊",
          });
          return;
        }

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content: "Só para eu te direcionar certinho:\n1) *Sem internet / suporte*\n2) *Financeiro (boleto/pagamento)*\n3) *Planos/contratar*",
        });
        return;
      }

      // ============================
      // SUPORTE (Anderson) - engine
      // ============================
      const runSupportCheck = async ({ cpfOverride = null, cameFromCpfStep = false } = {}) => {
        const cpfDigits = cpfOverride || extractCpfCnpjDigits(customerText);

        // 1) tenta localizar por WhatsApp primeiro
        let client = null;
        if (wa) {
          try {
            client = await rnFindClient({
              baseUrl: RECEITANET_BASE_URL,
              token: RECEITANET_TOKEN,
              app: RECEITANET_APP,
              phone: wa,
            });
          } catch (e) {
            console.warn("⚠️ rnFindClient por phone falhou", e?.message || e);
          }
        }

        if (client?.found && !cameFromCpfStep) {
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "✅ Local
