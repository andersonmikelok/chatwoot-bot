import express from "express";

import {
  normalizeText,
  onlyDigits,
  isIncomingMessage,
  extractConversationId,
  extractMessageText,
  detectIntent,
  mapNumericChoice,
  shouldIgnoreDuplicateEvent,
  buildPersonaHeader,
} from "./lib/utils.js";

import {
  chatwootSignInIfNeeded,
  getConversation,
  sendMessage,
  setCustomAttributesMerge,
  buildAuthHeaders,
} from "./lib/chatwoot.js";

import {
  rnFindClient,
  rnListDebitos,
} from "./lib/receitanet.js";

import { openaiChat } from "./lib/openai.js";

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

export function startServer() {
  const app = express();
  app.use(express.json());

  app.post("/chatwoot-webhook", async (req, res) => {
    res.send("ok");

    try {
      if (!isIncomingMessage(req.body)) return;
      if (shouldIgnoreDuplicateEvent(req.body)) return;

      const conversationId = extractConversationId(req.body);
      const text = normalizeText(extractMessageText(req.body));
      if (!text) return;

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

      console.log("🔥 fluxo", { conversationId, text, state });

      // =====================================
      // CONFIRMAÇÃO DE PAGAMENTO
      // =====================================
      if (state === "payment_check") {
        const doc = onlyDigits(text);

        if (doc.length !== 11 && doc.length !== 14) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content: "Envie CPF/CNPJ apenas com números.",
          });
          return;
        }

        const client = await rnFindClient({
          baseUrl: RECEITANET_BASE_URL,
          token: RECEITANET_TOKEN,
          app: RECEITANET_APP,
          cpfcnpj: doc,
        });

        if (!client.found) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content: "Cadastro não encontrado.",
          });
          return;
        }

        const debitos = await rnListDebitos({
          baseUrl: RECEITANET_BASE_URL,
          token: RECEITANET_TOKEN,
          app: RECEITANET_APP,
          cpfcnpj: doc,
        });

        if (!debitos.length) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content:
              "Pagamento identificado 👍\n\nAcesso normalizado.",
          });

          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            attrs: { bot_state: "triage" },
          });

          return;
        }

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          content:
            "Pagamento ainda não compensou.\n\nPode levar alguns minutos.",
        });

        return;
      }

      // =====================================
      // TRIAGEM
      // =====================================
      const numeric = mapNumericChoice(text);
      const intent = detectIntent(text, numeric);

      if (
        text.toLowerCase().includes("paguei") ||
        text.toLowerCase().includes("comprovante")
      ) {
        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          attrs: { bot_state: "payment_check" },
        });

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          content:
            "Perfeito — me envie CPF/CNPJ para confirmar pagamento.",
        });

        return;
      }

      const reply = await openaiChat({
        apiKey: OPENAI_API_KEY,
        model: OPENAI_MODEL,
        system: buildPersonaHeader("isa"),
        user: text,
      });

      await sendMessage({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers,
        content: reply,
      });

    } catch (err) {
      console.error("❌ erro:", err);
    }
  });

  app.listen(PORT, () => console.log("🚀 Bot online"));
}
