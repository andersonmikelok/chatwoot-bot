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

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = String(process.env.CHATWOOT_ACCOUNT_ID || "");
const CW_UID = process.env.CW_UID || "";
const CW_PASSWORD = process.env.CW_PASSWORD || "";

const RECEITANET_BASE_URL = (
  process.env.RECEITANET_BASE_URL || "https://sistema.receitanet.net/api/novo/chatbot"
).replace(/\/+$/, "");
const RECEITANET_TOKEN =
  process.env.RECEITANET_TOKEN || process.env.RECEITANET_CHATBOT_TOKEN || "";
const RECEITANET_APP = process.env.RECEITANET_APP || "chatbot";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

const LABEL_GPT_ON = "gpt_on";
const LABEL_WELCOME_SENT = "gpt_welcome_sent";

const AUTO_GPT_THRESHOLD = Number(process.env.AUTO_GPT_THRESHOLD || 3);

// =====================
// Helpers (LOCais)
// =====================
function onlyDigits(s) {
  return (s || "").toString().replace(/\D+/g, "");
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
  const arr = (conv?.labels || [])
    .map((x) => (typeof x === "string" ? x : x?.title))
    .filter(Boolean);
  return arr;
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

function normalizeTriageKeywordIntent(rawText) {
  const t = normalizeText(rawText).toLowerCase();
  if (!t) return null;

  if (t === "suporte" || t === "tecnico" || t === "técnico" || t === "ajuda") return "support";
  if (t === "financeiro" || t === "cobranca" || t === "cobrança" || t === "pagamento") return "finance";
  if (t === "planos" || t === "plano" || t === "comercial" || t === "vendas") return "sales";

  return null;
}

function extractCpfCnpjDigits(text) {
  const d = onlyDigits(text || "");
  if (d.length === 11 || d.length === 14) return d;
  return null;
}

function looksLikeYes(text) {
  const t = normalizeText(text).toLowerCase();
  return ["sim", "s", "ok", "voltou", "normalizou", "normal"].includes(t) || t.includes("voltou");
}

function looksLikeNo(text) {
  const t = normalizeText(text).toLowerCase();
  return ["nao", "não", "n", "negativo"].includes(t) || t.includes("nao voltou") || t.includes("não voltou");
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

      const auth = await chatwootSignInIfNeeded({
        baseUrl: CHATWOOT_URL,
        email: CW_UID,
        password: CW_PASSWORD,
      });
      const cwHeaders = buildAuthHeaders({ ...auth, uid: auth.uid || CW_UID });

      const conv = await getConversation({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers: cwHeaders,
      });

      const labels = safeLabelList(conv);
      const labelSet = new Set(labels);

      const ca = conv?.custom_attributes || {};
      const state = ca.bot_state || "triage";
      const agent = ca.bot_agent || "isa";

      const wa = extractWhatsAppFromPayload(req.body) || normalizePhoneBR(ca.whatsapp_phone || "");
      const menuIgnoreCount = Number(ca.menu_ignore_count || 0);

      const gptOn = labelSet.has(LABEL_GPT_ON) || ca.gpt_on === true;

      console.log("🔥 chegando", {
        conversationId,
        text: customerText || "(vazio)",
        anexos: attachments.length,
        state,
        agent,
        wa: wa || null,
        labels,
        menu_ignore_count: menuIgnoreCount,
        gpt_on: gptOn,
      });

      // salva whatsapp
      if (wa && wa !== (ca.whatsapp_phone || "")) {
        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { whatsapp_phone: wa },
        });
      }

      // ======================================================
      // 1) GPT OFF => só contador, sem responder
      // ======================================================
      if (!gptOn) {
        if (isSmsnetMenuAnswer(customerText)) {
          if (menuIgnoreCount !== 0) {
            await setCustomAttributesMerge({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              attrs: { menu_ignore_count: 0 },
            });
          }
          console.log("✅ respondeu menu SMSNET => zera contador e não interfere");
          return;
        }

        if (isMenuEscape(customerText)) {
          const nextCount = menuIgnoreCount + 1;
          console.log("🟡 ignorou menu", { conversationId, nextCount, limit: AUTO_GPT_THRESHOLD });

          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { menu_ignore_count: nextCount },
          });

          if (nextCount < AUTO_GPT_THRESHOLD) return;

          console.log("⚡ GPT autoativado (limite atingido) => aplicando label gpt_on");

          const newLabels = await addLabelsMerged({
            currentLabels: labels,
            labelsToAdd: [LABEL_GPT_ON],
            cw: { baseUrl: CHATWOOT_URL, accountId: CHATWOOT_ACCOUNT_ID, conversationId, headers: cwHeaders },
          });

          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: {
              gpt_on: true,
              menu_ignore_count: 0,
              bot_state: "triage",
              bot_agent: "isa",
              welcome_sent: false,
            },
          });

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "✅ Entendi. Vou te atender por aqui e agilizar pra você 😊",
          });

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "Eu sou a *Isa* 😊\n" +
              "Você precisa de *Suporte*, *Financeiro* (boleto/pagamento) ou *Planos/Contratar*?\n" +
              "Atalhos: 1=Suporte, 2=Financeiro, 3=Planos.",
          });

          console.log("🏷️ labels após ativar gpt_on:", newLabels);
          return;
        }

        return;
      }

      // ======================================================
      // 2) GPT ON => ignora "Menu" automático
      // ======================================================
      if (normalizeText(customerText).toLowerCase() === "menu" && attachments.length === 0) {
        console.log("🛑 ignorando texto 'Menu' com GPT ON");
        return;
      }

      // welcome
      if (!labelSet.has(LABEL_WELCOME_SENT) && !ca.welcome_sent) {
        const merged = await addLabelsMerged({
          currentLabels: labels,
          labelsToAdd: [LABEL_GPT_ON, LABEL_WELCOME_SENT],
          cw: { baseUrl: CHATWOOT_URL, accountId: CHATWOOT_ACCOUNT_ID, conversationId, headers: cwHeaders },
        });

        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { gpt_on: true, bot_state: "triage", bot_agent: "isa", welcome_sent: true },
        });

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content:
            "Oi! Eu sou a *Isa* da i9NET 😊\n" +
            "Como posso ajudar?\n" +
            "• *Suporte* (sem internet/lento)\n" +
            "• *Financeiro* (boleto/pagamento)\n" +
            "• *Planos/Contratar*\n\n" +
            "Atalhos: 1=Suporte, 2=Financeiro, 3=Planos.",
        });

        console.log("🏷️ labels após welcome:", merged);

        if (!customerText && attachments.length === 0) return;
      }

      // ======================================================
      // 3) LEITURA AUTOMÁTICA DE COMPROVANTE (ANEXO)
      // ======================================================
      if (attachments.length > 0) {
        const att = pickFirstAttachment(attachments);
        const dataUrl = att?.data_url || att?.dataUrl || null;
        const fileType = att?.file_type || att?.tipo_de_arquivo || "unknown";

        console.log("📎 anexo detectado", { fileType, hasDataUrl: Boolean(dataUrl) });

        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: {
            gpt_on: true,
            bot_agent: "cassia",
            bot_state: "finance_receipt_processing",
            last_attachment_url: dataUrl || "",
            last_attachment_type: fileType,
          },
        });

        if (!dataUrl) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "📎 Recebi seu arquivo. Me envie o *CPF ou CNPJ do titular* (somente números) para eu validar.",
          });
          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "finance_receipt_wait_doc" },
          });
          return;
        }

        const dl = await downloadAttachmentAsDataUrl({ baseUrl: CHATWOOT_URL, headers: cwHeaders, dataUrl });
        console.log("⬇️ download anexo", {
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

          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: {
              last_receipt_json: analysis || "",
              last_receipt_payer_doc: onlyDigits(analysis?.payer_doc || ""),
              last_receipt_amount: analysis?.amount || "",
              last_receipt_date: analysis?.date || "",
            },
          });

          const docFromReceipt = extractCpfCnpjDigits(analysis?.payer_doc || "");

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "📎 *Recebi seu comprovante.*\n" +
              (analysis?.summaryText || "Consegui ler o comprovante.") +
              "\n\nVou validar no sistema agora. ✅",
          });

          if (!docFromReceipt) {
            await sendMessage({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              content: "Para eu confirmar o pagamento, me envie o *CPF ou CNPJ do titular* (somente números).",
            });
            await setCustomAttributesMerge({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              attrs: { bot_state: "finance_receipt_wait_doc" },
            });
            return;
          }

          // Confirma pagamento: se não tem débitos em aberto => OK
          try {
            const client = await rnFindClient({
              baseUrl: RECEITANET_BASE_URL,
              token: RECEITANET_TOKEN,
              app: RECEITANET_APP,
              cpfcnpj: docFromReceipt,
              phone: wa || "",
            });

            if (!client.found) {
              await sendMessage({
                baseUrl: CHATWOOT_URL,
                accountId: CHATWOOT_ACCOUNT_ID,
                conversationId,
                headers: cwHeaders,
                content:
                  "Não consegui localizar esse CPF/CNPJ no sistema. Me envie o CPF/CNPJ do *titular do contrato* (somente números).",
              });
              await setCustomAttributesMerge({
                baseUrl: CHATWOOT_URL,
                accountId: CHATWOOT_ACCOUNT_ID,
                conversationId,
                headers: cwHeaders,
                attrs: { bot_state: "finance_receipt_wait_doc" },
              });
              return;
            }

            const debitos = await rnListDebitos({
              baseUrl: RECEITANET_BASE_URL,
              token: RECEITANET_TOKEN,
              app: RECEITANET_APP,
              cpfcnpj: docFromReceipt,
              status: 0,
            });

            if (!Array.isArray(debitos) || debitos.length === 0) {
              await sendMessage({
                baseUrl: CHATWOOT_URL,
                accountId: CHATWOOT_ACCOUNT_ID,
                conversationId,
                headers: cwHeaders,
                content:
                  "✅ *Pagamento identificado no sistema!* Obrigado.\n" +
                  "Se o acesso ainda estiver com problema, me diga se é *sem internet* ou *lento* que eu te ajudo no suporte.",
              });

              await setCustomAttributesMerge({
                baseUrl: CHATWOOT_URL,
                accountId: CHATWOOT_ACCOUNT_ID,
                conversationId,
                headers: cwHeaders,
                attrs: { bot_state: "triage", bot_agent: "isa" },
              });
              return;
            }

            await sendMessage({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              content:
                "⏳ Ainda aparece pendência em aberto aqui. Pode levar alguns minutos para compensar.\n" +
                "Se quiser, eu te mando a 2ª via do boleto também.",
            });

            // Envia boleto automaticamente também (se houver)
            const boleto = pickBestOverdueBoleto(debitos);
            if (boleto) {
              await sendMessage({
                baseUrl: CHATWOOT_URL,
                accountId: CHATWOOT_ACCOUNT_ID,
                conversationId,
                headers: cwHeaders,
                content: formatBoletoWhatsApp(boleto),
              });
            }

            await setCustomAttributesMerge({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              attrs: { bot_state: "finance_wait_need", bot_agent: "cassia" },
            });
            return;
          } catch (e) {
            console.error("❌ erro confirmação via comprovante:", e?.message || e);
            await sendMessage({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              content:
                "Tive uma instabilidade ao validar no sistema. Me envie o *CPF/CNPJ do titular* (somente números) para eu confirmar.",
            });
            await setCustomAttributesMerge({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              attrs: { bot_state: "finance_receipt_wait_doc" },
            });
            return;
          }
        }

        // não é imagem ou maior que 4MB
        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content: "📎 Recebi seu arquivo. Me envie o *CPF ou CNPJ do titular* (somente números) para eu validar.",
        });
        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "finance_receipt_wait_doc" },
        });
        return;
      }

      // ======================================================
      // 4) FINANCEIRO: aguardando CPF/CNPJ depois do comprovante
      // ======================================================
      if (state === "finance_receipt_wait_doc") {
        const doc = extractCpfCnpjDigits(customerText);
        if (!doc) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Me envie o *CPF ou CNPJ* (somente números), por favor.",
          });
          return;
        }

        const client = await rnFindClient({
          baseUrl: RECEITANET_BASE_URL,
          token: RECEITANET_TOKEN,
          app: RECEITANET_APP,
          cpfcnpj: doc,
          phone: wa || "",
        });

        if (!client.found) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Não encontrei esse CPF/CNPJ no sistema. Confere e me envie novamente (somente números).",
          });
          return;
        }

        const debitos = await rnListDebitos({
          baseUrl: RECEITANET_BASE_URL,
          token: RECEITANET_TOKEN,
          app: RECEITANET_APP,
          cpfcnpj: doc,
          status: 0,
        });

        if (!Array.isArray(debitos) || debitos.length === 0) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "✅ *Pagamento identificado no sistema!* Obrigado. 😊",
          });

          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "triage", bot_agent: "isa" },
          });
          return;
        }

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content:
            "⏳ Ainda consta pendência em aberto. Pode levar alguns minutos para compensar.\n" +
            "Se quiser, eu envio a 2ª via do boleto agora.",
        });

        const boleto = pickBestOverdueBoleto(debitos);
        if (boleto) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: formatBoletoWhatsApp(boleto),
          });
        }

        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "finance_wait_need", bot_agent: "cassia" },
        });
        return;
      }

      // ======================================================
      // 5) SUPORTE (anti-loop): estados não podem cair para triage
      // ======================================================
      if (state === "support_check") {
        const t = normalizeText(customerText).toLowerCase();

        if (t.includes("sem internet") || t.includes("sem sinal") || t === "sem") {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Entendi 👍 Está acontecendo em *um aparelho* ou em *todos*?",
          });
          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "support_scope_devices", bot_agent: "anderson" },
          });
          return;
        }

        if (t.includes("lento") || t.includes("inst") || t.includes("oscila")) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "Certo 👍 É no *Wi-Fi* ou também no *cabo*?\n" +
              "Responda: *wifi*, *cabo* ou *ambos*.",
          });
          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "support_quality_scope", bot_agent: "anderson" },
          });
          return;
        }

        const persona = buildPersonaHeader("anderson");
        const reply = await openaiChat({
          apiKey: OPENAI_API_KEY,
          model: OPENAI_MODEL,
          system: persona,
          user: customerText,
          maxTokens: 170,
        });

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content: reply || "Pode me dizer se é *sem internet* ou *lento/instável*?",
        });
        return;
      }

      if (state === "support_scope_devices") {
        const t = normalizeText(customerText).toLowerCase();

        if (t.includes("todos") || t.includes("tudo") || t.includes("nenhum") || t.includes("geral")) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "Entendi — em *todos os aparelhos*. ✅\n" +
              "Vou verificar seu acesso no sistema.\n" +
              "Me envie o *CPF/CNPJ do titular* (somente números).",
          });

          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "support_wait_doc", bot_agent: "anderson" },
          });
          return;
        }

        if (t.includes("um") || t.includes("só um") || t.includes("apenas um")) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "Certo — apenas *um aparelho*. 👍\n" +
              "Tente: *esquecer a rede Wi-Fi* e conectar novamente.\n" +
              "Se continuar, me diga qual aparelho é (celular/TV/notebook).",
          });
          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "support_single_device_help", bot_agent: "anderson" },
          });
          return;
        }

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content: "Só pra eu confirmar: é em *um aparelho* ou em *todos*?",
        });
        return;
      }

      if (state === "support_wait_doc") {
        const doc = extractCpfCnpjDigits(customerText);
        if (!doc) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Me envie o *CPF ou CNPJ* (somente números), por favor.",
          });
          return;
        }

        const client = await rnFindClient({
          baseUrl: RECEITANET_BASE_URL,
          token: RECEITANET_TOKEN,
          app: RECEITANET_APP,
          cpfcnpj: doc,
          phone: wa || "",
        });

        if (!client.found) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Não encontrei esse CPF/CNPJ no sistema. Confere e me envie novamente (somente números).",
          });
          return;
        }

        const idCliente = client?.data?.idCliente || client?.data?.id || client?.data?.cliente_id || "";

        const rAcesso = await rnVerificarAcesso({
          baseUrl: RECEITANET_BASE_URL,
          token: RECEITANET_TOKEN,
          app: RECEITANET_APP,
          idCliente,
          contato: wa || "",
        });

        if (!rAcesso.ok) {
          const debitos = await rnListDebitos({
            baseUrl: RECEITANET_BASE_URL,
            token: RECEITANET_TOKEN,
            app: RECEITANET_APP,
            cpfcnpj: doc,
            status: 0,
          });

          const boleto = pickBestOverdueBoleto(debitos);
          if (boleto) {
            await sendMessage({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              content:
                formatBoletoWhatsApp(boleto) +
                "\n\nApós o pagamento, envie o *comprovante* aqui que eu confirmo pra você. ✅",
            });
            await setCustomAttributesMerge({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              attrs: { bot_state: "finance_wait_need", bot_agent: "cassia" },
            });
            return;
          }

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "Identifiquei uma pendência e não consegui gerar o boleto automaticamente agora.\n" +
              "Você quer *boleto/2ª via* ou prefere *PIX*?",
          });

          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "finance_wait_need", bot_agent: "cassia" },
          });
          return;
        }

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content:
            "✅ Seu acesso está *normal* no sistema.\n" +
            "Teste rápido: desligue o roteador/ONT por *30 segundos*, ligue novamente e me diga se voltou.",
        });

        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "support_reboot", bot_agent: "anderson" },
        });
        return;
      }

      if (state === "support_reboot") {
        if (looksLikeYes(customerText)) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Perfeito! ✅ Internet normalizada. Posso ajudar em mais alguma coisa?",
          });
          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "triage", bot_agent: "isa" },
          });
          return;
        }

        if (looksLikeNo(customerText)) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "Entendi. Vou encaminhar para o time técnico verificar a conexão. 👍\n" +
              "Se puder, me diga se alguma luz da ONU/roteador está *vermelha* ou *piscando* (ex: LOS).",
          });
          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "support_escalated", bot_agent: "anderson" },
          });
          return;
        }

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content: "Só confirmando: após reiniciar, *voltou* ou *não voltou*?",
        });
        return;
      }

      // ======================================================
      // 6) TRIAGEM
      // ======================================================
      if (!customerText && attachments.length === 0) return;

      const numericChoice = mapNumericChoice(customerText);
      let intent = detectIntent(customerText, numericChoice);
      if (intent === "unknown") {
        const kw = normalizeTriageKeywordIntent(customerText);
        if (kw) intent = kw;
      }
      if (isPaymentIntent(customerText)) intent = "finance";

      if (state === "triage") {
        if (intent === "support") {
          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { gpt_on: true, bot_agent: "anderson", bot_state: "support_check" },
          });

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "Certo! Eu sou o *Anderson*, do suporte. 👍\n" +
              "Você está *sem internet* agora ou está *lento/instável*?",
          });
          return;
        }

        if (intent === "finance") {
          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { gpt_on: true, bot_agent: "cassia", bot_state: "finance_wait_need" },
          });

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "Oi! Eu sou a *Cassia*, do financeiro. 💳\n" +
              "Você precisa de *boleto/2ª via* ou quer *validar pagamento/comprovante*?\n" +
              "Atalhos: 1=Boleto, 2=Pagamento.",
          });
          return;
        }

        if (intent === "sales") {
          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { gpt_on: true, bot_agent: "isa", bot_state: "sales_flow" },
          });

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Perfeito! Me diga seu *bairro* e *cidade* para eu te informar cobertura e planos. 😊",
          });
          return;
        }

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content:
            "Para eu te direcionar certinho, me diga: *Suporte*, *Financeiro* ou *Planos*.\n" +
            "Atalhos: 1=Suporte, 2=Financeiro, 3=Planos.",
        });
        return;
      }

      // ======================================================
      // 7) fallback GPT por persona
      // ======================================================
      const persona = buildPersonaHeader(agent);
      const reply = await openaiChat({
        apiKey: OPENAI_API_KEY,
        model: OPENAI_MODEL,
        system: persona,
        user: customerText,
        maxTokens: 180,
      });

      await sendMessage({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
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
