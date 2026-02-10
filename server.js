// server.js (COMPLETO - pronto para copiar e colar)
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
  pickBoletoOldestOverdueElseCurrent,
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

const AUTO_GPT_THRESHOLD = Number(process.env.AUTO_GPT_THRESHOLD || 3);

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

function receiptMatchesBoleto({ analysis, boleto }) {
  const boletoLine = normalizeDigits(boleto?.barras || "");
  const recLine = normalizeDigits(analysis?.barcode_or_line || "");

  const strong = boletoLine && recLine && boletoLine === recLine;

  const boletoAmount = parseMoneyToNumber(boleto?.valor);
  const paidAmount = parseMoneyToNumber(analysis?.amount);

  const amountOk = amountsClose(paidAmount, boletoAmount, 0.05);
  const hasDate = Boolean(String(analysis?.date || "").trim());
  const medium = amountOk && hasDate;

  return {
    ok: strong || medium,
    level: strong ? "strong" : medium ? "medium" : "none",
    amountOk,
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

// Menu SMSNET é só quando GPT OFF
function isSmsnetMenuAnswer(text) {
  const t = (text || "").trim();
  return t === "1" || t === "2" || t === "3";
}
function isMenuEscape(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (isSmsnetMenuAnswer(t)) return false;
  return true;
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
  return t.includes("paguei") || t.includes("pagamento") || t.includes("comprov") || t.includes("pix") || t.includes("transfer") || t.includes("depositei");
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

// =====================
// ✅ EXTRAÇÃO ROBUSTA DO ID
// =====================
function toId(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  if (!s) return "";
  if (s === "0") return "";
  const sl = s.toLowerCase();
  if (sl === "null" || sl === "undefined") return "";
  return s;
}

function normalizeCollection(maybe) {
  if (!maybe) return [];
  if (Array.isArray(maybe)) return maybe.filter(Boolean);
  if (typeof maybe === "object") {
    const keys = Object.keys(maybe)
      .filter((k) => /^[0-9]+$/.test(String(k)))
      .sort((a, b) => Number(a) - Number(b));
    if (keys.length) return keys.map((k) => maybe[k]).filter(Boolean);
    return Object.values(maybe).filter(Boolean);
  }
  return [];
}

function deepFindAnyId(obj, maxDepth = 3) {
  const visited = new Set();
  const BLOCK = /(cpf|cnpj|documento|doc|telefone|celular|whatsapp|fone|rg)/i;
  const PRIORITY = /(idcliente|cliente_id|clienteid|idcontrato|contrato_id|id_contrato)/i;

  function walk(node, depth) {
    if (!node || typeof node !== "object") return "";
    if (visited.has(node)) return "";
    visited.add(node);

    if (Array.isArray(node)) {
      for (const it of node) {
        const got = walk(it, depth);
        if (got) return got;
      }
      return "";
    }

    const keys = Object.keys(node);

    for (const k of keys) {
      if (BLOCK.test(k)) continue;
      if (!PRIORITY.test(k)) continue;
      const v = toId(node[k]);
      if (v) return v;
    }

    for (const k of keys) {
      if (BLOCK.test(k)) continue;
      if (!/id/i.test(k)) continue;
      const v = toId(node[k]);
      if (v) return v;
    }

    if (depth >= maxDepth) return "";

    for (const k of keys) {
      const v = node[k];
      if (v && typeof v === "object") {
        const got = walk(v, depth + 1);
        if (got) return got;
      }
    }

    return "";
  }

  return walk(obj, 0);
}

function getIdClienteRobusto(clientData) {
  const d = clientData && typeof clientData === "object" ? clientData : {};
  const root = toId(d.idCliente ?? d.idcliente ?? d.IdCliente ?? d.id);
  if (root) return root;

  const contratosRaw = d.contratos ?? d.data?.contratos ?? d.cliente?.contratos ?? null;
  const contratos = normalizeCollection(contratosRaw);
  const fromContratos = deepFindAnyId(contratos, 3);
  if (fromContratos) return fromContratos;

  const general = deepFindAnyId(d, 3);
  return general || "";
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

// ✅ NOVA ORDEM DE ENVIO (título -> conteúdo), pra facilitar copiar/colar
async function financeSendBoletoPieces({ conversationId, headers, boleto }) {
  const venc = boleto?.vencimento || "";
  const valor = boleto?.valor;
  const link = boleto?.link || "";
  const pix = boleto?.qrcode_pix || "";
  const barras = boleto?.barras || "";
  const pdf = boleto?.pdf || "";

  // cabeçalho do boleto (resumo)
  const header = [];
  header.push("📄 *Boleto em aberto*");
  if (venc) header.push(`🗓️ *Vencimento:* ${venc}`);
  if (valor !== undefined && valor !== null && String(valor).trim() !== "") header.push(`💰 *Valor:* R$ ${String(valor).replace(".", ",")}`);
  await cwSendMessageRetry({ conversationId, headers, content: header.join("\n") });

  // LINK (título primeiro, depois conteúdo em outra msg)
  if (link) {
    await cwSendMessageRetry({ conversationId, headers, content: "🔗 *Link do boleto:*" });
    await cwSendMessageRetry({ conversationId, headers, content: link });
  }

  // CÓDIGO DE BARRAS (título primeiro, depois conteúdo)
  if (barras) {
    await cwSendMessageRetry({ conversationId, headers, content: "🏷️ *Código de barras:*" });
    await cwSendMessageRetry({ conversationId, headers, content: barras });
  }

  // PIX COPIA E COLA (título primeiro, depois conteúdo em blocos)
  if (pix) {
    await cwSendMessageRetry({ conversationId, headers, content: "📌 *PIX copia e cola:*" });
    const parts = chunkString(pix, 1200);
    for (const p of parts) {
      await cwSendMessageRetry({ conversationId, headers, content: p });
    }
  }

  // PDF (título primeiro, depois conteúdo)
  if (pdf) {
    await cwSendMessageRetry({ conversationId, headers, content: "📎 *PDF:*" });
    await cwSendMessageRetry({ conversationId, headers, content: pdf });
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

  const idCliente = getIdClienteRobusto(client?.data || {});
  if (!idCliente) {
    console.log("🧾 [FIN] ERRO: rnFindClient retornou sem idCliente. Keys:", Object.keys(client?.data || {}));
    try {
      const contratosRaw = client?.data?.contratos ?? null;
      const contratos = normalizeCollection(contratosRaw);
      console.log("🧾 [FIN] contratos[0] keys:", Object.keys(contratos?.[0] || {}));
    } catch {}

    if (!silent) {
      await cwSendMessageRetry({
        conversationId,
        headers,
        content:
          "Consegui localizar o cadastro, mas o sistema não retornou o identificador necessário para liberar automaticamente.\n" +
          "Vou encaminhar para liberação manual rapidinho. ✅",
      });
    }
    await cwSetAttrsRetry({ conversationId, headers, attrs: { bot_state: "finance_wait_need", bot_agent: "cassia", last_cpfcnpj: cpfcnpj } });
    return { ok: false, reason: "missing_id_cliente" };
  }

  const debitos = await rnListDebitos({
    baseUrl: RECEITANET_BASE_URL,
    token: RECEITANET_TOKEN,
    app: RECEITANET_APP,
    cpfcnpj,
    status: 0,
  });

  if (!Array.isArray(debitos) || debitos.length === 0) {
    if (!silent) {
      await cwSendMessageRetry({
        conversationId,
        headers,
        content: "✅ Encontrei seu cadastro, mas *não consta boleto em aberto* no momento.\nSe você já pagou, pode me enviar o *comprovante* aqui que eu confirmo.",
      });
    }
    await cwSetAttrsRetry({
      conversationId,
      headers,
      attrs: { bot_state: "finance_wait_need", bot_agent: "cassia", last_cpfcnpj: cpfcnpj, finance_id_cliente: idCliente, finance_current_boleto: null },
    });
    return { ok: true, hasOpen: false };
  }

  const picked = pickBoletoOldestOverdueElseCurrent(debitos);
  const boleto = picked?.boleto || null;
  const overdueCount = Number(picked?.overdueCount || 0);

  if (!boleto) {
    if (!silent) {
      await cwSendMessageRetry({
        conversationId,
        headers,
        content: "Encontrei débitos, mas não consegui montar o boleto automaticamente.\nVocê quer *2ª via do boleto* ou quer *validar um pagamento*?",
      });
    }
    await cwSetAttrsRetry({ conversationId, headers, attrs: { bot_state: "finance_wait_need", bot_agent: "cassia", last_cpfcnpj: cpfcnpj, finance_id_cliente: idCliente } });
    return { ok: false, reason: "no_boleto" };
  }

  await cwSetAttrsRetry({
    conversationId,
    headers,
    attrs: {
      bot_state: "finance_wait_need",
      bot_agent: "cassia",
      last_cpfcnpj: cpfcnpj,
      finance_id_cliente: idCliente,
      finance_current_boleto: { valor: boleto.valor, vencimento: boleto.vencimento, barras: boleto.barras, debito_id: boleto.debito_id || "" },
    },
  });

  if (silent) return { ok: true, hasOpen: true, boleto, overdueCount };

  // ✅ (1) “Perfeito…” no topo, antes das opções
  await cwSendMessageRetry({
    conversationId,
    headers,
    content: "Perfeito 😊 Já localizei aqui.\nVou te enviar agora as informações do boleto (link / PIX / código de barras).",
  });

  await financeSendBoletoPieces({ conversationId, headers, boleto });

  // ✅ (4) “Pode pagar…” inclui PIX = liberação imediata
  await cwSendMessageRetry({
    conversationId,
    headers,
    content:
      "Pode pagar pela opção que for mais prática pra você 🙂\n" +
      "⚡ *Pagando via PIX, a liberação costuma ser imediata.*",
  });

  // aviso do comprovante
  await cwSendMessageRetry({
    conversationId,
    headers,
    content:
      "👉 Se você já realizou o pagamento, pode enviar o comprovante aqui. Vou analisar a imagem ou PDF pra confirmar que é esse boleto e agilizar a liberação! ✅",
  });

  // ✅ (3) mensagem “+ de 1 vencido” só no FINAL
  if (overdueCount > 1) {
    await cwSendMessageRetry({
      conversationId,
      headers,
      content:
        "⚠️ Identifiquei *mais de 1 boleto vencido*.\n" +
        "Para ver e emitir todos os boletos, acesse o *Portal do Assinante*:\n" +
        "https://i9net.centralassinante.com.br/",
    });
  }

  return { ok: true, hasOpen: true, boleto, overdueCount };
}

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
      let conv = await cwGetConversationRetry({ conversationId, headers: cwHeaders });

      const labels = safeLabelList(conv);
      const labelSet = new Set(labels);

      const ca = conv?.custom_attributes || {};
      const state = ca.bot_state || "triage";
      const agent = ca.bot_agent || "isa";

      const waPayload = extractWhatsAppFromPayload(req.body) || normalizePhoneBR(ca.whatsapp_phone || "");
      const wa = normalizePhoneBR(waPayload || "");
      const menuIgnoreCount = Number(ca.menu_ignore_count || 0);

      const gptOn = labelSet.has(LABEL_GPT_ON) || ca.gpt_on === true;

      console.log("🔥 chegando", { conversationId, text: customerText || "(vazio)", anexos: attachments.length, state, agent, wa: wa || null, labels, menu_ignore_count: menuIgnoreCount, gpt_on: gptOn });

      if (wa && wa !== normalizePhoneBR(ca.whatsapp_phone || "")) {
        await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { whatsapp_phone: wa } });
      }

      // GPT OFF: só contador (mantido)
      if (!gptOn) {
        if (isSmsnetMenuAnswer(customerText)) {
          if (menuIgnoreCount !== 0) await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { menu_ignore_count: 0 } });
          return;
        }

        if (isMenuEscape(customerText)) {
          const nextCount = menuIgnoreCount + 1;
          await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { menu_ignore_count: nextCount } });

          if (nextCount < AUTO_GPT_THRESHOLD) return;

          await cwAddLabelsRetry({ conversationId, headers: cwHeaders, currentLabels: labels, labelsToAdd: [LABEL_GPT_ON] });

          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { gpt_on: true, menu_ignore_count: 0, bot_state: "triage", bot_agent: "isa", welcome_sent: false },
          });

          await cwSendMessageRetry({ conversationId, headers: cwHeaders, content: "✅ Entendi. Vou te atender por aqui e agilizar pra você 😊" });
          return;
        }
        return;
      }

      // CPF/CNPJ automático
      const cpfcnpjInText = extractCpfCnpjDigits(customerText);
      if (cpfcnpjInText && (state === "triage" || String(state || "").startsWith("finance"))) {
        if (!labelSet.has(LABEL_WELCOME_SENT) && !ca.welcome_sent) {
          await cwAddLabelsRetry({ conversationId, headers: cwHeaders, currentLabels: labels, labelsToAdd: [LABEL_GPT_ON, LABEL_WELCOME_SENT] });
          await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { welcome_sent: true, gpt_on: true } });
        }
        await financeSendBoletoByDoc({ conversationId, headers: cwHeaders, cpfcnpj: cpfcnpjInText, wa, silent: false });
        return;
      }

      // anexos -> comprovante (mantido como estava no seu último código funcional)
      if (attachments.length > 0) {
        const att = pickFirstAttachment(attachments);
        const dataUrl = att?.data_url || att?.dataUrl || null;

        await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { gpt_on: true, bot_agent: "cassia", bot_state: "finance_receipt_processing" } });

        if (!dataUrl) {
          await cwSendMessageRetry({ conversationId, headers: cwHeaders, content: "📎 Recebi seu arquivo. Me envie o *CPF ou CNPJ do titular* (somente números) para eu validar." });
          await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { bot_state: "finance_receipt_wait_doc" } });
          return;
        }

        const dl = await cwDownloadAttachmentRetry({ headers: cwHeaders, dataUrl });

        if (dl.ok && dl.bytes <= 4 * 1024 * 1024 && (dl.contentType || "").startsWith("image/")) {
          const analysis = await openaiAnalyzeImage({ apiKey: OPENAI_API_KEY, model: OPENAI_MODEL, imageDataUrl: dl.dataUri });

          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content:
              "📎 *Recebi seu comprovante.*\n" +
              (analysis?.summaryText || "Consegui ler o comprovante.") +
              "\n\nSó um instante que vou conferir se está referente ao boleto em aberto. ✅",
          });

          let boletoAtual = ca?.finance_current_boleto || null;
          let idCliente = String(ca?.finance_id_cliente || "").trim();

          if ((!boletoAtual || !idCliente) && String(ca?.last_cpfcnpj || "").trim()) {
            await financeSendBoletoByDoc({
              conversationId,
              headers: cwHeaders,
              cpfcnpj: String(ca.last_cpfcnpj).trim(),
              wa,
              silent: true,
            });

            conv = await cwGetConversationRetry({ conversationId, headers: cwHeaders });
            const ca2 = conv?.custom_attributes || {};
            boletoAtual = ca2?.finance_current_boleto || boletoAtual;
            idCliente = String(ca2?.finance_id_cliente || idCliente).trim();
          }

          if (!idCliente) {
            await cwSendMessageRetry({ conversationId, headers: cwHeaders, content: "Para eu confirmar certinho, me envie o *CPF ou CNPJ do titular* (somente números). 🙂" });
            await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { bot_state: "finance_receipt_wait_doc" } });
            return;
          }

          const match = receiptMatchesBoleto({ analysis, boleto: boletoAtual });

          if (!match.ok) {
            await cwSendMessageRetry({
              conversationId,
              headers: cwHeaders,
              content:
                "Entendi 🙂 Mas esse comprovante *não confere* com o boleto que está em aberto no momento.\n\n" +
                "👉 Se você pagou por *boleto*, envie um print onde apareça a *linha digitável/código de barras*.\n" +
                "👉 Se pagou por *PIX*, envie o comprovante onde apareça a *chave/identificador* do PIX.\n\n" +
                "Se preferir, você também pode quitar pelo boleto em aberto que eu enviei acima. ✅",
            });
            await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { bot_state: "finance_wait_need" } });
            return;
          }

          const notif = await rnNotificacaoPagamento({
            baseUrl: RECEITANET_BASE_URL,
            token: RECEITANET_TOKEN,
            app: RECEITANET_APP,
            idCliente,
            contato: wa || "",
          });

          if (notif.ok) {
            const d = notif.data || {};
            const liberado = d?.liberado === true;
            const msg = d?.msg ? String(d.msg) : "";
            const protocolo = d?.protocolo ? String(d.protocolo) : "";

            if (liberado) {
              await cwSendMessageRetry({
                conversationId,
                headers: cwHeaders,
                content:
                  "✅ Confirmado! Já solicitei a *liberação provisória* do seu acesso agora. 🙂\n" +
                  (d?.liberado_ate ? `Válido até: ${d.liberado_ate}\n` : "") +
                  (protocolo ? `Protocolo: ${protocolo}` : ""),
              });
            } else {
              await cwSendMessageRetry({
                conversationId,
                headers: cwHeaders,
                content:
                  "✅ Comprovante conferido! 🙂\n" +
                  "Tentei liberar automaticamente, mas o sistema retornou:\n" +
                  (msg ? `“${msg}”\n` : "") +
                  (protocolo ? `Protocolo: ${protocolo}\n` : "") +
                  "Vou encaminhar para liberação manual e te retorno por aqui. ✅",
              });
            }
          } else {
            await cwSendMessageRetry({
              conversationId,
              headers: cwHeaders,
              content:
                "✅ Comprovante conferido! 🙂\n" +
                "Consegui validar o pagamento, mas não consegui concluir a liberação automática agora.\n" +
                "Vou encaminhar para liberação manual e te retorno por aqui. ✅",
            });
          }

          await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { bot_state: "finance_wait_need" } });
          return;
        }

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content:
            "📎 Recebi seu arquivo. 🙂\n" +
            "Para eu validar automaticamente, me envie *uma foto/print do comprovante* (imagem) onde apareça valor e data, por favor. ✅",
        });
        await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { bot_state: "finance_receipt_wait_doc" } });
        return;
      }

      // triagem sem números
      const numericChoice = mapNumericChoice(customerText);
      let intent = detectIntent(customerText, numericChoice);
      if (isPaymentIntent(customerText) || isBoletoIntent(customerText)) intent = "finance";

      if (state === "triage") {
        if (intent === "finance") {
          await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { gpt_on: true, bot_agent: "cassia", bot_state: "finance_wait_doc" } });
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "Oi! Eu sou a *Cassia*, do financeiro. 💳\nMe envie o *CPF ou CNPJ do titular* (somente números) para eu localizar boleto/pagamento.",
          });
          return;
        }

        if (intent === "support") {
          await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { gpt_on: true, bot_agent: "anderson", bot_state: "support_check" } });
          await cwSendMessageRetry({ conversationId, headers: cwHeaders, content: "Certo! Eu sou o *Anderson*, do suporte. 👍\nVocê está *sem internet* agora ou está *lento/instável*?" });
          return;
        }

        if (intent === "sales") {
          await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { gpt_on: true, bot_agent: "isa", bot_state: "sales_flow" } });
          await cwSendMessageRetry({ conversationId, headers: cwHeaders, content: "Perfeito! Me diga seu *bairro* e *cidade* para eu te informar cobertura e planos. 😊" });
          return;
        }

        await cwSendMessageRetry({ conversationId, headers: cwHeaders, content: "Para eu te direcionar certinho, me diga: *Suporte*, *Financeiro* ou *Planos*." });
        return;
      }

      const persona = buildPersonaHeader(agent);
      const reply = await openaiChat({ apiKey: OPENAI_API_KEY, model: OPENAI_MODEL, system: persona, user: customerText, maxTokens: 160 });

      await cwSendMessageRetry({ conversationId, headers: cwHeaders, content: reply || "Certo! Pode me explicar um pouco melhor o que você precisa?" });
    } catch (err) {
      console.error("❌ Erro no webhook:", err);
    }
  });

  app.listen(PORT, () => console.log("🚀 Bot online na porta", PORT));
}
