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
  rnVerificarAcesso,
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
      if (!conversationId) return;

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

      // =====================================================
      // SUPORTE — aguardando CPF
      // =====================================================
      if (state === "support_wait_doc") {
        const doc = onlyDigits(text);

        if (doc.length !== 11 && doc.length !== 14) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content: "Envie apenas CPF ou CNPJ com números.",
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
            content: "Não encontrei cadastro — confirma o CPF/CNPJ?",
          });
          return;
        }

        const acesso = await rnVerificarAcesso({
          baseUrl: RECEITANET_BASE_URL,
          token: RECEITANET_TOKEN,
          app: RECEITANET_APP,
          idCliente: client.data.idCliente,
        });

        if (!acesso.ok) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content:
              "Identifiquei uma pendência financeira.\n" +
              "Posso enviar o boleto agora.",
          });
          return;
        }

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          content:
            "Seu acesso está normal 👍\n\n" +
            "Desligue o roteador por 30 segundos e me avise.",
        });

        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          attrs: { bot_state: "support_reboot" },
        });

        return;
      }

      // =====================================================
      // SUPORTE — reboot
      // =====================================================
      if (state === "support_reboot") {
        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          content:
            "Se ainda não voltou, vou encaminhar para o técnico 👍",
        });

        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          attrs: { bot_state: "support_escalated" },
        });

        return;
      }

      // =====================================================
      // TRIAGEM
      // =====================================================
      const numeric = mapNumericChoice(text);
      const intent = detectIntent(text, numeric);

      if (intent === "support") {
        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          attrs: { bot_state: "support_wait_doc" },
        });

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          content:
            "Entendi — sem internet.\n\n" +
            "Me envie o CPF/CNPJ para verificar seu acesso.",
        });

        return;
      }

      // fallback GPT
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
