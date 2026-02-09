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
  formatBoletoWhatsApp,
} from "./lib/receitanet.js";

import { openaiAnalyzeImage, openaiChat } from "./lib/openai.js";

const PORT = process.env.PORT || 10000;

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CW_UID = process.env.CW_UID;
const CW_PASSWORD = process.env.CW_PASSWORD;

const RECEITANET_BASE_URL = process.env.RECEITANET_BASE_URL;
const RECEITANET_TOKEN = process.env.RECEITANET_CHATBOT_TOKEN;
const RECEITANET_APP = process.env.RECEITANET_APP || "chatbot";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

const LABEL_GPT_ON = "gpt_on";
const LABEL_WELCOME_SENT = "gpt_welcome_sent";

export function startServer() {
  const app = express();
  app.use(express.json({ limit: "15mb" }));

  app.post("/chatwoot-webhook", async (req, res) => {
    res.send("ok");
    try {
      if (!isIncomingMessage(req.body)) return;
      if (shouldIgnoreDuplicateEvent(req.body)) return;

      const conversationId = extractConversationId(req.body);
      const text = normalizeText(extractMessageText(req.body));
      const attachments = extractAttachments(req.body);

      const auth = await chatwootSignInIfNeeded({
        baseUrl: CHATWOOT_URL,
        email: CW_UID,
        password: CW_PASSWORD,
      });

      const headers = buildAuthHeaders(auth);

      const conv = await getConversation({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers,
      });

      const ca = conv.custom_attributes || {};
      const state = ca.bot_state || "triage";
      const agent = ca.bot_agent || "isa";

      // =========================
      // SUPORTE — manter estado
      // =========================
      if (state === "support_check") {
        const t = text.toLowerCase();

        if (t.includes("todos")) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content:
              "Entendi — o problema acontece em *todos os aparelhos*.\n\n" +
              "Vou verificar seu acesso aqui no sistema e já te retorno. ✅",
          });

          return;
        }

        if (t.includes("um")) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content:
              "Certo — apenas *um aparelho*.\n\n" +
              "Tente desligar e ligar o Wi-Fi desse dispositivo e me diga se volta.",
          });
          return;
        }

        const reply = await openaiChat({
          apiKey: OPENAI_API_KEY,
          model: OPENAI_MODEL,
          system: buildPersonaHeader("anderson"),
          user: text,
        });

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          content: reply,
        });
        return;
      }

      // =========================
      // TRIAGEM
      // =========================
      const numeric = mapNumericChoice(text);
      const intent = detectIntent(text, numeric);

      if (intent === "support") {
        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          attrs: { bot_state: "support_check", bot_agent: "anderson" },
        });

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          content:
            "Certo! Eu sou o *Anderson*, do suporte.\n\n" +
            "Você está *sem internet* ou está *lento/instável*?",
        });
        return;
      }

      await sendMessage({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers,
        content:
          "Para te direcionar certinho, me diga:\n" +
          "*Suporte*, *Financeiro* ou *Planos*.\n\n" +
          "Atalhos: 1=Suporte, 2=Financeiro, 3=Planos.",
      });
    } catch (e) {
      console.error("Erro:", e);
    }
  });

  app.listen(PORT, () => console.log("🚀 Bot online"));
}
