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
  addLabels,
  setCustomAttributesMerge,
  buildAuthHeaders,
  downloadAttachmentAsDataUrl,
} from "./lib/chatwoot.js";

import {
  rnFindClient,
  rnListDebitos,
  rnVerificarAcesso,
  pickBestOverdueBoleto,
  rnNotificacaoPagamento,
} from "./lib/receitanet.js";

import { openaiAnalyzeImage, openaiChat } from "./lib/openai.js";

const PORT = process.env.PORT || 10000;

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = String(process.env.CHATWOOT_ACCOUNT_ID || "");
const CW_UID = process.env.CW_UID || "";
const CW_PASSWORD = process.env.CW_PASSWORD || "";

const RECEITANET_BASE_URL = (process.env.RECEITANET_BASE_URL || "https://sistema.receitanet.net/api/novo/chatbot").replace(/\/+$/, "");
const RECEITANET_TOKEN = process.env.RECEITANET_TOKEN || process.env.RECEITANET_CHATBOT_TOKEN || "";
const RECEITANET_APP = process.env.RECEITANET_APP || "chatbot";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

const LABEL_GPT_ON = "gpt_on";
const LABEL_WELCOME_SENT = "gpt_welcome_sent";

const AUTO_GPT_THRESHOLD = Number(process.env.AUTO_GPT_THRESHOLD || 3); // permanece, mas NÃO ativa automaticamente

// =====================
// Helpers
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
function amountsClose(a, b, tol = 0.1) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tol;
}

function receiptMatchesBoleto({ analysis, boleto }) {
  const boletoLine = normalizeDigits(boleto?.barras || "");
  const recLine = normalizeDigits(analysis?.barcode_or_line || "");
  const strong = boletoLine && recLine && boletoLine === recLine;

  const boletoAmount = parseMoneyToNumber(boleto?.valor);
  const paidAmount = parseMoneyToNumber(analysis?.amount);
  const amountOk = amountsClose(paidAmount, boletoAmount, 0.2);

  const hasDate = Boolean(String(analysis?.date || "").trim());
  const medium = amountOk && hasDate;

  // PIX: se tiver pix_key no comprovante e o boleto tiver qrcode_pix, tenta conter um no outro
  const pixKey = String(analysis?.pix_key || "").trim();
  const boletoPix = String(boleto?.qrcode_pix || "").trim();
  const pixOk =
    pixKey && boletoPix
      ? normalizeText(boletoPix).toLowerCase().includes(normalizeText(pixKey).toLowerCase()) ||
        normalizeText(pixKey).toLowerCase().includes(normalizeText(boletoPix).toLowerCase())
      : false;

  return {
    ok: strong || pixOk || medium,
    level: strong ? "strong" : pixOk ? "pix" : medium ? "medium" : "none",
    amountOk,
    pixOk,
    strong,
    boletoAmount,
    paidAmount,
    boletoLineLen: boletoLine.length,
    recLineLen: recLine.length,
  };
}

function is401(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("(401)") || msg.includes(" 401 ") || msg.includes("failed (401)") || msg.includes('status":401');
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

function safeLabelList(conv) {
  return (conv?.labels || []).map((x) => (typeof x === "string" ? x : x?.title)).filter(Boolean);
}

async function addLabelsMerged({ currentLabels, labelsToAdd, cw }) {
  const merged = Array.from(new Set([...(currentLabels || []), ...(labelsToAdd || [])]));
  await addLabels({
    baseUrl: cw.baseUrl,
    accountId: cw.accountId,
    conversationId: cw.conversationId,
    headers: cw.headers,
    labels: merged,
  });
  return merged;
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

function chunkString(str, maxLen = 1100) {
  const s = String(str || "");
  if (!s) return [];
  const parts = [];
  for (let i = 0; i < s.length; i += maxLen) parts.push(s.slice(i, i + maxLen));
  return parts;
}

// Ignora mensagens automáticas SMSNET
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

// =====================
// Chatwoot Retry Wrappers (401)
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
    return await getConversation({ baseUrl: CHATWOOT_URL, accountId: CHATWOOT_ACCOUNT_ID, conversationId, headers });
  } catch (e) {
    if (!is401(e)) throw e;
    console.warn("🔁 401 no getConversation -> renovando token e retry");
    const h2 = await cwAuth({ force: true });
    return await getConversation({ baseUrl: CHATWOOT_URL, accountId: CHATWOOT_ACCOUNT_ID, conversationId, headers: h2 });
  }
}

async function cwSendMessageRetry({ conversationId, headers, content }) {
  try {
    return await sendMessage({ baseUrl: CHATWOOT_URL, accountId: CHATWOOT_ACCOUNT_ID, conversationId, headers, content });
  } catch (e) {
    if (!is401(e)) throw e;
    console.warn("🔁 401 no sendMessage -> renovando token e retry");
    const h2 = await cwAuth({ force: true });
    return await sendMessage({ baseUrl: CHATWOOT_URL, accountId: CHATWOOT_ACCOUNT_ID, conversationId, headers: h2, content });
  }
}

