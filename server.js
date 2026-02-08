// server.js
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
// Helpers
// =====================
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

// ⚠️ Importante: addLabels() faz MERGE seguro no seu lib/chatwoot.js.
// Aqui só garantimos que enviamos tudo que queremos manter.
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

// "Fuga do menu" = não é 1/2/3 e tem texto
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

// ✅ Backup de triagem: evita loop quando cliente digita "Suporte/Financeiro/Planos"
// (sem depender do detectIntent do utils.js)
function normalizeTriageKeywordIntent(rawText) {
  const t = normalizeText(rawText).toLowerCase();

  if (!t) return null;

  // só palavras diretas / comuns (curtas e seguras)
  if (t === "suporte" || t === "tecnico" || t === "técnico" || t === "ajuda") return "support";
  if (t === "financeiro" || t === "cobranca" || t === "cobrança" || t === "pagamento") return "finance";
  if (t === "planos" || t === "plano" || t === "comercial" || t === "vendas") return "sales";

  return null;
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

      // ✅ GPT ON agora não depende só de label (porque label pode ser sobrescrita)
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
      // 1) GPT OFF => só contador, sem responder (menu SMSNET manda)
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

          // ✅ aplica label SEM apagar as outras
          const newLabels = await addLabelsMerged({
            currentLabels: labels,
            labelsToAdd: [LABEL_GPT_ON],
            cw: { baseUrl: CHATWOOT_URL, accountId: CHATWOOT_ACCOUNT_ID, conversationId, headers: cwHeaders },
          });

          // ✅ backup do “gpt_on” em custom_attributes
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
      // 2) GPT ON => NÃO roda contador / NÃO trata 1/2/3 como SMSNET
      // ======================================================

      // ✅ algumas integrações mandam "Menu" automaticamente; com GPT ON isso só atrapalha
      if (normalizeText(customerText).toLowerCase() === "menu" && attachments.length === 0) {
        console.log("🛑 ignorando texto 'Menu' com GPT ON");
        return;
      }

      // ✅ welcome_sent sem apagar gpt_on
      if (!labelSet.has(LABEL_WELCOME_SENT) && !ca.welcome_sent) {
        const merged = await addLabelsMerged({
          currentLabels: labels,
          labelsToAdd: [LABEL_GPT_ON, LABEL_WELCOME_SENT], // ✅ garante gpt_on junto
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
      // 3) Anexos => financeiro
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
            bot_state: "finance_wait_cpf_or_match",
            last_attachment_url: dataUrl || "",
            last_attachment_type: fileType,
          },
        });

        if (dataUrl) {
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
              attrs: { last_receipt_json: analysis || "" },
            });

            await sendMessage({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              content:
                "📎 *Recebi seu comprovante.*\n" +
                (analysis?.summaryText || "Consegui ler o comprovante.") +
                "\n\nPara eu conferir no sistema, me envie o *CPF ou CNPJ do titular* (somente números).",
            });

            return;
          }
        }

        if (!customerText) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "📎 Recebi seu arquivo. Me envie o *CPF ou CNPJ do titular* (somente números) para localizar no sistema.",
          });
          return;
        }
      }

      if (!customerText && attachments.length === 0) return;

      // ======================================================
// SUPORTE — manter fluxo quando já está em support_check
// ======================================================
if (state === "support_check") {
  const t = normalizeText(customerText).toLowerCase();

  // resposta válida do fluxo
  if (t.includes("todos") || t.includes("tudo")) {
    await sendMessage({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      content:
        "Entendi — a falha acontece em *todos os aparelhos*. 👍\n\n" +
        "Vou verificar seu acesso aqui no sistema e já te retorno. ✅",
    });

    // mantém estado (não volta pra triage)
    return;
  }

  if (t.includes("um") || t.includes("aparelho")) {
    await sendMessage({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      content:
        "Perfeito — está afetando apenas *um aparelho*. 👍\n\n" +
        "Tente desligar e ligar o Wi-Fi desse dispositivo e me diga se volta.",
    });

    return;
  }

  // fallback do suporte (GPT Anderson)
  const persona = buildPersonaHeader("anderson");
  const reply = await openaiChat({
    apiKey: OPENAI_API_KEY,
    model: OPENAI_MODEL,
    system: persona,
    user: customerText,
    maxTokens: 160,
  });

  await sendMessage({
    baseUrl: CHATWOOT_URL,
    accountId: CHATWOOT_ACCOUNT_ID,
    conversationId,
    headers: cwHeaders,
    content: reply || "Pode me explicar melhor o que está acontecendo?",
  });

  return;
}


      // ======================================================
      // 4) TRIAGEM (Isa) — 1/2/3 são atalhos do GPT, não SMSNET
      // ======================================================
      const numericChoice = mapNumericChoice(customerText);

      // detectIntent original
      let intent = detectIntent(customerText, numericChoice);

      // ✅ anti-loop: palavras diretas (Suporte/Financeiro/Planos)
      if (intent === "unknown") {
        const kw = normalizeTriageKeywordIntent(customerText);
        if (kw) intent = kw;
      }

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
            content: "Certo! Eu sou o *Anderson*, do suporte. 👍\nVocê está *sem internet* agora ou está *lento/instável*?",
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
      // 5) Fluxos específicos (placeholder) + fallback GPT
      // ======================================================

      // ✅ Ajuste de linguagem: evitar termos como “bloqueio”
      // Se estiver em support_check e cliente disser algo genérico, o fallback do Anderson resolve.
      // Para financeiro completo (boleto/pix/barras) a lógica fica em outro bloco caso você queira,
      // mas aqui mantemos o comportamento atual para não bagunçar o que já funciona.

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

