// server.js (COMPLETO) — Chatwoot (SMSNET) + GPT + ReceitaNet + 3 atendentes (Isa/Triagem, Cassia/Financeiro, Anderson/Suporte)
//
// ✅ Principais correções neste arquivo:
// 1) NÃO ativa GPT sempre: só ativa após 3 “fugas do menu” (AUTO_GPT_THRESHOLD) OU comando #gpt on
// 2) Evita “dois atendentes” (SMSNET + GPT): enquanto não tiver gpt_on, o bot fica quieto (não responde)
// 3) Suporte: quando o cliente envia CPF/CNPJ, agora o fluxo CONTINUA e consulta ReceitaNet (não trava no “vou verificar…”)
// 4) Financeiro: quando achar boleto, envia de fato o boleto formatado (e loga se vier vazio)
//
// ENV necessários (Render):
// CHATWOOT_URL=https://chat.smsnet.com.br
// CHATWOOT_ACCOUNT_ID=195
// CW_UID=...
// CW_PASSWORD=...
//
// OPENAI_API_KEY=...
// OPENAI_MODEL=gpt-5.2
//
// ReceitaNet:
// RECEITANET_BASE_URL=https://sistema.receitanet.net/api/novo/chatbot
// RECEITANET_TOKEN=SEU_TOKEN_AQUI   (ou RECEITANET_CHATBOT_TOKEN)
// RECEITANET_APP=chatbot
//
// Controle:
// AUTO_GPT_THRESHOLD=3  (opcional)

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

const RECEITANET_BASE_URL = (process.env.RECEITANET_BASE_URL || "https://sistema.receitanet.net/api/novo/chatbot").replace(
  /\/+$/,
  ""
);
const RECEITANET_TOKEN = process.env.RECEITANET_TOKEN || process.env.RECEITANET_CHATBOT_TOKEN || "";
const RECEITANET_APP = process.env.RECEITANET_APP || "chatbot";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

// Labels
const LABEL_GPT_ON = "gpt_on";
const LABEL_WELCOME_SENT = "gpt_welcome_sent";

// Auto GPT
const FUGA_LIMIT = Number(process.env.AUTO_GPT_THRESHOLD || 3);