async function cwSetAttrsRetry({ conversationId, headers, attrs }) {
  try {
    return await setCustomAttributesMerge({ baseUrl: CHATWOOT_URL, accountId: CHATWOOT_ACCOUNT_ID, conversationId, headers, attrs });
  } catch (e) {
    if (!is401(e)) throw e;
    console.warn("🔁 401 no setCustomAttributes -> renovando token e retry");
    const h2 = await cwAuth({ force: true });
    return await setCustomAttributesMerge({ baseUrl: CHATWOOT_URL, accountId: CHATWOOT_ACCOUNT_ID, conversationId, headers: h2, attrs });
  }
}

async function cwAddLabelsRetry({ conversationId, headers, currentLabels, labelsToAdd }) {
  try {
    return await addLabelsMerged({ currentLabels, labelsToAdd, cw: { baseUrl: CHATWOOT_URL, accountId: CHATWOOT_ACCOUNT_ID, conversationId, headers } });
  } catch (e) {
    if (!is401(e)) throw e;
    console.warn("🔁 401 no addLabels -> renovando token e retry");
    const h2 = await cwAuth({ force: true });
    return await addLabelsMerged({ currentLabels, labelsToAdd, cw: { baseUrl: CHATWOOT_URL, accountId: CHATWOOT_ACCOUNT_ID, conversationId, headers: h2 } });
  }
}

async function cwDownloadAttachmentRetry({ headers, dataUrl }) {
  try {
    return await downloadAttachmentAsDataUrl({ baseUrl: CHATWOOT_URL, headers, dataUrl });
  } catch (e) {
    if (!is401(e)) throw e;
    console.warn("🔁 401 no downloadAttachment -> renovando token e retry");
    const h2 = await cwAuth({ force: true });
    return await downloadAttachmentAsDataUrl({ baseUrl: CHATWOOT_URL, headers: h2, dataUrl });
  }
}

// =====================
// Finance helpers
// =====================
async function financeSendBoletoPieces({ conversationId, headers, boleto, overdueCount = 0 }) {
  const venc = boleto?.vencimento || "";
  const valor = boleto?.valor;
  const link = boleto?.link || "";
  const pix = boleto?.qrcode_pix || "";
  const barras = boleto?.barras || "";
  const pdf = boleto?.pdf || "";

  // 1) cartão resumido
  const header = [];
  header.push("📄 *Boleto em aberto*");
  if (venc) header.push(`🗓️ *Vencimento:* ${venc}`);
  if (valor !== undefined && valor !== null && String(valor).trim() !== "") header.push(`💰 *Valor:* R$ ${String(valor).replace(".", ",")}`);
  await cwSendMessageRetry({ conversationId, headers, content: header.join("\n") });

  // 2) LINK (título -> valor sozinho)
  if (link) {
    await cwSendMessageRetry({ conversationId, headers, content: "🔗 *Link do boleto:*" });
    await cwSendMessageRetry({ conversationId, headers, content: String(link) });
  }

  // 3) CÓDIGO DE BARRAS (título -> valor sozinho)
  if (barras) {
    await cwSendMessageRetry({ conversationId, headers, content: "🏷️ *Código de barras:*" });
    await cwSendMessageRetry({ conversationId, headers, content: String(barras) });
  }

  // 4) PIX (título -> partes só do PIX)
  if (pix) {
    await cwSendMessageRetry({ conversationId, headers, content: "📌 *PIX copia e cola:*" });
    const parts = chunkString(pix, 1100);
    for (const p of parts) {
      await cwSendMessageRetry({ conversationId, headers, content: p });
    }
  }

  // 5) PDF (título -> valor sozinho)
  if (pdf) {
    await cwSendMessageRetry({ conversationId, headers, content: "📎 *PDF:*" });
    await cwSendMessageRetry({ conversationId, headers, content: String(pdf) });
  }

  // 6) Mensagens finais (sempre no final)
  await cwSendMessageRetry({
    conversationId,
    headers,
    content: "Pode pagar pela opção que for mais prática pra você 🙂\n⚡ Pagando via *PIX*, a liberação costuma ser imediata.",
  });

  await cwSendMessageRetry({
    conversationId,
    headers,
    content:
      "👉 Se você já realizou o pagamento, pode enviar o comprovante aqui. Vou analisar a imagem ou PDF pra confirmar que é esse boleto e agilizar a liberação! ✅",
  });

  // 7) Portal (somente no fim, depois do “Pode pagar…”)
  if (Number(overdueCount || 0) > 1) {
    await cwSendMessageRetry({
      conversationId,
      headers,
      content:
        "⚠️ Identifiquei mais de 1 boleto vencido.\n" +
        "Para ver e emitir todos os boletos, acesse o *Portal do Assinante*:\n" +
        "https://i9net.centralassinante.com.br/",
    });
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

  if (!client.found) {
    if (!silent) {
      await cwSendMessageRetry({
        conversationId,
        headers,
        content: "Não consegui localizar esse CPF/CNPJ no sistema.\nMe envie o *CPF ou CNPJ do titular do contrato* (somente números), por favor.",
      });
    }
    await cwSetAttrsRetry({ conversationId, headers, attrs: { bot_state: "finance_wait_doc", bot_agent: "cassia", last_cpfcnpj: "" } });
    return { ok: false, reason: "not_found" };
  }