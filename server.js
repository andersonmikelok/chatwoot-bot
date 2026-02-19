// server.js
// BUILD_ID: fix3-2026-02-19T22:30Z
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
  removeLabel,
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

// ✅ compat: suporta openai.js com named exports e/ou default export
import openaiDefault, {
  openaiAnalyzeImage,
  openaiChat,
  openaiClassifyImage,
  openaiAnalyzeNetworkEquipment,
} from "./lib/openai.js";

const openaiAnalyzeImageFn = openaiAnalyzeImage || openaiDefault?.openaiAnalyzeImage;
const openaiChatFn = openaiChat || openaiDefault?.openaiChat;
const openaiClassifyImageFn = openaiClassifyImage || openaiDefault?.openaiClassifyImage;
const openaiAnalyzeNetworkEquipmentFn =
  openaiAnalyzeNetworkEquipment || openaiDefault?.openaiAnalyzeNetworkEquipment;

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
const LABEL_NEED_HUMAN = "need_human";

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
    t.includes("depositei") ||
    t.includes("validar")
  );
}
function isBoletoIntent(text) {
  const t = normalizeText(text).toLowerCase();
  return (
    t.includes("boleto") ||
    t.includes("2ª") ||
    t.includes("2a") ||
    t.includes("2 via") ||
    t.includes("segunda via") ||
    t.includes("fatura") ||
    t.includes("mensalidade")
  );
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

function getSavedDocFromCA(ca) {
  const d = onlyDigits(String(ca?.cpfcnpj || ca?.last_cpfcnpj || ""));
  if (d.length === 11 || d.length === 14) return d;
  return "";
}

// ✅ override de intenção: cliente fala “sem internet” e o bot estava preso em financeiro/pedindo doc
function detectSupportOverride(text) {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  return (
    t.includes("sem internet") ||
    t.includes("sem conexão") ||
    t.includes("sem conexao") ||
    t.includes("sem sinal") ||
    t.includes("caiu") ||
    t.includes("não conecta") ||
    t.includes("nao conecta") ||
    t.includes("lento") ||
    t.includes("instavel") ||
    t.includes("instável")
  );
}

// ✅ anti-repetição de prompts (evita loop de “envie CPF”)
function shouldSendPrompt(ca, key, windowMs = 45000) {
  const lastKey = String(ca?.last_prompt_key || "");
  const lastTs = Number(ca?.last_prompt_ts || 0);
  const now = Date.now();
  if (lastKey === key && lastTs && now - lastTs < windowMs) return false;
  return true;
}
async function markPromptSent({ conversationId, headers, key }) {
  await cwSetAttrsRetry({
    conversationId,
    headers,
    attrs: { last_prompt_key: key, last_prompt_ts: Date.now() },
  });
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
// ✅ FILAS (processamento e envio)
// =====================
const processQueues = new Map();
function enqueueProcess(conversationId, fn) {
  const key = String(conversationId);
  const prev = processQueues.get(key) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(fn)
    .finally(() => {
      if (processQueues.get(key) === next) processQueues.delete(key);
    });
  processQueues.set(key, next);
  return next;
}

const sendQueues = new Map();
function enqueueSend(conversationId, fn) {
  const key = String(conversationId);
  const prev = sendQueues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  sendQueues.set(key, next);
  return next;
}

async function sendOrdered({ conversationId, headers, content, delayMs = 1200 }) {
  return enqueueSend(conversationId, async () => {
    await cwSendMessageRetry({ conversationId, headers, content });
    if (delayMs) await sleep(delayMs);
  });
}

// =====================
// Finance helpers (copiável + ORDEM)
// =====================
const INSTR_COPY_BAR = "🏷️ *Código de barras*";
const INSTR_COPY_PIX = "📌 *PIX copia e cola*";

async function financeSendBoletoPieces({ conversationId, headers, boleto, prefaceText = "" }) {
  const venc = boleto?.vencimento || "";
  const valor = boleto?.valor;
  const link = (boleto?.link || "").trim();
  const pix = (boleto?.qrcode_pix || "").trim();
  const barras = (boleto?.barras || "").trim();
  const pdf = (boleto?.pdf || "").trim();

  if (prefaceText) await sendOrdered({ conversationId, headers, content: prefaceText, delayMs: 1500 });

  const header = [];
  header.push("📄 *Boleto em aberto*");
  if (venc) header.push(`🗓️ *Vencimento:* ${venc}`);
  if (valor !== undefined && valor !== null && String(valor).trim() !== "") {
    header.push(`💰 *Valor:* R$ ${String(valor).replace(".", ",")}`);
  }
  await sendOrdered({ conversationId, headers, content: header.join("\n"), delayMs: 1500 });

  if (barras) {
    await sendOrdered({ conversationId, headers, content: INSTR_COPY_BAR, delayMs: 1200 });
    await sendOrdered({ conversationId, headers, content: barras, delayMs: 1500 });
  }

  if (pix) {
    await sendOrdered({ conversationId, headers, content: INSTR_COPY_PIX, delayMs: 1200 });
    const parts = chunkString(pix, 1100);
    for (const part of parts) await sendOrdered({ conversationId, headers, content: part, delayMs: 1500 });
  }

  if (pdf) await sendOrdered({ conversationId, headers, content: `📎 *PDF:*\n${pdf}`, delayMs: 1200 });

  if (link) {
    const safeLink = link.replace("https://", "https://\u200B"); // quebra preview do WhatsApp
    await sendOrdered({
      conversationId,
      headers,
      content: `🔗 *Link do boleto (copie e cole no navegador):*\n${safeLink}`,
      delayMs: 1600,
    });
  }
}

async function financeSendBoletoByDoc({ conversationId, headers, cpfcnpj, wa, silent = false, skipPreface = false }) {
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
      await sendOrdered({
        conversationId,
        headers,
        content: "Não consegui localizar esse CPF/CNPJ no sistema.\nMe envie o *CPF ou CNPJ do titular* (somente números), por favor.",
      });
    }
    return { ok: false, reason: "not_found" };
  }

  const idCliente = String(client?.data?.idCliente || "").trim();

  let debitos = [];
  try {
    debitos = await rnListDebitos({
      baseUrl: RECEITANET_BASE_URL,
      token: RECEITANET_TOKEN,
      app: RECEITANET_APP,
      cpfcnpj,
      status: 2,
      page: 1,
    });
  } catch {
    debitos = [];
  }

  if (!Array.isArray(debitos) || debitos.length === 0) {
    try {
      debitos = await rnListDebitos({
        baseUrl: RECEITANET_BASE_URL,
        token: RECEITANET_TOKEN,
        app: RECEITANET_APP,
        cpfcnpj,
        status: 0,
        page: 1,
      });
    } catch {
      debitos = [];
    }
  }

  const list = Array.isArray(debitos) ? debitos : [];
  if (list.length === 0) {
    if (!silent) {
      await sendOrdered({
        conversationId,
        headers,
        content:
          "✅ Encontrei seu cadastro, mas *não consta boleto em aberto* no momento.\nSe você já pagou, envie o *comprovante* aqui que eu confirmo.",
      });
    }
    return { ok: true, hasOpen: false, idCliente };
  }

  const { boleto, overdueCount } = pickBestOverdueBoleto(list);

  if (!boleto) {
    if (!silent) {
      await sendOrdered({
        conversationId,
        headers,
        content: "Encontrei débitos, mas não consegui montar o boleto automaticamente.\nVocê quer *2ª via do boleto* ou *validar pagamento*?",
      });
    }
    return { ok: false, reason: "no_boleto", idCliente };
  }

  if (silent) return { ok: true, hasOpen: true, boleto, overdueCount, idCliente };

  const preface = skipPreface
    ? ""
    : "Perfeito 😊 Já localizei aqui.\nVou te enviar agora as informações do boleto (código de barras / PIX / link).";

  await financeSendBoletoPieces({ conversationId, headers, boleto, prefaceText: preface });

  await sendOrdered({
    conversationId,
    headers,
    content: "Pode pagar pela opção que for mais prática pra você 🙂\n⚡ Pagando via *PIX*, a liberação costuma ser *imediata*.",
    delayMs: 1200,
  });

  await sendOrdered({
    conversationId,
    headers,
    content: "👉 Se você já realizou o pagamento, pode enviar o comprovante aqui. Vou validar o *mês correto* e agilizar! ✅",
    delayMs: 1200,
  });

  if (overdueCount > 1) {
    await sendOrdered({
      conversationId,
      headers,
      content:
        "⚠️ Identifiquei *mais de 1 boleto vencido*.\nPara ver e emitir todos os boletos, acesse o Portal do Assinante:\nhttps://i9net.centralassinante.com.br/",
      delayMs: 1200,
    });
  }

  return { ok: true, hasOpen: true, boleto, overdueCount, idCliente };
}