// throttle simples anti-repetição
const recentSent = new Map();
function shouldThrottle(conversationId, text, ms = 6000) {
  const now = Date.now();
  const prev = recentSent.get(conversationId);
  if (prev && prev.text === text && now - prev.ts < ms) return true;
  recentSent.set(conversationId, { text, ts: now });
  return false;
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

function isMenuChoice(text) {
  const t = normalizeText(text);
  return ["1", "2", "3"].includes(t);
}

function isGptCommandOn(text) {
  const t = normalizeText(text).toLowerCase();
  return t === "#gpt on" || t === "#gpt ligar" || t === "#gpt ligado" || t === "#gpt ativar";
}
function isGptCommandOff(text) {
  const t = normalizeText(text).toLowerCase();
  return t === "#gpt off" || t === "#gpt desligar" || t === "#gpt desativar";
}

async function safeSend({ baseUrl, accountId, conversationId, headers, content }) {
  if (!content) return;
  if (shouldThrottle(conversationId, content, 4500)) return;
  return sendMessage({ baseUrl, accountId, conversationId, headers, content });
}

async function ensureAuthAndHeaders() {
  const auth = await chatwootSignInIfNeeded({ baseUrl: CHATWOOT_URL, email: CW_UID, password: CW_PASSWORD });
  const cwHeaders = buildAuthHeaders({ ...auth, uid: auth.uid || CW_UID });
  return { auth, cwHeaders };
}

// ------------------------------
// HANDLERS
// ------------------------------

async function handleSupportFlow({
  conversationId,
  cwHeaders,
  conv,
  ca,
  customerText,
  waNormalized,
}) {
  const storedCpf = ca.cpfcnpj || "";

  // 1) Tentar achar cliente por whatsapp
  let client = null;
  if (waNormalized) {
    client = await rnFindClient({
      baseUrl: RECEITANET_BASE_URL,
      token: RECEITANET_TOKEN,
      app: RECEITANET_APP,
      phone: waNormalized,
    });
  }

  // 2) Se veio CPF/CNPJ na mensagem, prioriza
  const digits = onlyDigits(customerText);
  const looksCpf = digits.length === 11 || digits.length === 14;
  if (looksCpf) {
    client = await rnFindClient({
      baseUrl: RECEITANET_BASE_URL,
      token: RECEITANET_TOKEN,
      app: RECEITANET_APP,
      cpfcnpj: digits,
    });

    await setCustomAttributesMerge({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      attrs: { cpfcnpj: digits },
    });
  }

  // 3) Se ainda não achou, pedir CPF/CNPJ
  if (!client?.found) {
    await setCustomAttributesMerge({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      attrs: { bot_agent: "anderson", bot_state: "support_need_cpf" },
    });

    await safeSend({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      content:
        "Não consegui localizar seu cadastro pelo WhatsApp.\nMe envie o *CPF ou CNPJ do titular* (somente números) para eu verificar seu acesso e possíveis bloqueios.",
    });
    return;
  }

  // 4) Achou cliente -> checar débitos
  const cpfFromApi =
    client?.data?.cpfCnpj ||
    client?.data?.cpfcnpj ||
    client?.data?.cpf_cnpj ||
    storedCpf ||
    "";

  const cpfUse = onlyDigits(String(cpfFromApi || ""));
  if (cpfUse) {
    await setCustomAttributesMerge({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      attrs: { cpfcnpj: cpfUse },
    });
  }

  const debitos = await rnListDebitos({
    baseUrl: RECEITANET_BASE_URL,
    token: RECEITANET_TOKEN,
    app: RECEITANET_APP,
    cpfcnpj: cpfUse,
    status: 0,
  });

  const overdue = pickBestOverdueBoleto(debitos);

  if (overdue) {
    await setCustomAttributesMerge({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      attrs: { bot_agent: "cassia", bot_state: "finance_wait_need", finance_need: "boleto" },
    });

    await safeSend({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      content:
        "Encontrei *bloqueio por inadimplência* (boleto em aberto). Vou te enviar agora para regularizar. 👇",
    });

    const boletoMsg = formatBoletoWhatsApp(overdue);
    if (!boletoMsg || boletoMsg.trim().length < 10) {
      console.log("⚠️ formatBoletoWhatsApp retornou vazio/curto. overdue=", overdue);
      await safeSend({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers: cwHeaders,
        content:
          "Encontrei boleto em aberto, mas tive dificuldade de montar a mensagem automática.\nMe confirme o CPF/CNPJ do titular e eu envio o link/linha digitável já já.",
      });
      return;
    }

    await safeSend({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      content: boletoMsg,
    });

    await safeSend({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      content:
        "Assim que pagar, me envie o *comprovante* aqui (foto/PDF). Eu confiro se foi o mês correto e te explico o prazo de compensação.",
    });

    return;
  }

  // 5) Sem bloqueio por boleto -> procedimento técnico
  await setCustomAttributesMerge({
    baseUrl: CHATWOOT_URL,
    accountId: CHATWOOT_ACCOUNT_ID,
    conversationId,
    headers: cwHeaders,
    attrs: { bot_agent: "anderson", bot_state: "support_wait_feedback" },
  });

  await safeSend({
    baseUrl: CHATWOOT_URL,
    accountId: CHATWOOT_ACCOUNT_ID,
    conversationId,
    headers: cwHeaders,
    content:
      "No sistema não aparece boleto vencido/bloqueio agora.\nVamos fazer um teste rápido:\n1) Desligue ONU/roteador por *2 minutos*\n2) Ligue novamente\n3) Aguarde *2 minutos*\n\nDepois me diga: voltou?",
  });
}

async function handleFinanceFlow({
  conversationId,
  cwHeaders,
  ca,
  customerText,
}) {
  const state = ca.bot_state || "triage";

  // finance_wait_need: escolher boleto vs comprovante
  if (state === "finance_wait_need") {
    const choice = mapNumericChoice(customerText);
    const need =
      choice === 1 || /boleto|2.? via|fatura/i.test(customerText)
        ? "boleto"
        : choice === 2 || /paguei|pagamento|comprov/i.test(customerText)
        ? "comprovante"
        : null;

    if (!need) {
      await safeSend({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers: cwHeaders,
        content: "Me diga: você quer *1) boleto/2ª via* ou *2) validar pagamento/comprovante*?",
      });
      return;
    }

    await setCustomAttributesMerge({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      attrs: { finance_need: need, bot_state: "finance_wait_cpf_or_match", bot_agent: "cassia" },
    });

    await safeSend({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      content: "Certo. Me envie o *CPF ou CNPJ do titular* (somente números).",
    });
    return;
  }

  // finance_wait_cpf_or_match: receber CPF/CNPJ e gerar boleto se houver
  if (state === "finance_wait_cpf_or_match") {
    const cpfDigits = onlyDigits(customerText);
    if (!(cpfDigits.length === 11 || cpfDigits.length === 14)) {
      await safeSend({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers: cwHeaders,
        content: "Para eu localizar no sistema: envie *CPF (11)* ou *CNPJ (14)*, somente números.",
      });
      return;
    }

    await setCustomAttributesMerge({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      attrs: { cpfcnpj: cpfDigits, bot_state: "finance_handle", bot_agent: "cassia" },
    });

    await safeSend({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      content: "Beleza. Vou consultar o sistema e já te retorno. ✅",
    });

    const debitos = await rnListDebitos({
      baseUrl: RECEITANET_BASE_URL,
      token: RECEITANET_TOKEN,
      app: RECEITANET_APP,
      cpfcnpj: cpfDigits,
      status: 0,
    });

    const overdue = pickBestOverdueBoleto(debitos);

    if (overdue) {
      await safeSend({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers: cwHeaders,
        content: "Encontrei boleto em aberto. Segue para pagamento 👇",
      });

      const boletoMsg = formatBoletoWhatsApp(overdue);
      if (!boletoMsg || boletoMsg.trim().length < 10) {
        console.log("⚠️ formatBoletoWhatsApp retornou vazio/curto. overdue=", overdue);
        await safeSend({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content:
            "Encontrei boleto em aberto, mas tive dificuldade de montar a mensagem automática.\nMe confirme o CPF/CNPJ do titular e eu envio o link/linha digitável já já.",
        });
        return;
      }

      await safeSend({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers: cwHeaders,
        content: boletoMsg,
      });

      await safeSend({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers: cwHeaders,
        content:
          "Após pagar, me envie o comprovante aqui (foto/PDF). Eu verifico se foi o *mês correto* e te aviso o prazo de compensação.",
      });
    } else {
      await safeSend({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers: cwHeaders,
        content: "No momento não aparece boleto vencido no sistema. Se você pagou agora, me envie o comprovante para eu validar. ✅",
      });
    }

    return;
  }

  // fallback do financeiro
  await safeSend({
    baseUrl: CHATWOOT_URL,
    accountId: CHATWOOT_ACCOUNT_ID,
    conversationId,
    headers: cwHeaders,
    content: "Me diga: você precisa de *boleto/2ª via* ou quer *validar um pagamento/comprovante*?",
  });
}

export function startServer() {
  const app = express();
  app.use(express.json({ limit: "15mb" }));

  app.get("/", (_req, res) => res.send("🚀 Bot online"));

  app.post("/chatwoot-webhook", async (req, res) => {
    res.status(200).send("ok");

    try {
      if (!assertEnv()) return;

      // 1) só mensagens incoming
      if (!isIncomingMessage(req.body)) return;

      const conversationId = extractConversationId(req.body);
      if (!conversationId) return;

      // 2) dedupe de evento (webhook duplicado)
      if (shouldIgnoreDuplicateEvent(req.body)) return;

      const customerTextRaw = extractMessageText(req.body);
      const customerText = normalizeText(customerTextRaw);
      const attachments = extractAttachments(req.body);

      const { cwHeaders } = await ensureAuthAndHeaders();

      const conv = await getConversation({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers: cwHeaders,
      });

      const labels = (conv?.labels || []).map((x) => (typeof x === "string" ? x : x?.title)).filter(Boolean);
      const labelSet = new Set(labels);

      const ca = conv?.custom_attributes || {};
      const state = ca.bot_state || "triage";
      const agent = ca.bot_agent || "isa";

      // whatsapp no payload
      const waFromPayload =
        req.body?.sender?.additional_attributes?.whatsapp ||
        req.body?.remetente?.atributos_adicionais?.whatsapp ||
        req.body?.conversation?.meta?.sender?.additional_attributes?.whatsapp ||
        req.body?.conversation?.meta?.remetente?.atributos_adicionais?.whatsapp ||
        req.body?.contact?.phone_number ||
        null;

      const storedWa = ca.whatsapp_phone || "";
      const waNormalized = normalizePhoneBR(waFromPayload || storedWa);

      if (waNormalized && waNormalized !== storedWa) {
        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { whatsapp_phone: waNormalized },
        });
      }

      console.log("🔥 chegando", {
        ID_da_conversa: conversationId,
        texto: customerText || "(vazio)",
        anexos: attachments.length,
        estado: state,
        agente: agent,
        wa: waNormalized || null,
        labels: labels,
      });

      // -----------------------------------------
      // COMANDOS #gpt on / #gpt off
      // -----------------------------------------
      if (isGptCommandOn(customerText)) {
        await addLabels({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          labels: [LABEL_GPT_ON],
        });

        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "triage", bot_agent: "isa", welcome_sent: true, fuga_count: 0 },
        });

        await safeSend({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content: "✅ GPT ativado. Vou te atender por aqui sem precisar do menu.",
        });
        return;
      }

      if (isGptCommandOff(customerText)) {
        // (se você tiver removeLabels, pode tirar a label; aqui só deixa um estado “off”)
        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "triage", bot_agent: "isa", welcome_sent: false, fuga_count: 0 },
        });

        await safeSend({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content: "✅ GPT desativado nesta conversa.",
        });
        return;
      }

      // -----------------------------------------
      // AUTO ATIVADOR (3 fugas do menu)
      // IMPORTANTE: enquanto NÃO tiver gpt_on, o bot NÃO responde (evita 2 atendentes)
      // -----------------------------------------
      if (!labelSet.has(LABEL_GPT_ON)) {
        // Se o usuário está seguindo menu 1/2/3, zera fuga e deixa SMSNET cuidar
        if (isMenuChoice(customerText)) {
          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { fuga_count: 0 },
          });
          return;
        }

        // Se veio anexo, conta como fuga (mas só ativa após limite)
        const prev = Number(ca.fuga_count || 0);
        const next = prev + 1;

        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { fuga_count: next },
        });

        console.log("🟡 fuga do menu:", { conversationId, nextCount: next, limit: FUGA_LIMIT });

        if (next < FUGA_LIMIT) {
          return; // NÃO responde ainda
        }

        // atingiu limite -> ativa GPT
        await addLabels({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          labels: [LABEL_GPT_ON],
        });

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
          attrs: { bot_state: "triage", bot_agent: "isa", welcome_sent: true, fuga_count: 0 },
        });

        await safeSend({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content:
            "✅ Entendi. Vou te atender por aqui sem precisar do menu.\nMe diga: *suporte*, *financeiro* ou *planos*?",
        });

        return;
      }

      // -----------------------------------------
      // DAQUI PRA BAIXO: GPT ON (bot assume)
      // -----------------------------------------

      // 0) Welcome (apenas 1x)
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
          attrs: { bot_state: "triage", bot_agent: "isa", welcome_sent: true, fuga_count: 0 },
        });

        await safeSend({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content:
            "Oi! Eu sou a *Isa*, da i9NET. 😊\nMe diga o que você precisa:\n1) *Sem internet / suporte*\n2) *Financeiro (boleto/2ª via/pagamento)*\n3) *Planos/contratar*\n\n(Se preferir, responda por texto: “sem internet”, “boleto”, “planos”…) ",
        });

        // se a mensagem atual foi vazia e sem anexo, para aqui
        if (!customerText && attachments.length === 0) return;
      }

      // 1) ANEXO (imagem/pdf) -> financeiro/cassia
      if (attachments.length > 0) {
        const att = pickFirstAttachment(attachments);
        const dataUrl = att?.data_url || att?.dataUrl || null;
        const fileType = att?.file_type || att?.tipo_de_arquivo || "unknown";

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

          console.log("📎 anexo", {
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

            await safeSend({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              content:
                "📎 *Recebi seu comprovante.*\n" +
                (analysis?.summaryText || "Consegui ler o comprovante.") +
                "\n\nPara eu conferir no sistema se foi o *mês correto*, me envie o *CPF ou CNPJ do titular* (somente números).",
            });

            return;
          }
        }

        // fallback: não deu pra analisar
        if (!customerText) {
          await safeSend({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "📎 Recebi seu arquivo. Para localizar no sistema, me envie o *CPF ou CNPJ do titular* (somente números).",
          });
          return;
        }
      }

      // se não tem texto nem anexo, ignora
      if (!customerText && attachments.length === 0) return;

      // 2) TRIAGEM (Isa)
      const numericChoice = mapNumericChoice(customerText); // 1/2/3 ou null
      const intent = detectIntent(customerText, numericChoice);

      const currentState = (conv?.custom_attributes?.bot_state || "triage").toString();

      if (currentState === "triage") {
        if (intent === "support") {
          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { bot_agent: "anderson", bot_state: "support_check" },
          });

          await safeSend({
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

          await safeSend({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "Oi! Eu sou a *Cassia*, do financeiro. 💳\nVocê precisa de:\n1) *Boleto/2ª via*\n2) *Informar pagamento / validar comprovante*\n\n(Responda 1/2 ou escreva “boleto” / “paguei”)",
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

          await safeSend({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Perfeito! Me diga seu *bairro* e *cidade* para eu te informar cobertura e planos. 😊",
          });
          return;
        }

        // não entendeu
        await safeSend({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content: "Só para eu te direcionar certinho:\n1) *Sem internet / suporte*\n2) *Financeiro (boleto/pagamento)*\n3) *Planos/contratar*",
        });
        return;
      }

      // 3) SUPORTE (Anderson)
      if (currentState === "support_check") {
        await handleSupportFlow({
          conversationId,
          cwHeaders,
          conv,
          ca: conv?.custom_attributes || {},
          customerText,
          waNormalized,
        });
        return;
      }

      if (currentState === "support_need_cpf") {
        const cpfDigits = onlyDigits(customerText);
        if (!(cpfDigits.length === 11 || cpfDigits.length === 14)) {
          await safeSend({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Opa! Envie *CPF (11)* ou *CNPJ (14)*, somente números.",
          });
          return;
        }

        await safeSend({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content: "Perfeito. Só um instante que vou verificar seu cadastro e possíveis bloqueios. ✅",
        });

        // ✅ AGORA: continua o fluxo imediatamente (não trava)
        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { cpfcnpj: cpfDigits, bot_state: "support_check", bot_agent: "anderson" },
        });

        await handleSupportFlow({
          conversationId,
          cwHeaders,
          conv,
          ca: { ...(conv?.custom_attributes || {}), cpfcnpj: cpfDigits, bot_state: "support_check", bot_agent: "anderson" },
          customerText: cpfDigits,
          waNormalized,
        });
        return;
      }

      // 4) FINANCEIRO (Cassia)
      if (String(currentState).startsWith("finance_")) {
        await handleFinanceFlow({
          conversationId,
          cwHeaders,
          ca: conv?.custom_attributes || {},
          customerText,
        });
        return;
      }

      // 5) fallback (GPT controlado)
      const persona = buildPersonaHeader(agent);
      const reply = await openaiChat({
        apiKey: OPENAI_API_KEY,
        model: OPENAI_MODEL,
        system: persona,
        user: customerText,
        maxTokens: 180,
      });

      await safeSend({
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

// Se você estiver rodando diretamente este arquivo, descomente:
// startServer();
