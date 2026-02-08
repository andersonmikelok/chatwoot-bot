import express from "express";

import {
  normalizeText,
  onlyDigits,
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
  pickBestOverdueBoleto,
  formatBoletoWhatsApp,
} from "./lib/receitanet.js";

import { openaiAnalyzeImage, openaiChat } from "./lib/openai.js";

const PORT = process.env.PORT || 10000;

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = String(process.env.CHATWOOT_ACCOUNT_ID || "");
const CW_UID = process.env.CW_UID || "";
const CW_PASSWORD = process.env.CW_PASSWORD || "";

const RECEITANET_BASE_URL =
  (process.env.RECEITANET_BASE_URL || "").replace(/\/+$/, "");
const RECEITANET_TOKEN =
  process.env.RECEITANET_TOKEN || process.env.RECEITANET_CHATBOT_TOKEN || "";
const RECEITANET_APP = process.env.RECEITANET_APP || "chatbot";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

const LABEL_GPT_ON = "gpt_on";
const LABEL_WELCOME = "gpt_welcome_sent";

const MENU_LIMIT = 3;

function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!CW_UID) missing.push("CW_UID");
  if (!CW_PASSWORD) missing.push("CW_PASSWORD");
  if (!RECEITANET_BASE_URL) missing.push("RECEITANET_BASE_URL");
  if (!RECEITANET_TOKEN) missing.push("RECEITANET_TOKEN");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");

  if (missing.length) {
    console.log("❌ ENV faltando:", missing.join(", "));
    return false;
  }
  return true;
}

export function startServer() {
  const app = express();
  app.use(express.json({ limit: "15mb" }));

  app.get("/", (_, res) => res.send("🚀 Bot online"));

  app.post("/chatwoot-webhook", async (req, res) => {
    res.status(200).send("ok");

    try {
      if (!assertEnv()) return;
      if (!isIncomingMessage(req.body)) return;
      if (shouldIgnoreDuplicateEvent(req.body)) return;

      const conversationId = extractConversationId(req.body);
      if (!conversationId) return;

      const textRaw = extractMessageText(req.body);
      const text = normalizeText(textRaw);
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

      const labels = new Set(
        (conv?.labels || []).map((l) =>
          typeof l === "string" ? l : l?.title
        )
      );

      const ca = conv?.custom_attributes || {};
      const state = ca.bot_state || "triage";
      const agent = ca.bot_agent || "isa";

      console.log("🔥 incoming", {
        conversationId,
        text,
        state,
        agent,
        labels: [...labels],
      });

      // --------------------------------
      // CONTADOR IGNORAR MENU
      // --------------------------------
      if (!labels.has(LABEL_GPT_ON)) {
        let count = ca.menu_ignore_count || 0;

        const numeric = mapNumericChoice(text);

        if (!numeric && text) {
          count++;
          console.log("🟡 ignorou menu", { count });

          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            attrs: { menu_ignore_count: count },
          });
        }

        if (count >= MENU_LIMIT) {
          console.log("⚡ GPT ativado após ignorar menu");

          await addLabels({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            labels: [LABEL_GPT_ON],
          });

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content:
              "Entendi — vou te atender direto por aqui sem menu. 😊",
          });
        }

        return;
      }

      // --------------------------------
      // WELCOME
      // --------------------------------
      if (!labels.has(LABEL_WELCOME)) {
        await addLabels({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          labels: [LABEL_WELCOME],
        });

        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          attrs: { bot_state: "triage", bot_agent: "isa" },
        });

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          content:
            "Oi! Eu sou a *Isa* 😊\n1️⃣ Suporte\n2️⃣ Financeiro\n3️⃣ Planos",
        });

        return;
      }

      // --------------------------------
      // CPF FLOW SUPORTE
      // --------------------------------
      if (state === "support_need_cpf") {
        const cpf = onlyDigits(text);

        console.log("🧪 CPF recebido:", cpf);

        if (!(cpf.length === 11 || cpf.length === 14)) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content: "Envie CPF/CNPJ somente números.",
          });
          return;
        }

        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          attrs: { cpfcnpj: cpf, bot_state: "support_check" },
        });

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          content:
            "Perfeito — vou verificar seu acesso no sistema. ✅",
        });

        return;
      }

      // --------------------------------
      // CONSULTA RECEITANET
      // --------------------------------
      if (state === "support_check") {
        const cpf = ca.cpfcnpj;

        console.log("🧪 consultando ReceitaNet:", cpf);

        const debitos = await rnListDebitos({
          baseUrl: RECEITANET_BASE_URL,
          token: RECEITANET_TOKEN,
          app: RECEITANET_APP,
          cpfcnpj: cpf,
          status: 0,
        });

        console.log("🧪 resposta ReceitaNet:", debitos);

        const overdue = pickBestOverdueBoleto(debitos);

        if (overdue) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content:
              "Identifiquei boleto em aberto — segue para regularização 👇",
          });

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content: formatBoletoWhatsApp(overdue),
          });

          return;
        }

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          content:
            "Seu acesso está normal. Reinicie o roteador por 2 minutos e me diga se voltou.",
        });

        return;
      }

      // --------------------------------
      // FALLBACK GPT CONTROLADO
      // --------------------------------
      const persona = buildPersonaHeader(agent);

      const reply = await openaiChat({
        apiKey: OPENAI_API_KEY,
        model: OPENAI_MODEL,
        system: persona,
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
      console.error("❌ erro webhook:", err);
    }
  });

  app.listen(PORT, () => console.log("🚀 server rodando", PORT));
}