// =====================
// SUPORTE (fluxo unificado)
// =====================
async function runSupportCheck({ conversationId, headers, ca, wa, customerText }) {
  const cpfDigits = extractCpfCnpjDigits(customerText);

  let client = null;

  // 1) tenta por WhatsApp primeiro
  if (wa) {
    try {
      client = await rnFindClient({
        baseUrl: RECEITANET_BASE_URL,
        token: RECEITANET_TOKEN,
        app: RECEITANET_APP,
        phone: wa,
      });
    } catch {
      client = null;
    }
  }

  // 2) se não achou e veio CPF/CNPJ, tenta por doc e salva
  if ((!client || !client.found) && cpfDigits) {
    try {
      client = await rnFindClient({
        baseUrl: RECEITANET_BASE_URL,
        token: RECEITANET_TOKEN,
        app: RECEITANET_APP,
        cpfcnpj: cpfDigits,
      });
    } catch {
      client = null;
    }
    await cwSetAttrsRetry({ conversationId, headers, attrs: { cpfcnpj: cpfDigits, last_cpfcnpj: cpfDigits } });
  }

  // 3) se ainda não achou, pede CPF/CNPJ (anti-spam)
  if (!client?.found) {
    await cwSetAttrsRetry({ conversationId, headers, attrs: { bot_state: "support_need_doc", bot_agent: "anderson" } });

    if (shouldSendPrompt(ca, "support_need_doc", 45000)) {
      await sendOrdered({
        conversationId,
        headers,
        content: "Não consegui localizar seu cadastro pelo WhatsApp.\nMe envie o *CPF ou CNPJ do titular* (somente números), por favor.",
        delayMs: 1200,
      });
      await markPromptSent({ conversationId, headers, key: "support_need_doc" });
    }
    return;
  }

  await sendOrdered({
    conversationId,
    headers,
    content: "Perfeito. Localizei seu cadastro. Vou verificar seu acesso agora. ✅",
    delayMs: 1200,
  });

  const cpfUse = onlyDigits(String(client?.data?.cpfCnpj || client?.data?.cpfcnpj || ca.cpfcnpj || ""));
  const idCliente = String(client?.data?.idCliente || "").trim();

  // 4) verifica bloqueio no endpoint de acesso (se possível)
  let blockedByAcesso = false;
  if (idCliente && wa) {
    try {
      const acesso = await rnVerificarAcesso({
        baseUrl: RECEITANET_BASE_URL,
        token: RECEITANET_TOKEN,
        app: RECEITANET_APP,
        idCliente,
        contato: wa,
      });
      const a = acesso?.data || {};
      blockedByAcesso =
        a?.bloqueado === true ||
        a?.liberado === false ||
        String(a?.situacao || "").toLowerCase().includes("bloque") ||
        String(a?.status || "").toLowerCase().includes("bloque");
    } catch {}
  }

  // 5) pendências financeiras
  let debitos = [];
  try {
    debitos = await rnListDebitos({
      baseUrl: RECEITANET_BASE_URL,
      token: RECEITANET_TOKEN,
      app: RECEITANET_APP,
      cpfcnpj: cpfUse,
      status: 2,
      page: 1,
    });
  } catch {
    debitos = [];
  }

  if (!Array.isArray(debitos) || debitos.length === 0) {
    try {
      debitos = await rnListDebitos({
        baseUrl: RECEITANET_BASE_URL,
        token: RECEITANET_TOKEN,
        app: RECEITANET_APP,
        cpfcnpj: cpfUse,
        status: 0,
        page: 1,
      });
    } catch {
      debitos = [];
    }
  }

  const list = Array.isArray(debitos) ? debitos : [];
  const { boleto: overdueBoleto } = pickBestOverdueBoleto(list);

  const hasPendencia = Boolean(overdueBoleto);
  const blocked = blockedByAcesso || hasPendencia;

  if (blocked) {
    // ✅ joga pro financeiro SEM perder o CPF (salva + muda estado)
    await cwSetAttrsRetry({
      conversationId,
      headers,
      attrs: { bot_agent: "cassia", bot_state: "finance_wait_need", cpfcnpj: cpfUse, last_cpfcnpj: cpfUse, finance_need: "boleto" },
    });

    await sendOrdered({
      conversationId,
      headers,
      content: "Identifiquei aqui *bloqueio/pendência financeira* no seu cadastro.\nVou te enviar agora as opções pra regularizar. 👇",
      delayMs: 1200,
    });

    await financeSendBoletoByDoc({ conversationId, headers, cpfcnpj: cpfUse, wa, silent: false, skipPreface: true });
    return;
  }

  await cwSetAttrsRetry({ conversationId, headers, attrs: { bot_state: "support_wait_feedback", bot_agent: "anderson" } });

  await sendOrdered({
    conversationId,
    headers,
    content:
      "No sistema não aparece bloqueio agora.\nVamos fazer um teste rápido:\n" +
      "1) Desligue a ONU/roteador por *2 minutos*\n" +
      "2) Ligue novamente\n" +
      "3) Aguarde *2 minutos*\n\nDepois me diga: voltou?",
    delayMs: 1200,
  });
}

