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
  rnVerificarAcesso,
  pickBestOverdueBoleto,
  formatBoletoWhatsApp,
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

      // ======================================
      // SUPORTE — aguardando CPF
      // ======================================
      if (state === "support_wait_doc") {
        const doc = onlyDigits(text);

        if (doc.length !== 11 && doc.length !== 14) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content: "Envie CPF ou CNPJ apenas com números.",
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
            content: "Cadastro não encontrado — confirme o CPF/CNPJ.",
          });
          return;
        }

        const acesso = await rnVerificarAcesso({
          baseUrl: RECEITANET_BASE_URL,
          token: RECEITANET_TOKEN,
          app: RECEITANET_APP,
          idCliente: client.data.idCliente,
        });

        // 🔴 pendência → boleto automático
        if (!acesso.ok) {
          const debitos = await rnListDebitos({
            baseUrl: RECEITANET_BASE_URL,
            token: RECEITANET_TOKEN,
            app: RECEITANET_APP,
            cpfcnpj: doc,
          });

          const boleto = pickBestOverdueBoleto(debitos);

          if (boleto) {
            await sendMessage({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers,
              content: formatBoletoWhatsApp(boleto),
            });
          } else {
            await sendMessage({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers,
              content: "Existe pendência, mas não consegui gerar boleto automático.",
            });
          }

          return;
        }

        // acesso normal
        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          content:
            "Seu acesso está ativo 👍\n\n" +
            "Desligue o roteador por 30s e me avise.",
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

      // ======================================
      // TRIAGEM
      // ======================================
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
            "Sem internet — me envie CPF/CNPJ para verificar acesso.",
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
