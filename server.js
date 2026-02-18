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

const LABEL_GPT_ON = "gpt_on";
const LABEL_WELCOME_SENT = "gpt_welcome_sent";
const LABEL_GPT_MANUAL = "gpt_manual_on";

// =====================
// Helpers
// =====================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeLabelList(conv) {
  return (conv?.labels || []).map((x) => (typeof x === "string" ? x : x?.title)).filter(Boolean);
}

function assertEnv() {
  return true;
}

// =====================
// LOCK DE PROCESSAMENTO POR CONVERSA
// =====================
const processingQueues = new Map();

function enqueueProcess(conversationId, fn) {
  const key = String(conversationId);
  const prev = processingQueues.get(key) || Promise.resolve();

  const next = prev
    .catch(() => {})
    .then(fn)
    .finally(() => {
      if (processingQueues.get(key) === next) processingQueues.delete(key);
    });

  processingQueues.set(key, next);
  return next;
}

// =====================
// FILA DE ENVIO POR CONVERSA
// =====================
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
    await sendMessage({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers,
      content,
    });
    await sleep(delayMs);
  });
}

// =====================
// FINANCEIRO - ORDEM FORÇADA
// =====================
const INSTR_COPY_BAR = "🏷️ *Código de barras*";
const INSTR_COPY_PIX = "📌 *PIX copia e cola*";

function chunkString(str, maxLen = 1100) {
  const s = String(str || "");
  const parts = [];
  for (let i = 0; i < s.length; i += maxLen) parts.push(s.slice(i, i + maxLen));
  return parts;
}

async function financeSendBoletoPieces({ conversationId, headers, boleto, prefaceText = "" }) {
  const venc = boleto?.vencimento || "";
  const valor = boleto?.valor;
  const link = (boleto?.link || "").trim();
  const pix = (boleto?.qrcode_pix || "").trim();
  const barras = (boleto?.barras || "").trim();

  if (prefaceText) {
    await sendOrdered({ conversationId, headers, content: prefaceText, delayMs: 1500 });
  }

  const header = [];
  header.push("📄 *Boleto em aberto*");
  if (venc) header.push(`🗓️ *Vencimento:* ${venc}`);
  if (valor) header.push(`💰 *Valor:* R$ ${String(valor).replace(".", ",")}`);

  await sendOrdered({ conversationId, headers, content: header.join("\n"), delayMs: 1500 });

  if (barras) {
    await sendOrdered({ conversationId, headers, content: INSTR_COPY_BAR, delayMs: 1300 });
    await sendOrdered({ conversationId, headers, content: barras, delayMs: 1500 });
  }

  if (pix) {
    await sendOrdered({ conversationId, headers, content: INSTR_COPY_PIX, delayMs: 1300 });
    for (const part of chunkString(pix)) {
      await sendOrdered({ conversationId, headers, content: part, delayMs: 1500 });
    }
  }

  if (link) {
    await sendOrdered({
      conversationId,
      headers,
      content: `🔗 *Link do boleto:*\n${link}`,
      delayMs: 1600,
    });
  }
}

async function financeSendBoletoByDoc({
  conversationId,
  headers,
  cpfcnpj,
  wa,
  silent = false,
  skipPreface = false,
}) {
  const client = await rnFindClient({
    baseUrl: RECEITANET_BASE_URL,
    token: RECEITANET_TOKEN,
    app: RECEITANET_APP,
    cpfcnpj,
  });

  if (!client?.found) {
    await sendOrdered({
      conversationId,
      headers,
      content: "Não consegui localizar esse CPF/CNPJ. Envie novamente, por favor.",
    });
    return;
  }

  const debitos = await rnListDebitos({
    baseUrl: RECEITANET_BASE_URL,
    token: RECEITANET_TOKEN,
    app: RECEITANET_APP,
    cpfcnpj,
    status: 2,
  });

  const { boleto } = pickBestOverdueBoleto(debitos || []);

  if (!boleto) {
    await sendOrdered({
      conversationId,
      headers,
      content: "Não há boletos em aberto no momento.",
    });
    return;
  }

  const preface = skipPreface
    ? ""
    : "Perfeito 😊 Já localizei aqui.\nVou te enviar agora as informações do boleto (código de barras / PIX / link).";

  await financeSendBoletoPieces({
    conversationId,
    headers,
    boleto,
    prefaceText: preface,
  });

  await sendOrdered({
    conversationId,
    headers,
    content:
      "Pode pagar pela opção que for mais prática 🙂\n⚡ Pagando via *PIX*, a liberação costuma ser *imediata*.",
  });

  await sendOrdered({
    conversationId,
    headers,
    content:
      "👉 Se já pagou, envie o comprovante aqui. Vou validar o *mês correto* e agilizar! ✅",
  });
}

// =====================
// SERVER
// =====================
export function startServer() {
  const app = express();
  app.use(express.json({ limit: "15mb" }));

  app.post("/chatwoot-webhook", async (req, res) => {
    res.status(200).send("ok");

    if (!isIncomingMessage(req.body)) return;
    if (shouldIgnoreDuplicateEvent(req.body)) return;

    const conversationId = extractConversationId(req.body);
    if (!conversationId) return;

    enqueueProcess(conversationId, async () => {
      const text = normalizeText(extractMessageText(req.body));
      const attachments = extractAttachments(req.body);

      const headers = buildAuthHeaders(
        await chatwootSignInIfNeeded({
          baseUrl: CHATWOOT_URL,
          email: CW_UID,
          password: CW_PASSWORD,
        })
      );

      const conv = await getConversation({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers,
      });

      const labels = new Set(safeLabelList(conv));
      const gptOn = labels.has(LABEL_GPT_MANUAL);

      if (!gptOn) return;

      const intent = detectIntent(text, mapNumericChoice(text));

      if (intent === "finance") {
        await financeSendBoletoByDoc({
          conversationId,
          headers,
          cpfcnpj: text.replace(/\D+/g, ""),
          skipPreface: false,
        });
      }
    });
  });

  app.listen(PORT, () => console.log("🚀 Bot online na porta", PORT));
}