// =====================
// ✅ Comprovante: resolver doc sem pedir de novo
// =====================
async function resolveDocForReceipt({ ca, wa, analysis }) {
  // 1) salvo na conversa
  const saved = getSavedDocFromCA(ca);
  if (saved) return saved;

  // 2) extraído do comprovante (se existir)
  const fromReceipt = onlyDigits(String(analysis?.payer_doc || ""));
  if (fromReceipt.length === 11 || fromReceipt.length === 14) return fromReceipt;

  // 3) buscar no ReceitaNet pelo WhatsApp
  if (wa) {
    try {
      const client = await rnFindClient({
        baseUrl: RECEITANET_BASE_URL,
        token: RECEITANET_TOKEN,
        app: RECEITANET_APP,
        phone: wa,
      });
      if (client?.found) {
        const doc = onlyDigits(String(client?.data?.cpfCnpj || client?.data?.cpfcnpj || ""));
        if (doc.length === 11 || doc.length === 14) return doc;
      }
    } catch {}
  }

  return "";
}

async function markNeedHuman({ conversationId, headers, reason }) {
  // marca para humano (sua automação do Chatwoot faz o "atribuir ao agente")
  await cwAddLabelsMergeRetry({ conversationId, headers, labels: [LABEL_NEED_HUMAN] });

  await cwSetAttrsRetry({
    conversationId,
    headers,
    attrs: { bot_state: "human_needed", bot_agent: "cassia", human_reason: reason || "manual_check" },
  });

  // 1) mensagem neutra (IA)
  await sendOrdered({
    conversationId,
    headers,
    content: "⚠️ *Sou uma atendente virtual (IA).* Não consegui confirmar o pagamento com segurança.",
    delayMs: 900,
  });

  // define setor sem citar pessoa (opcional, mas melhora)
  const sector =
    String(reason || "").includes("receipt") || String(reason || "").includes("boleto")
      ? "Financeiro"
      : "Atendimento";

  // 2) mensagem de handoff (humano) — padrão solicitado
  await sendOrdered({
    conversationId,
    headers,
    content:
      `✅ Já encaminhei para o *time humano* (${sector}).\n\n` +
      "você acabou de entrar em nossa fila de atendimento.\n" +
      "Em breve um de nossos colaboradores irá te atender, por favor aguarde....",
    delayMs: 1200,
  });
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

      enqueueProcess(conversationId, async () => {
        try {
          const customerTextRaw = extractMessageText(req.body);
          const customerText = normalizeText(customerTextRaw);
          const attachments = extractAttachments(req.body);

          if (isSmsnetSystemMessage(customerText)) return;

          let cwHeaders = await cwAuth({ force: false });
          const convRes = await cwGetConversationRetry({ conversationId, headers: cwHeaders });
          const conv = convRes?.body || convRes;

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
          });

          if (wa && wa !== normalizePhoneBR(ca.whatsapp_phone || "")) {
            await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { whatsapp_phone: wa } });
          }

          const lower = normalizeText(customerText).toLowerCase();

          // ============================
          // #gpt_on
          // ============================
          if (lower === "#gpt_on") {
            await cwAddLabelsMergeRetry({ conversationId, headers: cwHeaders, labels: [LABEL_GPT_ON, LABEL_GPT_MANUAL] });
            await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { gpt_on: true, bot_state: "triage", bot_agent: "isa" } });

            const welcomeSent = labelSet.has(LABEL_WELCOME_SENT) || ca.welcome_sent === true;
            if (!welcomeSent) {
              await cwAddLabelsMergeRetry({ conversationId, headers: cwHeaders, labels: [LABEL_WELCOME_SENT] });
              await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { welcome_sent: true } });

              await sendOrdered({
                conversationId,
                headers: cwHeaders,
                content: "✅ *Atendimento por IA ativado.* Eu sou a *Isa* (IA) da i9NET. 😊",
                delayMs: 1200,
              });

              await sendOrdered({
                conversationId,
                headers: cwHeaders,
                content:
                  "Me diga o que você precisa:\n" +
                  "1) *Sem internet / suporte*\n" +
                  "2) *Financeiro (boleto/2ª via/pagamento)*\n" +
                  "3) *Planos/contratar*\n\n" +
                  "(Se preferir, escreva: “sem internet”, “boleto”, “planos”…)",
                delayMs: 1200,
              });
            }
            return;
          }

          // ============================
          // #gpt_off
          // ============================
          if (lower === "#gpt_off") {
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
              },
            });

            await sendOrdered({
              conversationId,
              headers: cwHeaders,
              content: "✅ Modo IA desativado. Voltando para o atendimento padrão.",
              delayMs: 1200,
            });
            return;
          }

          // GPT OFF
          if (!gptOn) return;

          // ============================
          // ✅ Sempre que receber CPF/CNPJ em texto: salvar
          // ============================
          const docInText = extractCpfCnpjDigits(customerText);
          if (docInText) {
            await cwSetAttrsRetry({
              conversationId,
              headers: cwHeaders,
              attrs: { cpfcnpj: docInText, last_cpfcnpj: docInText },
            });
          }

          // ============================
          // ✅ OVERRIDE DE SUPORTE (evita travar em “envie CPF”)
          // ============================
          if (detectSupportOverride(customerText)) {
            if (state !== "support_check" && state !== "triage") {
              await cwSetAttrsRetry({
                conversationId,
                headers: cwHeaders,
                attrs: { bot_state: "support_check", bot_agent: "anderson", finance_need: null },
              });
            }
          }

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
    attrs: { bot_agent: "cassia", last_attachment_url: dataUrl || "", last_attachment_type: fileType },
  });

  let dl = null;
  if (dataUrl) {
    dl = await cwDownloadAttachmentRetry({ headers: cwHeaders, dataUrl });
    console.log("📎 anexo baixado", {
      ok: dl?.ok,
      status: dl?.status,
      bytes: dl?.bytes,
      contentType: dl?.contentType,
    });
  }

  // ✅ imagem -> primeiro classifica (comprovante vs equipamento)
  if (dl?.ok && dl.bytes <= 4 * 1024 * 1024 && (dl.contentType || "").startsWith("image/")) {
    const classification = await (openaiClassifyImageFn
      ? openaiClassifyImageFn({ apiKey: OPENAI_API_KEY, model: OPENAI_MODEL, imageDataUrl: dl.dataUri })
      : Promise.resolve(null));

    const imgType = String(classification?.type || "other");

    await cwSetAttrsRetry({
      conversationId,
      headers: cwHeaders,
      attrs: { last_image_type: imgType, last_image_conf: classification?.confidence ?? null },
    });

    // =========================
    // FOTO DE EQUIPAMENTO (NOC)
    // =========================
    if (imgType === "network_equipment") {
      if (ca.bot_state === "triage") {
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_agent: "anderson", bot_state: "support_noc_photo" },
        });
      }

      const equip = await (openaiAnalyzeNetworkEquipmentFn
        ? openaiAnalyzeNetworkEquipmentFn({
            apiKey: OPENAI_API_KEY,
            model: OPENAI_MODEL,
            imageDataUrl: dl.dataUri,
          })
        : Promise.resolve(null));

      await cwSetAttrsRetry({
        conversationId,
        headers: cwHeaders,
        attrs: { last_equipment_json: equip || null, last_equipment_ts: Date.now() },
      });

      const summary = String(equip?.summaryText || "").trim();
      const nextSteps = Array.isArray(equip?.next_steps) ? equip.next_steps : [];

      await sendOrdered({
        conversationId,
        headers: cwHeaders,
        content: "🔎 *Analisando sua foto...*\n" + (summary || "Consegui identificar o estado do equipamento."),
        delayMs: 1200,
      });

      const los = String(equip?.los || "unknown");
      const power = String(equip?.power || "unknown");
      const pon = String(equip?.pon || "unknown");

      if (power === "off") {
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_agent: "anderson", bot_state: "support_wait_led" },
        });

        await sendOrdered({
          conversationId,
          headers: cwHeaders,
          content:
            "Parece que o equipamento está *sem energia (POWER apagado)*.\n" +
            "✅ Confere por favor:\n" +
            "1) Tomada/benjamim\n2) Fonte encaixada\n3) Teste outra tomada\n\n" +
            "Se possível, me envie uma foto mais próxima dos LEDs ou me diga se o POWER acende.",
          delayMs: 1200,
        });
        return;
      }

      if (los === "red") {
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_agent: "anderson", bot_state: "support_need_human", support_reason: "los_red" },
        });

        await sendOrdered({
          conversationId,
          headers: cwHeaders,
          content:
            "🚨 Identifiquei *LOS vermelho*. Isso indica *perda de sinal da fibra óptica*.\n" +
            "Vou encaminhar para o time técnico verificar a rede/rota e, se necessário, agendar visita.",
          delayMs: 1200,
        });

        await markNeedHuman({ conversationId, headers: cwHeaders, reason: "support_los_red" });
        return;
      }

      if (pon === "off") {
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_agent: "anderson", bot_state: "support_need_human", support_reason: "pon_off" },
        });

        await sendOrdered({
          conversationId,
          headers: cwHeaders,
          content:
            "⚠️ O LED *PON parece apagado*. Pode ser *sem sincronismo* com a rede.\n" +
            "Vou encaminhar para o time técnico validar o sinal e autenticação do seu acesso.",
          delayMs: 1200,
        });

        await markNeedHuman({ conversationId, headers: cwHeaders, reason: "support_pon_off" });
        return;
      }

      await cwSetAttrsRetry({
        conversationId,
        headers: cwHeaders,
        attrs: { bot_agent: "anderson", bot_state: "support_wait_feedback" },
      });

      const stepsText = nextSteps.length
        ? nextSteps.map((s, i) => `${i + 1}) ${s}`).join("\n")
        : "1) Teste desligar/ligar o roteador\n2) Teste outro aparelho\n3) Se puder, teste cabo direto";

      await sendOrdered({
        conversationId,
        headers: cwHeaders,
        content:
          "✅ Pelo LED, seu equipamento parece *sincronizado*.\n" +
          "Vamos fazer estes testes rápidos:\n" +
          stepsText +
          "\n\nDepois me diga: *voltou?*",
        delayMs: 1200,
      });
      return;
    }

    // =========================
    // COMPROVANTE
    // =========================
    if (imgType === "receipt") {
      const analysis = await openaiAnalyzeImageFn({
        apiKey: OPENAI_API_KEY,
        model: OPENAI_MODEL,
        imageDataUrl: dl.dataUri,
      });

      await cwSetAttrsRetry({
        conversationId,
        headers: cwHeaders,
        attrs: { last_receipt_json: analysis || null, last_receipt_ts: Date.now() },
      });

      const docResolved = await resolveDocForReceipt({
        ca: { ...ca, cpfcnpj: docInText || ca.cpfcnpj },
        wa,
        analysis,
      });

      if (!docResolved) {
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "finance_wait_doc", bot_agent: "cassia" },
        });

        if (shouldSendPrompt(ca, "finance_need_doc_receipt", 45000)) {
          await sendOrdered({
            conversationId,
            headers: cwHeaders,
            content:
              "📎 *Recebi seu comprovante.*\n" +
              (analysis?.summaryText || "Consegui ler o comprovante.") +
              "\n\nPara eu conferir se foi o *mês correto* no sistema, me envie o *CPF ou CNPJ do titular* (somente números).",
            delayMs: 1200,
          });
          await markPromptSent({ conversationId, headers: cwHeaders, key: "finance_need_doc_receipt" });
        }
        return;
      }

      await cwSetAttrsRetry({
        conversationId,
        headers: cwHeaders,
        attrs: { cpfcnpj: docResolved, last_cpfcnpj: docResolved, bot_state: "finance_receipt_check", bot_agent: "cassia" },
      });

      await sendOrdered({
        conversationId,
        headers: cwHeaders,
        content:
          "📎 *Recebi seu comprovante.*\n" +
          (analysis?.summaryText || "Consegui ler o comprovante.") +
          "\n\n✅ Já localizei seu CPF/CNPJ no sistema. Vou conferir o mês correto e já te retorno.",
        delayMs: 1200,
      });

      const result = await financeSendBoletoByDoc({
        conversationId,
        headers: cwHeaders,
        cpfcnpj: docResolved,
        wa,
        silent: true,
        skipPreface: true,
      });

      if (result?.ok && result?.hasOpen && result?.boleto) {
        const match = receiptMatchesBoleto({ analysis, boleto: result.boleto });

        if (match.ok) {
          try {
            const idCliente = String(result?.idCliente || "");
            if (idCliente) {
              await rnNotificacaoPagamento({
                baseUrl: RECEITANET_BASE_URL,
                token: RECEITANET_TOKEN,
                app: RECEITANET_APP,
                idCliente,
                contato: wa || "",
              });
            }
          } catch {}

          await sendOrdered({
            conversationId,
            headers: cwHeaders,
            content:
              "✅ *Pagamento conferido!* O comprovante bate com a fatura em aberto.\n" +
              "Se foi *PIX*, a liberação costuma ser imediata. Se ainda não liberou, me avise aqui.",
            delayMs: 1200,
          });

          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "triage", bot_agent: "isa", finance_need: null },
          });
          return;
        }

        await markNeedHuman({ conversationId, headers: cwHeaders, reason: "receipt_not_match_open_boleto" });
        return;
      }

      await markNeedHuman({ conversationId, headers: cwHeaders, reason: "no_open_boleto_after_receipt" });
      return;
    }

    // Não é comprovante nem equipamento -> pede contexto
    await sendOrdered({
      conversationId,
      headers: cwHeaders,
      content: "📎 Recebi sua imagem. Para eu te ajudar certinho, me diga: isso é *comprovante de pagamento* ou *foto do modem/ONU/roteador*?",
      delayMs: 1200,
    });
    return;
  }

  // não era imagem legível / outro tipo de arquivo
  if (!customerText) {
    const saved = getSavedDocFromCA(ca);
    if (!saved) {
      await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { bot_state: "finance_wait_doc", bot_agent: "cassia" } });

      if (shouldSendPrompt(ca, "finance_need_doc_file", 45000)) {
        await sendOrdered({
          conversationId,
          headers: cwHeaders,
          content: "📎 Recebi seu arquivo. Me envie o *CPF ou CNPJ do titular* (somente números) para eu localizar no sistema.",
          delayMs: 1200,
        });
        await markPromptSent({ conversationId, headers: cwHeaders, key: "finance_need_doc_file" });
      }
      return;
    }

    await sendOrdered({
      conversationId,
      headers: cwHeaders,
      content: "📎 Recebi seu arquivo. Vou conferir no sistema pelo CPF/CNPJ já cadastrado e já retorno. ✅",
      delayMs: 1200,
    });
    return;
  }

  return;
}


          // ============================
          // TRIAGEM / FLUXOS
          // ============================
          const numericChoice = mapNumericChoice(customerText);
          const intent = detectIntent(customerText, numericChoice);

          // TRIAGE
          if ((ca.bot_state || "triage") === "triage") {
            if (intent === "support") {
              await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { bot_agent: "anderson", bot_state: "support_check" } });
              await sendOrdered({
                conversationId,
                headers: cwHeaders,
                content: "Certo! Eu sou o *Anderson* (IA), do suporte. 👍\nVocê está *sem internet* agora ou está *lento/instável*?",
                delayMs: 1200,
              });
              return;
            }

            if (intent === "finance") {
              await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { bot_agent: "cassia", bot_state: "finance_wait_need" } });
              await sendOrdered({
                conversationId,
                headers: cwHeaders,
                content:
                  "Oi! Eu sou a *Cássia* (IA), do financeiro. 💳\nVocê precisa de:\n" +
                  "1) *Boleto/2ª via*\n2) *Informar pagamento / validar comprovante*\n\n" +
                  "(Responda 1/2 ou escreva “boleto” / “paguei”)",
                delayMs: 1200,
              });
              return;
            }

            await sendOrdered({
              conversationId,
              headers: cwHeaders,
              content: "Só para eu te direcionar certinho:\n1) *Sem internet / suporte*\n2) *Financeiro (boleto/pagamento)*\n3) *Planos/contratar*",
              delayMs: 1200,
            });
            return;
          }

          // SUPORTE
          if (ca.bot_state === "support_check") {
            await runSupportCheck({ conversationId, headers: cwHeaders, ca, wa, customerText });
            return;
          }

          // ✅ após o teste de desligar/ligar
          if (ca.bot_state === "support_wait_feedback") {
            const t = normalizeText(customerText).toLowerCase();
            const yes = t === "sim" || t.includes("voltou") || t.includes("normal") || t.includes("ok") || t.includes("funcion") || t.includes("resolveu");
            const no = t === "nao" || t === "não" || t.includes("ainda") || t.includes("continua") || t.includes("não voltou") || t.includes("nao voltou");

            if (yes) {
              await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { bot_state: "triage", bot_agent: "isa" } });
              await sendOrdered({
                conversationId,
                headers: cwHeaders,
                content: "✅ Perfeito! Fico feliz que voltou.\nSe precisar de algo, é só me chamar. 🙂",
                delayMs: 1200,
              });
              return;
            }

            // se for não (ou qualquer resposta), coleta LEDs
            await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { bot_state: "support_wait_led", bot_agent: "anderson" } });

            await sendOrdered({
              conversationId,
              headers: cwHeaders,
              content:
                "Entendi. Vamos fazer um diagnóstico rápido estilo NOC.\n\n" +
                "Me diga como estão as luzes do seu equipamento (se conseguir):\n" +
                "1) *POWER* (acesa/apagada)\n" +
                "2) *PON* (verde fixa/piscando/apagada)\n" +
                "3) *LOS* (vermelha/apagada)\n\n" +
                "📸 Se preferir, envie uma *foto de frente* do modem/ONU mostrando os LEDs.",
              delayMs: 1200,
            });
            return;
          }

          if (ca.bot_state === "support_wait_led") {
            const t = normalizeText(customerText).toLowerCase();

            // heurística simples (sem depender de OCR)
            const hasLosRed = t.includes("los") && (t.includes("vermel") || t.includes("red"));
            const hasPowerOff = t.includes("power") && (t.includes("apag") || t.includes("off"));
            const hasPonOff = t.includes("pon") && (t.includes("apag") || t.includes("off"));
            const hasPonOk = t.includes("pon") && (t.includes("verde") || t.includes("green"));

            if (hasLosRed) {
              await sendOrdered({
                conversationId,
                headers: cwHeaders,
                content:
                  "🚨 *LOS vermelho* normalmente indica *perda de sinal da fibra*.\n" +
                  "Vou encaminhar para o time técnico verificar a rede e, se necessário, agendar visita.",
                delayMs: 1200,
              });
              await markNeedHuman({ conversationId, headers: cwHeaders, reason: "support_los_red_text" });
              return;
            }

            if (hasPowerOff) {
              await sendOrdered({
                conversationId,
                headers: cwHeaders,
                content:
                  "Se o *POWER* está apagado, o equipamento pode estar sem energia.\n" +
                  "✅ Confira: tomada/benjamim, fonte encaixada e teste outra tomada.\n\n" +
                  "Se puder, envie uma foto dos LEDs para eu confirmar.",
                delayMs: 1200,
              });
              return;
            }

            if (hasPonOff) {
              await sendOrdered({
                conversationId,
                headers: cwHeaders,
                content:
                  "Com *PON apagado*, pode ser falta de sincronismo com a rede.\n" +
                  "Vou encaminhar para o time técnico validar sinal/autenticação do seu acesso.",
                delayMs: 1200,
              });
              await markNeedHuman({ conversationId, headers: cwHeaders, reason: "support_pon_off_text" });
              return;
            }

            if (hasPonOk) {
              await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { bot_state: "support_wait_feedback", bot_agent: "anderson" } });
              await sendOrdered({
                conversationId,
                headers: cwHeaders,
                content:
                  "✅ Se o *PON está verde*, seu equipamento está sincronizado.\n" +
                  "Vamos testar: \n" +
                  "1) Teste desligar/ligar o roteador novamente\n" +
                  "2) Teste outro aparelho\n" +
                  "3) Se tiver como, teste *cabo direto* no computador\n\n" +
                  "Depois me diga: *voltou?*",
                delayMs: 1200,
              });
              return;
            }

            // não entendeu -> pede foto
            await sendOrdered({
              conversationId,
              headers: cwHeaders,
              content:
                "Para eu te orientar com precisão, pode me enviar uma *foto de frente* do modem/ONU mostrando as luzes (POWER/PON/LOS)?",
              delayMs: 1200,
            });
            return;
          }

          if (ca.bot_state === "support_need_doc") {
            const cpfDigits = extractCpfCnpjDigits(customerText);

            if (!cpfDigits) {
              // se ele insistir “sem internet”, não fica repetindo CPF sem parar
              if (shouldSendPrompt(ca, "support_need_doc", 45000)) {
                await sendOrdered({
                  conversationId,
                  headers: cwHeaders,
                  content:
                    "Para eu abrir seu atendimento de suporte, preciso localizar seu cadastro.\n" +
                    "Me envie *CPF (11)* ou *CNPJ (14)*, somente números.",
                  delayMs: 1200,
                });
                await markPromptSent({ conversationId, headers: cwHeaders, key: "support_need_doc" });
              }
              return;
            }

            await cwSetAttrsRetry({
              conversationId,
              headers: cwHeaders,
              attrs: { cpfcnpj: cpfDigits, last_cpfcnpj: cpfDigits, bot_state: "support_check", bot_agent: "anderson" },
            });

            await runSupportCheck({ conversationId, headers: cwHeaders, ca: { ...ca, cpfcnpj: cpfDigits }, wa, customerText });
            return;
          }

          // FINANCEIRO
          if (ca.bot_state === "finance_wait_need") {
            const choice = mapNumericChoice(customerText);
            const need =
              choice === 1 || isBoletoIntent(customerText) ? "boleto" : choice === 2 || isPaymentIntent(customerText) ? "comprovante" : null;

            if (!need) {
              await sendOrdered({
                conversationId,
                headers: cwHeaders,
                content: "Me diga: você quer *1) boleto/2ª via* ou *2) validar pagamento/comprovante*?",
                delayMs: 1200,
              });
              return;
            }

            await cwSetAttrsRetry({
              conversationId,
              headers: cwHeaders,
              attrs: { finance_need: need, bot_state: "finance_wait_doc", bot_agent: "cassia" },
            });

            const savedDoc = getSavedDocFromCA(ca);
            if (savedDoc) {
              await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { cpfcnpj: savedDoc, last_cpfcnpj: savedDoc } });

              if (need === "boleto") {
                await financeSendBoletoByDoc({ conversationId, headers: cwHeaders, cpfcnpj: savedDoc, wa, silent: false, skipPreface: false });
                await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { bot_state: "finance_wait_need", bot_agent: "cassia", finance_need: null } });
                return;
              }

              await sendOrdered({
                conversationId,
                headers: cwHeaders,
                content: "Certo. Você pode enviar o *comprovante* aqui que eu já valido pelo CPF/CNPJ cadastrado. ✅",
                delayMs: 1200,
              });
              return;
            }

            if (shouldSendPrompt(ca, "finance_need_doc", 45000)) {
              await sendOrdered({
                conversationId,
                headers: cwHeaders,
                content: "Certo. Me envie o *CPF ou CNPJ do titular* (somente números).",
                delayMs: 1200,
              });
              await markPromptSent({ conversationId, headers: cwHeaders, key: "finance_need_doc" });
            }
            return;
          }

          if (ca.bot_state === "finance_wait_doc") {
            const cpfDigits = extractCpfCnpjDigits(customerText) || getSavedDocFromCA(ca);
            if (!cpfDigits) {
              if (shouldSendPrompt(ca, "finance_need_doc", 45000)) {
                await sendOrdered({
                  conversationId,
                  headers: cwHeaders,
                  content: "Para eu localizar no sistema: envie *CPF (11)* ou *CNPJ (14)*, somente números.",
                  delayMs: 1200,
                });
                await markPromptSent({ conversationId, headers: cwHeaders, key: "finance_need_doc" });
              }
              return;
            }

            await cwSetAttrsRetry({
              conversationId,
              headers: cwHeaders,
              attrs: { cpfcnpj: cpfDigits, last_cpfcnpj: cpfDigits, bot_agent: "cassia" },
            });

            const need = String(ca?.finance_need || "");
            if (need === "boleto") {
              await financeSendBoletoByDoc({ conversationId, headers: cwHeaders, cpfcnpj: cpfDigits, wa, silent: false, skipPreface: false });
              await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { bot_state: "finance_wait_need", bot_agent: "cassia", finance_need: null } });
              return;
            }

            await sendOrdered({
              conversationId,
              headers: cwHeaders,
              content: "Certo ✅ Agora pode enviar o *comprovante* (foto/print) que eu valido por aqui.",
              delayMs: 1200,
            });

            // mantém no financeiro esperando anexo (não reinicia triage)
            await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { bot_state: "finance_wait_need", bot_agent: "cassia" } });
            return;
          }

          // ============================
          // FALLBACK GPT (controlado)
          // ============================
          const persona = buildPersonaHeader(agent);
          const gptResp = await openaiChatFn({
            apiKey: OPENAI_API_KEY,
            model: OPENAI_MODEL,
            system:
              persona +
              "\nRegras:\n- Não reiniciar atendimento.\n- Se já tiver CPF/CNPJ salvo, não pedir de novo.\n- Se cliente disser “sem internet”, priorize suporte.\n",
            user: customerText,
            maxTokens: 220,
          });

          const replyText = typeof gptResp === "string" ? gptResp : gptResp?.text || "";
          if (replyText) {
            await sendOrdered({ conversationId, headers: cwHeaders, content: replyText, delayMs: 1200 });
          }
        } catch (err) {
          console.error("❌ Erro no processamento da conversa:", err);
        }
      });
    } catch (err) {
      console.error("❌ Erro no webhook:", err);
    }
  });

  app.listen(PORT, () => console.log("🚀 Bot online na porta", PORT));
}
