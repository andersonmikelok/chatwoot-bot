import express from "express";

import {
  normalizeText,
  normalizePhoneBR,
  isIncomingMessage,
  extractConversationId,
  extractMessageText,
  extractAttachments,
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

import { openaiChat } from "./lib/openai.js";

const PORT = process.env.PORT || 10000;

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CW_UID = process.env.CW_UID;
const CW_PASSWORD = process.env.CW_PASSWORD;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

export function startServer() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

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
      // 🟢 SUPORTE — ETAPA 1: confirmação do problema
      // =====================================================
      if (state === "support_check") {
        const t = text.toLowerCase();

        if (t.includes("todos")) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content:
              "Entendi — está acontecendo em *todos os aparelhos*. 👍\n\n" +
              "Vamos fazer um teste rápido:\n" +
              "👉 Desligue o roteador por 30 segundos e ligue novamente.\n\n" +
              "Me avise quando terminar.",
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

        if (t.includes("um")) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content:
              "Perfeito — apenas um aparelho.\n\n" +
              "Tente desligar o Wi-Fi desse dispositivo e reconectar.",
          });

          return;
        }

        // fallback GPT técnico
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

      // =====================================================
      // 🟢 SUPORTE — ETAPA 2: pós reboot
      // =====================================================
      if (state === "support_reboot") {
        const t = text.toLowerCase();

        if (t.includes("voltou") || t.includes("ok")) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content: "Perfeito! Internet normalizada. 👍",
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
            "Entendi — vou encaminhar para nosso técnico verificar a conexão. 👍",
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
      // 🔵 TRIAGEM PRINCIPAL
      // =====================================================
      const numeric = mapNumericChoice(text);
      const intent = detectIntent(text, numeric);

      if (intent === "support") {
        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          attrs: { bot_state: "support_check" },
        });

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          content:
            "Você está *sem internet* ou está *lento/instável*?\n\n" +
            "Está acontecendo em *um aparelho* ou em *todos*?",
        });

        return;
      }

      // fallback triagem
      await sendMessage({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers,
        content:
          "Posso te ajudar com:\n" +
          "👉 Suporte\n👉 Financeiro\n👉 Planos\n\n" +
          "Digite uma opção.",
      });
    } catch (err) {
      console.error("❌ erro server:", err);
    }
  });

  app.listen(PORT, () => console.log("🚀 Bot online"));
}
