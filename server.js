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
  pickBestOverdueBoleto,
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

// ✅ CHAVE REAL (blindagem): só seu comando seta isso
const LABEL_GPT_MANUAL = "gpt_manual_on";

// Anti dupla resposta na triagem (cliente manda 2 msgs seguidas)
const TRIAGE_COOLDOWN_MS = Number(process.env.TRIAGE_COOLDOWN_MS || 2500);

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

// =====================
// GPT classifier (só quando der dúvida)
// =====================
async function classifyIntentWithGPT({ apiKey, model, text }) {
  const reply = await openaiChat({
    apiKey,
    model,
    system:
      "Você é um classificador. Dada uma mensagem de cliente de um provedor de internet, responda SOMENTE com uma destas palavras:\n" +
      "support (sem internet, lento, instável, wi-fi, conexão)\n" +
      "finance (boleto, pagamento, fatura, pix, comprovante, desbloqueio)\n" +
      "sales (planos, contratar, preço, cobertura, instalação)\n\n" +
      "Regras: responda apenas uma palavra (support/finance/sales), minúscula, sem pontuação.",
    user: text,
    maxTokens: 3,
  });

  const c = (reply || "").trim().toLowerCase();
  return ["support", "finance", "sales"].includes(c) ? c : null;
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

  const debitos = await rnListDebitos({
    baseUrl: RECEITANET_BASE_URL,
    token: RECEITANET_TOKEN,
    app: RECEITANET_APP,
    cpfcnpj,
    status: 0,
  });

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

  const { boleto, overdueCount } = pickBestOverdueBoleto(list);

  if (!boleto) {
    if (!silent) {
      await cwSendMessageRetry({
        conversationId,
        headers,
        content: "Encontrei débitos, mas não consegui montar o boleto automaticamente.\nVocê quer *2ª via do boleto* ou *validar pagamento*?",
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

      // ✅ BLINDAGEM:
      // - Ignora gpt_on "automático/sujo"
      // - Só responde quando existir gpt_manual_on
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

        // ✅ adiciona a chave manual + mantém compatibilidade com gpt_on
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

        // Recalcula (porque labelSet local não atualiza automaticamente)
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

        // remove label gpt_on e a chave manual
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
            last_triage_ts: null, // ✅ limpa cooldown
          },
        });

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content: "✅ Modo teste desativado. Voltando para o atendimento padrão do menu.",
        });

        return;
      }

      // ============================
      // LIMPEZA OPCIONAL:
      // Se alguém adicionou gpt_on automaticamente, remove para não confundir
      // (mantém o sistema "limpo"; não afeta quem ativou manualmente)
      // ============================
      if (labelSet.has(LABEL_GPT_ON) && !labelSet.has(LABEL_GPT_MANUAL)) {
        await cwRemoveLabelRetry({ conversationId, headers: cwHeaders, label: LABEL_GPT_ON });
        // não dá return aqui; só limpa e continua
      }

      // ============================
      // GPT OFF => NÃO RESPONDE (evita dois atendentes)
      // ============================
      if (!gptOn) return;

      // ============================
      // GPT ON DAQUI PRA BAIXO
      // ============================

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

        // fallback se não deu pra ler
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
      // TRIAGEM (Isa) - texto livre + classificador GPT quando der dúvida
      // ============================
      const numericChoice = mapNumericChoice(customerText);
      let intent = detectIntent(customerText, numericChoice); // ✅ agora detectIntent deve devolver null quando não souber

      if (state === "triage") {
        // Cooldown: evita responder 2x quando cliente manda duas mensagens seguidas
        const now = Date.now();
        const lastTriageTs = Number(ca.last_triage_ts || 0);
        if (lastTriageTs && now - lastTriageTs < TRIAGE_COOLDOWN_MS) {
          await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { last_triage_ts: now } });
          return;
        }
        await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { last_triage_ts: now } });

        // Se keyword não pegou, usa GPT só para classificar
        if (!intent) {
          intent = await classifyIntentWithGPT({
            apiKey: OPENAI_API_KEY,
            model: OPENAI_MODEL,
            text: customerText,
          });
        }

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
              "Oi! Eu sou a *Cassia*, do financeiro. 💳\nVocê precisa de:\n1) *Boleto/2ª via*\n2) *Informar pagamento / validar comprovante*\n\n(Se preferir, pode escrever “boleto” ou “paguei”)",
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

        // Fallback humano (sem forçar número)
        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content:
            "Entendi 😊 É sobre *sem internet/instabilidade*, *boleto/pagamento* ou *planos/contratar*?\nPode responder com palavras mesmo (ex: “sem internet”).",
        });
        return;
      }

      // ============================
      // SUPORTE (Anderson)
      // ============================
      if (state === "support_check") {
        const cpfDigits = extractCpfCnpjDigits(customerText);

        let client = null;

        if (wa) {
          client = await rnFindClient({
            baseUrl: RECEITANET_BASE_URL,
            token: RECEITANET_TOKEN,
            app: RECEITANET_APP,
            phone: wa,
          });
        }

        if ((!client || !client.found) && cpfDigits) {
          console.log("🧾 [SUP] buscando por CPF/CNPJ", { conversationId, cpfLen: cpfDigits.length });
          client = await rnFindClient({
            baseUrl: RECEITANET_BASE_URL,
            token: RECEITANET_TOKEN,
            app: RECEITANET_APP,
            cpfcnpj: cpfDigits,
          });
          await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { cpfcnpj: cpfDigits } });
        }

        if (!client?.found) {
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "support_need_doc", bot_agent: "anderson" },
          });

          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "Para eu verificar seu *acesso* no sistema, me envie o *CPF ou CNPJ do titular* (somente números), por favor.",
          });
          return;
        }

        const cpfUse = onlyDigits(String(client?.data?.cpfCnpj || client?.data?.cpfcnpj || ca.cpfcnpj || ""));
        const idCliente = String(client?.data?.idCliente || "").trim();

        let blocked = false;
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
            blocked =
              a?.bloqueado === true ||
              a?.liberado === false ||
              String(a?.situacao || "").toLowerCase().includes("bloque");
          } catch {}
        }

        let debitos = [];
        try {
          debitos = await rnListDebitos({
            baseUrl: RECEITANET_BASE_URL,
            token: RECEITANET_TOKEN,
            app: RECEITANET_APP,
            cpfcnpj: cpfUse,
            status: 0,
          });
        } catch {}

        const { boleto: overdueBoleto } = pickBestOverdueBoleto(Array.isArray(debitos) ? debitos : []);

        if (blocked || overdueBoleto) {
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_agent: "cassia", bot_state: "finance_wait_need" },
          });

          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "Entendi. Verifiquei no sistema e seu acesso está com *pendência financeira*.\nVou te enviar agora as opções pra regularizar. 👇",
          });

          await financeSendBoletoByDoc({ conversationId, headers: cwHeaders, cpfcnpj: cpfUse, wa, silent: false });
          return;
        }

        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "support_wait_feedback", bot_agent: "anderson" },
        });

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content:
            "No sistema não aparece bloqueio agora.\nVamos fazer um teste rápido:\n" +
            "1) Desligue a ONU/roteador por *2 minutos*\n" +
            "2) Ligue novamente\n" +
            "3) Aguarde *2 minutos*\n\nDepois me diga: voltou?",
        });
        return;
      }

      if (state === "support_need_doc") {
        const cpfDigits = extractCpfCnpjDigits(customerText);
        if (!cpfDigits) {
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "Opa! Envie *CPF (11)* ou *CNPJ (14)*, somente números.",
          });
          return;
        }

        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { cpfcnpj: cpfDigits, bot_state: "support_check", bot_agent: "anderson" },
        });

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content: "Perfeito. Só um instante que vou verificar seu *acesso* no sistema. ✅",
        });
        return;
      }

      // ============================
      // FINANCEIRO (Cassia)
      // ============================
      if (state === "finance_wait_need") {
        const choice = mapNumericChoice(customerText);
        const need =
          choice === 1 || isBoletoIntent(customerText)
            ? "boleto"
            : choice === 2 || isPaymentIntent(customerText)
            ? "comprovante"
            : null;

        if (!need) {
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "Me diga: você quer *1) boleto/2ª via* ou *2) validar pagamento/comprovante*?\n(Se preferir, escreva “boleto” ou “paguei”)",
          });
          return;
        }

        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { finance_need: need, bot_state: "finance_wait_doc", bot_agent: "cassia" },
        });

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content: "Certo. Me envie o *CPF ou CNPJ do titular* (somente números).",
        });
        return;
      }

      if (state === "finance_wait_doc") {
        const cpfDigits = extractCpfCnpjDigits(customerText);
        if (!cpfDigits) {
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "Para eu localizar no sistema: envie *CPF (11)* ou *CNPJ (14)*, somente números.",
          });
          return;
        }

        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { cpfcnpj: cpfDigits, last_cpfcnpj: cpfDigits, bot_state: "finance_handle", bot_agent: "cassia" },
        });

        console.log("🧾 [FIN] CPF/CNPJ recebido -> consultando ReceitaNet", { conversationId, cpfLen: cpfDigits.length });

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content: "Beleza. Vou verificar no sistema e já te retorno. ✅",
        });

        const lastReceipt = ca.last_receipt_json || null;

        const result = await financeSendBoletoByDoc({
          conversationId,
          headers: cwHeaders,
          cpfcnpj: cpfDigits,
          wa,
          silent: false,
        });

        if (lastReceipt && result?.boleto) {
          const match = receiptMatchesBoleto({ analysis: lastReceipt, boleto: result.boleto });

          console.log("🧾 [FIN] match comprovante vs boleto", {
            conversationId,
            ok: match.ok,
            level: match.level,
            boletoAmount: match.boletoAmount,
            paidAmount: match.paidAmount,
          });

          if (!match.ok) {
            await cwSendMessageRetry({
              conversationId,
              headers: cwHeaders,
              content:
                "⚠️ Pelo comprovante que você enviou, *não consegui confirmar* que o pagamento corresponde a este boleto em aberto.\n" +
                "Pode ser que tenha sido pago um mês diferente. Se quiser, reenvie o comprovante (ou me diga valor/data) que eu confiro certinho.",
            });
          } else {
            const idCliente = String(result?.idCliente || "");
            if (idCliente) {
              try {
                await rnNotificacaoPagamento({
                  baseUrl: RECEITANET_BASE_URL,
                  token: RECEITANET_TOKEN,
                  app: RECEITANET_APP,
                  idCliente,
                  contato: wa || "",
                });
              } catch {}
            }

            await cwSendMessageRetry({
              conversationId,
              headers: cwHeaders,
              content:
                "✅ Pelo comprovante, o pagamento *parece corresponder* ao boleto em aberto.\n" +
                "Se foi *PIX*, a liberação costuma ser imediata. Se foi *código de barras*, pode levar um prazo de compensação.\n" +
                "Se não liberar em alguns minutos, me avise aqui.",
            });
          }
        }

        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "finance_wait_need", bot_agent: "cassia" },
        });

        return;
      }

      // ============================
      // VENDAS (Isa)
      // ============================
      if (state === "sales_flow") {
        const persona = buildPersonaHeader("isa");
        const reply = await openaiChat({
          apiKey: OPENAI_API_KEY,
          model: OPENAI_MODEL,
          system: persona + "\nRegras:\n- Não envie menu numérico.\n- Seja objetiva.\n",
          user: customerText,
          maxTokens: 220,
        });

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content: reply || "Certo! Me diga seu bairro e cidade para eu te passar cobertura e planos.",
        });
        return;
      }

      // ============================
      // FALLBACK (GPT controlado)
      // ============================
      const persona = buildPersonaHeader(agent);
      const reply = await openaiChat({
        apiKey: OPENAI_API_KEY,
        model: OPENAI_MODEL,
        system: persona + "\nRegras:\n- Não repetir perguntas.\n- Não confundir 1/2/3.\n",
        user: customerText,
        maxTokens: 220,
      });

      await cwSendMessageRetry({
        conversationId,
        headers: cwHeaders,
        content: reply || "Certo! Pode me explicar um pouco melhor o que você precisa?",
      });
    } catch (err) {
      console.error("❌ Erro no webhook:", err);
    }
  });

  app.listen(PORT, () => console.log("🚀 Bot online na porta", PORT));
}

// ⚠️ Se você executa server.js direto (sem index.js), descomente:
// startServer();
