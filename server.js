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

/**
 * ENV necessários (Render):
 * CHATWOOT_URL=https://chat.smsnet.com.br
 * CHATWOOT_ACCOUNT_ID=195
 * CW_UID=...
 * CW_PASSWORD=...
 *
 * OPENAI_API_KEY=...
 * OPENAI_MODEL=gpt-5.2
 *
 * ReceitaNet:
 * RECEITANET_BASE_URL=https://sistema.receitanet.net/api/novo/chatbot
 * RECEITANET_TOKEN=SEU_TOKEN_AQUI   (ou RECEITANET_CHATBOT_TOKEN)
 * RECEITANET_APP=chatbot
 *
 * AUTO_GPT_THRESHOLD=3 (opcional)
 */

const PORT = process.env.PORT || 10000;

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = String(process.env.CHATWOOT_ACCOUNT_ID || "");
const CW_UID = process.env.CW_UID || "";
const CW_PASSWORD = process.env.CW_PASSWORD || "";

const RECEITANET_BASE_URL = (process.env.RECEITANET_BASE_URL || "https://sistema.receitanet.net/api/novo/chatbot")
  .replace(/\/+$/, "");
const RECEITANET_TOKEN = process.env.RECEITANET_TOKEN || process.env.RECEITANET_CHATBOT_TOKEN || "";
const RECEITANET_APP = process.env.RECEITANET_APP || "chatbot";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

const LABEL_GPT_ON = "gpt_on";
const LABEL_WELCOME_SENT = "gpt_welcome_sent";

const AUTO_GPT_THRESHOLD = Number(process.env.AUTO_GPT_THRESHOLD || 3);

// =====================
// Helpers específicos do seu caso
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

// Considera menu do SMSNET apenas quando GPT ainda está OFF
function isSmsnetMenuAnswer(text) {
  const t = (text || "").trim();
  return t === "1" || t === "2" || t === "3";
}

// "Fuga do menu" = não é 1/2/3 e tem conteúdo
function isMenuEscape(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (isSmsnetMenuAnswer(t)) return false;
  return true;
}

// WhatsApp do payload
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

function safeLabelList(conv) {
  const arr = (conv?.labels || [])
    .map((x) => (typeof x === "string" ? x : x?.title))
    .filter(Boolean);
  return arr;
}

function hasLabel(conv, label) {
  return safeLabelList(conv).includes(label);
}

