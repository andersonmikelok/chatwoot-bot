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
 * RECEITANET_TOKEN=SEU_TOKEN_AQUI
 * RECEITANET_APP=chatbot
 */

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

const LABEL_GPT_ON = "gpt_on";
const LABEL_WELCOME_SENT = "gpt_welcome_sent";

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

export function startServer() {
  const app = express();
  app.use(express.json({ limit: "15mb" }));

  app.get("/", (_req, res) => res.send("🚀 Bot online"));

  app.post("/chatwoot-webhook", async (req, res) => {
    res.status(200).send("ok");

    try {
      if (!assertEnv()) return;

      if (!isIncomingMessage(req.body)) return;

      const conversationId = extractConversationId(req.body);
      if (!conversationId) return;

      // evita responder duas vezes ao mesmo evento (webhook duplicado)
      if (shouldIgnoreDuplicateEvent(req.body)) return;

      const customerTextRaw = extractMessageText(req.body);
      const customerText = normalizeText(customerTextRaw);
      const attachments = extractAttachments(req.body);

      // garante login chatwoot + headers válidos
      const auth = await chatwootSignInIfNeeded({ baseUrl: CHATWOOT_URL, email: CW_UID, password: CW_PASSWORD });
      const cwHeaders = buildAuthHeaders({ ...auth, uid: auth.uid || CW_UID });

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
      const agent = ca.bot_agent || "isa"; // isa | cassia | anderson
      const storedCpf = ca.cpfcnpj || "";
      const storedWa = ca.whatsapp_phone || "";

      // pega whatsapp do payload e normaliza
      const waFromPayload =
        req.body?.sender?.additional_attributes?.whatsapp ||
        req.body?.remetente?.atributos_adicionais?.whatsapp ||
        req.body?.conversation?.meta?.sender?.additional_attributes?.whatsapp ||
        req.body?.conversation?.meta?.remetente?.atributos_adicionais?.whatsapp ||
        req.body?.contact?.phone_number ||
        null;

      const waNormalized = normalizePhoneBR(waFromPayload || storedWa);

      // salva whatsapp na conversa
      if (waNormalized && waNormalized !== storedWa) {
        await setCustomAttributesMerge({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          attrs: { whatsapp_phone: waNormalized },
        });
      }

      console.log("🔥 incoming", {
        conversationId,
        text: customerText || "(vazio)",
        anexos: attachments.length,
        state,
        agent,
        wa: waNormalized || null,
      });

      // -----------------------------
      // ATIVA IA (se ainda não estiver)
      // -----------------------------
      if (!labelSet.has(LABEL_GPT_ON)) {
        await addLabels({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          labels: [LABEL_GPT_ON],
        });
      }

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
            "Oi! Eu sou a *Isa*, da i9NET. 😊\nMe diga o que você precisa:\n1) *Sem internet / suporte*\n2) *Financeiro (boleto/2ª via/pagamento)*\n3) *Planos/contratar*\n\n(Se preferir, responda com palavras: “sem internet”, “boleto”, “planos”…)",
        });

        // se a mensagem atual for só "Oi", não precisa processar mais
        if (!customerText && attachments.length === 0) return;
      }

      // -----------------------------
      // ANEXO (imagem/pdf)
      // -----------------------------
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

        // Baixar e analisar (se for imagem)
        if (dataUrl) {
          const dl = await downloadAttachmentAsDataUrl({ baseUrl: CHATWOOT_URL, headers: cwHeaders, dataUrl });

          if (dl.ok && dl.bytes <= 4 * 1024 * 1024 && (dl.contentType || "").startsWith("image/")) {
            const analysis = await openaiAnalyzeImage({
              apiKey: OPENAI_API_KEY,
              model: OPENAI_MODEL,
              imageDataUrl: dl.dataUri,
            });

            // guarda última extração para não repetir
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
                "\n\nPara eu conferir se está tudo certo no sistema, me envie o *CPF ou CNPJ do titular* (somente números).",
            });

            return;
          }
        }

        // fallback: se não deu pra analisar
        if (!customerText) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "📎 Recebi seu arquivo. Para eu localizar no sistema, me envie o *CPF ou CNPJ do titular* (somente números).",
          });
          return;
        }
      }

      // se não tem nada, ignora
      if (!customerText && attachments.length === 0) return;

      // -----------------------------
      // TRIAGEM: aceita 1/2/3 ou texto
      // -----------------------------
      const numericChoice = mapNumericChoice(customerText); // 1/2/3 ou null
      const intent = detectIntent(customerText, numericChoice);

      // se está em triage e usuário escolheu
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
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Perfeito! Me diga seu *bairro* e *cidade* para eu te informar cobertura e planos. 😊",
          });
          return;
        }

        // se não entendeu, repete triagem
        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content:
            "Só para eu te direcionar certinho:\n1) *Sem internet / suporte*\n2) *Financeiro (boleto/pagamento)*\n3) *Planos/contratar*",
        });
        return;
      }

      // -----------------------------
      // SUPORTE (Anderson)
      // -----------------------------
      if (state === "support_check") {
        // tenta achar cliente por whatsapp
        let client = null;

        if (waNormalized) {
          client = await rnFindClient({
            baseUrl: RECEITANET_BASE_URL,
            token: RECEITANET_TOKEN,
            app: RECEITANET_APP,
            phone: waNormalized,
          });
        }

        // se usuário mandou CPF/CNPJ nessa mensagem, usa
        const cpfDigits = onlyDigits(customerText);
        const looksCpf = cpfDigits.length === 11 || cpfDigits.length === 14;
        if (!client && looksCpf) {
          client = await rnFindClient({
            baseUrl: RECEITANET_BASE_URL,
            token: RECEITANET_TOKEN,
            app: RECEITANET_APP,
            cpfcnpj: cpfDigits,
          });

          await setCustomAttributesMerge({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            attrs: { cpfcnpj: cpfDigits },
          });
        }

        // se ainda não achou, pede CPF/CNPJ
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
              "Não consegui localizar seu cadastro pelo WhatsApp.\nMe envie o *CPF ou CNPJ do titular* (somente números) para eu verificar seu acesso e possíveis bloqueios.",
          });
          return;
        }

        // achou cliente -> verifica débitos/boletos
        const cpf = client.data?.cpfCnpj || client.data?.cpfcnpj || storedCpf || "";
        const cpfUse = onlyDigits(String(cpf || ""));

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
            attrs: { bot_agent: "cassia", bot_state: "finance_wait_need" },
          });

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "Encontrei *bloqueio por inadimplência* (boleto em aberto). Vou te enviar agora para regularizar. 👇",
          });

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: formatBoletoWhatsApp(overdue),
          });

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content:
              "Assim que pagar, me envie o *comprovante* aqui (foto/PDF). Eu confiro se foi o mês correto e te explico o prazo de compensação.",
          });

          return;
        }

        // sem boleto vencido -> ação técnica
        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content:
            "No sistema não aparece boleto vencido/bloqueio agora.\nVamos fazer um teste rápido:\n1) Desligue ONU/roteador por *2 minutos*\n2) Ligue novamente\n3) Aguarde *2 minutos*\n\nDepois me diga: voltou?",
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

        // reentra no check automaticamente com a mesma msg
        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content: "Perfeito. Só um instante que vou verificar seu cadastro e possíveis bloqueios. ✅",
        });
        return;
      }

      // -----------------------------
      // FINANCEIRO (Cassia)
      // -----------------------------
      if (state === "finance_wait_need") {
        // aceita 1/2 ou texto
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
            content: "Me diga: você quer *1) boleto/2ª via* ou *2) validar pagamento/comprovante*?",
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
        if (!(cpfDigits.length === 11 || cpfDigits.length === 14)) {
          await sendMessage({
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
          attrs: { cpfcnpj: cpfDigits, bot_state: "finance_handle" },
        });

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content: "Beleza. Vou consultar o sistema e já te retorno. ✅",
        });

        // busca débitos
        const debitos = await rnListDebitos({
          baseUrl: RECEITANET_BASE_URL,
          token: RECEITANET_TOKEN,
          app: RECEITANET_APP,
          cpfcnpj: cpfDigits,
          status: 0,
        });

        const overdue = pickBestOverdueBoleto(debitos);

        if (overdue) {
          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Encontrei boleto em aberto. Segue para pagamento 👇",
          });

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: formatBoletoWhatsApp(overdue),
          });

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

      // -----------------------------
      // fallback (GPT bem controlado)
      // -----------------------------
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
