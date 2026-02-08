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

const LABEL_GPT_ON = "gpt_on";
const LABEL_WELCOME_SENT = "gpt_welcome_sent";

const RN_TIMEOUT_MS = Number(process.env.RN_TIMEOUT_MS || 12000);

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

function withTimeout(promise, ms, label = "timeout") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: ${ms}ms`)), ms)),
  ]);
}

// 🔧 Fallback: monta mensagem de boleto mesmo se formatBoletoWhatsApp falhar
function buildBoletoFallback(overdue) {
  if (!overdue || typeof overdue !== "object") return "";

  const get = (...keys) => {
    for (const k of keys) {
      if (overdue?.[k]) return String(overdue[k]);
    }
    return "";
  };

  const venc = get("vencimento", "data_vencimento", "dtVencimento", "due_date");
  const valor = get("valor", "valor_boleto", "vlr", "amount");
  const linha = get("linha_digitavel", "linhaDigitavel", "codigo_barras", "codigoDeBarras", "barcode");
  const pixCopiaCola = get("pix_copia_cola", "pixCopiaCola", "pix", "pix_copiaecola");
  const qr = get("qr_code", "qrcode", "qrCode", "pix_qr_code");
  const urlPdf = get("url_pdf", "pdf", "link_pdf", "boleto_pdf", "urlBoleto", "url_boleto", "link");

  let msg = "💳 *Boleto para pagamento*\n";
  if (valor) msg += `• Valor: *${valor}*\n`;
  if (venc) msg += `• Vencimento: *${venc}*\n`;

  if (linha) msg += `\n*Código de barras / linha digitável:*\n${linha}\n`;
  if (pixCopiaCola) msg += `\n*PIX (copia e cola):*\n${pixCopiaCola}\n`;
  if (qr) msg += `\n*QR Code (texto/URL):*\n${qr}\n`;
  if (urlPdf) msg += `\n📄 *PDF/Link do boleto:* ${urlPdf}\n`;

  // se não tiver nada útil, retorna vazio pra acionar mensagem de erro
  const useful = [valor, venc, linha, pixCopiaCola, qr, urlPdf].some((x) => String(x || "").trim().length > 0);
  return useful ? msg.trim() : "";
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

      if (shouldIgnoreDuplicateEvent(req.body)) return;

      const customerTextRaw = extractMessageText(req.body);
      const customerText = normalizeText(customerTextRaw);
      const attachments = extractAttachments(req.body);

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
      const agent = ca.bot_agent || "isa";
      const storedCpf = ca.cpfcnpj || "";
      const storedWa = ca.whatsapp_phone || "";

      const waFromPayload =
        req.body?.sender?.additional_attributes?.whatsapp ||
        req.body?.remetente?.atributos_adicionais?.whatsapp ||
        req.body?.conversation?.meta?.sender?.additional_attributes?.whatsapp ||
        req.body?.conversation?.meta?.remetente?.atributos_adicionais?.whatsapp ||
        req.body?.contact?.phone_number ||
        null;

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
        "ID da conversa": conversationId,
        texto: customerText || "(vazio)",
        anexos: attachments.length,
        estado: state,
        agente: agent,
        wa: waNormalized || null,
      });

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

        if (dataUrl) {
          const dl = await downloadAttachmentAsDataUrl({ baseUrl: CHATWOOT_URL, headers: cwHeaders, dataUrl });

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
                "\n\nPara eu conferir se está tudo certo no sistema, me envie o *CPF ou CNPJ do titular* (somente números).",
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
            content:
              "📎 Recebi seu arquivo. Para eu localizar no sistema, me envie o *CPF ou CNPJ do titular* (somente números).",
          });
          return;
        }
      }

      if (!customerText && attachments.length === 0) return;

      // -----------------------------
      // TRIAGEM
      // -----------------------------
      const numericChoice = mapNumericChoice(customerText);
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
      // FINANCEIRO (Cassia)
      // -----------------------------
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
          attrs: { cpfcnpj: cpfDigits, bot_state: "finance_handle", bot_agent: "cassia" },
        });

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content: "Beleza. Vou consultar o sistema e já te retorno. ✅",
        });

        const debitos = await withTimeout(
          rnListDebitos({
            baseUrl: RECEITANET_BASE_URL,
            token: RECEITANET_TOKEN,
            app: RECEITANET_APP,
            cpfcnpj: cpfDigits,
            status: 0,
          }),
          RN_TIMEOUT_MS,
          "ReceitaNet rnListDebitos(finance)"
        );

        const overdue = pickBestOverdueBoleto(debitos);

        if (overdue) {
          console.log("🧾 overdue keys:", Object.keys(overdue || {}));

          await sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers: cwHeaders,
            content: "Encontrei boleto em aberto. Segue para pagamento 👇",
          });

          let boletoMsg = "";
          try {
            boletoMsg = String(formatBoletoWhatsApp(overdue) || "");
          } catch (e) {
            boletoMsg = "";
          }

          console.log("🧾 boletoMsg length:", boletoMsg.trim().length);

          if (!boletoMsg || boletoMsg.trim().length < 20) {
            const fallback = buildBoletoFallback(overdue);
            console.log("🧾 fallback length:", fallback.trim().length);
            boletoMsg = fallback;
          }

          if (boletoMsg && boletoMsg.trim().length >= 20) {
            // manda o boleto em texto (pix/linha/link)
            await sendMessage({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              content: boletoMsg,
            });
          } else {
            // se mesmo assim não conseguiu, avisa e pede um dado extra
            await sendMessage({
              baseUrl: CHATWOOT_URL,
              accountId: CHATWOOT_ACCOUNT_ID,
              conversationId,
              headers: cwHeaders,
              content:
                "Achei um boleto em aberto, mas não consegui gerar os dados completos agora. 😕\nMe confirme por favor o *nome do titular* ou o *telefone do cadastro* para eu localizar e te enviar certinho.",
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

          return;
        }

        await sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers: cwHeaders,
          content: "No momento não aparece boleto vencido no sistema. Se você pagou agora, me envie o comprovante para eu validar. ✅",
        });

        return;
      }

      // -----------------------------
      // fallback (GPT controlado)
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