export function startServer() {
  const app = express();
  app.use(express.json({ limit: "15mb" }));

  app.get("/", (_req, res) => res.send("🚀 Bot online"));

  app.post("/chatwoot-webhook", async (req, res) => {
    // ACK rápido
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

      // garante login + headers válidos
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
      const agent = ca.bot_agent || "isa"; // isa | cassia | anderson

      const wa = extractWhatsAppFromPayload(req.body) || normalizePhoneBR(ca.whatsapp_phone || "");
      const menuIgnoreCount = Number(ca.menu_ignore_count || 0);

      console.log("🔥 chegando", {
        conversationId,
        text: customerText || "(vazio)",
        anexos: attachments.length,
        state,
        agent,
        wa: wa || null,
        labels,
        menu_ignore_count: menuIgnoreCount,
      });

      // salva whatsapp se mudou
      if (wa && wa !== (ca.whatsapp_phone || "")) {
        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { whatsapp_phone: wa },
        });
      }

      const gptOn = labelSet.has(LABEL_GPT_ON);

      // ======================================================
      // 1) GPT OFF => APENAS contador de fuga do menu (sem responder)
      // ======================================================
      if (!gptOn) {
        // Se respondeu o menu SMSNET (1/2/3), zera contador e deixa SMSNET atender
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

        // Se mandou algo fora do menu, incrementa contador
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

          // ainda não bateu o limite: NÃO RESPONDE (pra não ter 2 atendentes)
          if (nextCount < AUTO_GPT_THRESHOLD) return;

          // bateu o limite => ativa GPT
          console.log("⚡ GPT autoativado (limite atingido) => aplicando label gpt_on");

          await addLabels({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            labels: [LABEL_GPT_ON],
          });

          // zera contador e seta estado inicial
          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: {
              menu_ignore_count: 0,
              bot_state: "triage",
              bot_agent: "isa",
              welcome_sent: false,
            },
          });

          // Mensagem de “assumi” UMA vez
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "✅ Entendi. Vou te atender por aqui sem precisar do menu.",
          });

          // Envia triagem SEM “menu numérico obrigatório”
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "Eu sou a *Isa* 😊\n" +
              "Você precisa de *Suporte*, *Financeiro* (boleto/pagamento) ou *Planos/Contratar*?\n" +
              "Se preferir, pode responder com 1=Suporte, 2=Financeiro, 3=Planos.",
          });

          return;
        }

        // Se veio vazio/sem texto, não faz nada
        return;
      }

      // ======================================================
      // 2) GPT ON => NÃO roda contador e NÃO “volta pro menu SMSNET”
      // ======================================================

      // Welcome (1 vez) — mas sem travar conversa
      if (!labelSet.has(LABEL_WELCOME_SENT) && !ca.welcome_sent) {
        await addLabels({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          labels: [LABEL_WELCOME_SENT],
        });

        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "triage", bot_agent: "isa", welcome_sent: true },
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

        // se a msg atual veio vazia, encerra aqui
        if (!customerText && attachments.length === 0) return;
      }

      // ======================================================
      // 3) ANEXO (imagem/pdf) => manda para financeiro (Cassia)
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

        // fallback
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

      // se não tem texto e nem anexo, ignora
      if (!customerText && attachments.length === 0) return;

      // ======================================================
      // 4) TRIAGEM (Isa) — aceita texto OU 1/2/3 como atalhos
      // ======================================================
      const numericChoice = mapNumericChoice(customerText); // 1/2/3 ou null
      const intent = detectIntent(customerText, numericChoice);

      if (state === "triage") {
        if (intent === "support") {
          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { bot_agent: "anderson", bot_state: "support_check" },
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
            attrs: { bot_agent: "cassia", bot_state: "finance_wait_need" },
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
            attrs: { bot_agent: "isa", bot_state: "sales_flow" },
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

        // não entendeu: pergunta sem “o que o número representa”
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
      // 5) SUPORTE (Anderson)
      // ======================================================
      if (state === "support_check") {
        let client = null;

        // tenta achar por whatsapp primeiro
        if (wa) {
          console.log("🔎 ReceitaNet: buscando cliente por telefone", wa);
          client = await rnFindClient({
            baseUrl: RECEITANET_BASE_URL,
            token: RECEITANET_TOKEN,
            app: RECEITANET_APP,
            phone: wa,
          });
          console.log("🔎 ReceitaNet: retorno telefone", client?.found ? "found" : "not_found", client?.status || "");
        }

        // se usuário mandou CPF/CNPJ
        const cpfDigits = onlyDigits(customerText);
        const looksCpf = cpfDigits.length === 11 || cpfDigits.length === 14;

        if (!client?.found && looksCpf) {
          console.log("🔎 ReceitaNet: buscando cliente por CPF/CNPJ", cpfDigits);
          client = await rnFindClient({
            baseUrl: RECEITANET_BASE_URL,
            token: RECEITANET_TOKEN,
            app: RECEITANET_APP,
            cpfcnpj: cpfDigits,
          });
          console.log("🔎 ReceitaNet: retorno cpf", client?.found ? "found" : "not_found", client?.status || "");

          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { cpfcnpj: cpfDigits },
          });
        }

        if (!client?.found) {
          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "support_need_cpf" },
          });

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "Para eu *verificar seu acesso no sistema*, me envie o *CPF ou CNPJ do titular* (somente números).",
          });
          return;
        }

        const cpfUse = onlyDigits(String(client?.data?.cpfCnpj || client?.data?.cpfcnpj || ca.cpfcnpj || ""));
        console.log("✅ cliente identificado, cpfUse:", cpfUse);

        if (cpfUse) {
          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { cpfcnpj: cpfUse },
          });
        }

        console.log("🔎 ReceitaNet: listando débitos status=0", { cpfcnpj: cpfUse });
        const debitos = await rnListDebitos({
          baseUrl: RECEITANET_BASE_URL,
          token: RECEITANET_TOKEN,
          app: RECEITANET_APP,
          cpfcnpj: cpfUse,
          status: 0,
        });

        console.log("🔎 ReceitaNet: débitos retornados", {
          type: typeof debitos,
          isArray: Array.isArray(debitos),
          length: Array.isArray(debitos) ? debitos.length : null,
        });

        const overdue = pickBestOverdueBoleto(debitos);
        console.log("💳 pickBestOverdueBoleto:", overdue ? "FOUND" : "NOT_FOUND");

        if (overdue) {
          const boletoText = formatBoletoWhatsApp(overdue);
          console.log("💳 boletoText length:", (boletoText || "").length);

          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { bot_agent: "cassia", bot_state: "finance_wait_need" },
          });

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Encontrei *pendência financeira* que pode causar bloqueio. Vou te enviar o boleto para regularizar 👇",
          });

          // se o format voltar vazio, manda fallback com JSON
          if (boletoText && boletoText.trim().length > 0) {
            await sendMessage({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              content: boletoText,
            });
          } else {
            await sendMessage({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              content:
                "⚠️ Não consegui formatar o boleto automaticamente. Vou deixar os dados brutos aqui:\n\n" +
                "```json\n" +
                JSON.stringify(overdue, null, 2).slice(0, 3500) +
                "\n```",
            });
          }

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "Após pagar, me envie o *comprovante* aqui (foto/PDF). Eu confiro se foi o *mês correto* e te aviso o prazo de compensação.",
          });

          return;
        }

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content:
            "No sistema não aparece bloqueio por boleto vencido agora. Vamos fazer um teste rápido:\n" +
            "1) Desligue ONU/roteador por *2 minutos*\n" +
            "2) Ligue novamente e aguarde *2 minutos*\n\n" +
            "Me diga se voltou.",
        });

        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "support_wait_feedback" },
        });

        return;
      }

      if (state === "support_need_cpf") {
        const cpfDigits = onlyDigits(customerText);

        console.log("🧪 support_need_cpf recebeu:", cpfDigits);

        if (!(cpfDigits.length === 11 || cpfDigits.length === 14)) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Opa! Envie *CPF (11)* ou *CNPJ (14)*, somente números.",
          });
          return;
        }

        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { cpfcnpj: cpfDigits, bot_state: "support_check" },
        });

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content: "Perfeito. Vou verificar seu acesso no sistema e já te retorno. ✅",
        });

        // IMPORTANTÍSSIMO: não retorna “silencioso” — o próximo webhook continuará, mas aqui já voltamos ao handler.
        return;
      }

      // ======================================================
      // 6) FINANCEIRO (Cassia)
      // ======================================================
      if (state === "finance_wait_need") {
        const choice = mapNumericChoice(customerText);
        const need =
          choice === 1 || /boleto|2.? via|fatura/i.test(customerText)
            ? "boleto"
            : choice === 2 || /paguei|pagamento|comprov/i.test(customerText)
            ? "comprovante"
            : null;

        if (!need) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Você precisa de *boleto/2ª via* ou quer *validar pagamento/comprovante*? (atalhos: 1=Boleto, 2=Pagamento)",
          });
          return;
        }

        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { finance_need: need, bot_state: "finance_wait_cpf_or_match" },
        });

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content: "Certo. Me envie o *CPF ou CNPJ do titular* (somente números).",
        });
        return;
      }

      if (state === "finance_wait_cpf_or_match") {
        const cpfDigits = onlyDigits(customerText);

        console.log("🧪 finance_wait_cpf_or_match recebeu:", cpfDigits);

        if (!(cpfDigits.length === 11 || cpfDigits.length === 14)) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Para localizar no sistema, envie *CPF (11)* ou *CNPJ (14)*, somente números.",
          });
          return;
        }

        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { cpfcnpj: cpfDigits, bot_state: "finance_handle" },
        });

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content: "Beleza. Vou consultar o sistema e já te retorno. ✅",
        });

        console.log("🔎 ReceitaNet(finance): listando débitos status=0", { cpfcnpj: cpfDigits });
        const debitos = await rnListDebitos({
          baseUrl: RECEITANET_BASE_URL,
          token: RECEITANET_TOKEN,
          app: RECEITANET_APP,
          cpfcnpj: cpfDigits,
          status: 0,
        });

        const overdue = pickBestOverdueBoleto(debitos);
        console.log("💳 finance overdue:", overdue ? "FOUND" : "NOT_FOUND");

        if (overdue) {
          const boletoText = formatBoletoWhatsApp(overdue);
          console.log("💳 finance boletoText length:", (boletoText || "").length);

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Encontrei boleto em aberto. Segue para pagamento 👇",
          });

          if (boletoText && boletoText.trim().length > 0) {
            await sendMessage({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              content: boletoText,
            });
          } else {
            await sendMessage({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              content:
                "⚠️ Não consegui formatar o boleto automaticamente. Dados brutos:\n\n" +
                "```json\n" +
                JSON.stringify(overdue, null, 2).slice(0, 3500) +
                "\n```",
            });
          }

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "Após pagar, me envie o comprovante aqui (foto/PDF). Eu verifico se foi o *mês correto* e te aviso o prazo de compensação.",
          });
        } else {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "No momento não aparece boleto vencido no sistema. Se você pagou agora, me envie o comprovante para eu validar. ✅",
          });
        }

        return;
      }

      // ======================================================
      // 7) Fallback GPT (bem controlado)
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
