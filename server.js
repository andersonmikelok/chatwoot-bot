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
  addLabels, // ✅ MERGE seguro
  removeLabel,
  setCustomAttributesMerge,
  buildAuthHeaders,
  downloadAttachmentAsDataUrl,
} from "./lib/chatwoot.js";

import {
  rnFindClient,
  rnListDebitos,
  rnVerificarAcesso,
  pickBestOverdueBoleto,
  rnNotificacaoPagamento,
} from "./lib/receitanet.js";

import { openaiAnalyzeImage, openaiChat } from "./lib/openai.js";

// =====================
// ENV
// =====================
const PORT = process.env.PORT || 10000;

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = String(process.env.CHATWOOT_ACCOUNT_ID || "");
const CW_UID = process.env.CW_UID || "";
const CW_PASSWORD = process.env.CW_PASSWORD || "";

const RECEITANET_BASE_URL = (
  process.env.RECEITANET_BASE_URL || "https://sistema.receitanet.net/api/novo/chatbot"
).replace(/\/+$/, "");
const RECEITANET_TOKEN = process.env.RECEITANET_TOKEN || process.env.RECEITANET_CHATBOT_TOKEN || "";
const RECEITANET_APP = process.env.RECEITANET_APP || "chatbot";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

// Labels
const LABEL_GPT_ON = "gpt_on";
const LABEL_WELCOME_SENT = "gpt_welcome_sent";
const LABEL_GPT_MANUAL = "gpt_manual_on"; // ✅ chave real

// =====================
// Helpers
// =====================
function onlyDigits(s) {
  return (s || "").toString().replace(/\D+/g, "");
}
function normalizeDigits(s) {
  return (s || "").toString().replace(/\D+/g, "");
}
function parseMoneyToNumber(v) {
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  const cleaned = s.replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}
function amountsClose(a, b, tol = 0.05) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tol;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function safeLabelList(conv) {
  return (conv?.labels || []).map((x) => (typeof x === "string" ? x : x?.title)).filter(Boolean);
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
function extractCpfCnpjDigits(text) {
  const d = onlyDigits(text || "");
  if (d.length === 11 || d.length === 14) return d;
  return null;
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
function isBoletoIntent(text) {
  const t = normalizeText(text).toLowerCase();
  return (
    t.includes("boleto") ||
    t.includes("2ª") ||
    t.includes("2a") ||
    t.includes("2 via") ||
    t.includes("segunda via") ||
    t.includes("fatura") ||
    t.includes("mensalidade")
  );
}
function chunkString(str, maxLen = 1200) {
  const s = String(str || "");
  if (!s) return [];
  const parts = [];
  for (let i = 0; i < s.length; i += maxLen) parts.push(s.slice(i, i + maxLen));
  return parts;
}
function isSmsnetSystemMessage(text) {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;

  if (t.includes("digite o número")) return true;
  if (t.includes("por favor digite um número válido")) return true;
  if (t.includes("consultar planos")) return true;
  if (t.includes("já sou cliente")) return true;
  if (t.includes("contatos / endereço")) return true;
  if (t.includes("[1]") || t.includes("[2]") || t.includes("[3]")) return true;
  if (t.startsWith("menu")) return true;

  return false;
}
function receiptMatchesBoleto({ analysis, boleto }) {
  const boletoLine = normalizeDigits(boleto?.barras || "");
  const recLine = normalizeDigits(analysis?.barcode_or_line || "");
  const strong = boletoLine && recLine && boletoLine === recLine;

  const boletoAmount = parseMoneyToNumber(boleto?.valor);
  const paidAmount = parseMoneyToNumber(analysis?.amount);

  const amountOk = amountsClose(paidAmount, boletoAmount, 0.10);
  const hasDate = Boolean(String(analysis?.date || "").trim());
  const medium = amountOk && hasDate;

  return {
    ok: strong || medium,
    level: strong ? "strong" : medium ? "medium" : "none",
    amountOk,
    strong,
    boletoAmount,
    paidAmount,
  };
}

async function resolveCpfCnpjForReceipt({ ca, wa, analysis }) {
  // 1) já salvo na conversa
  const saved = onlyDigits(String(ca?.cpfcnpj || ca?.last_cpfcnpj || ""));
  if (saved.length === 11 || saved.length === 14) return saved;

  // 2) tenta extrair do próprio comprovante (se a IA achou)
  const fromReceipt = onlyDigits(String(analysis?.payer_doc || ""));
  if (fromReceipt.length === 11 || fromReceipt.length === 14) return fromReceipt;

  // 3) tenta localizar no ReceitaNet pelo WhatsApp
  if (wa) {
    try {
      const client = await rnFindClient({
        baseUrl: RECEITANET_BASE_URL,
        token: RECEITANET_TOKEN,
        app: RECEITANET_APP,
        phone: wa,
      });

      if (client?.found) {
        const doc = onlyDigits(String(client?.data?.cpfCnpj || client?.data?.cpfcnpj || ""));
        if (doc.length === 11 || doc.length === 14) return doc;
      }
    } catch {
      // ignora e cai no null
    }
  }

  return null;
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

// =====================
// Chatwoot auth helpers
// =====================
async function cwAuth({ force = false }) {
  const auth = await chatwootSignInIfNeeded({
    baseUrl: CHATWOOT_URL,
    email: CW_UID,
    password: CW_PASSWORD,
    force,
  });
  return buildAuthHeaders({ ...auth, uid: auth.uid || CW_UID });
}

// =====================
// Chatwoot wrappers (retry)
// =====================
async function cwGetConversationRetry({ conversationId, headers, tries = 3 }) {
  let last;
  for (let i = 0; i < tries; i++) {
    const res = await getConversation({ baseUrl: CHATWOOT_URL, accountId: CHATWOOT_ACCOUNT_ID, conversationId, headers });
    last = res;
    if (res.ok) return res;
    if (res.status === 401) {
      const h2 = await cwAuth({ force: true });
      headers = h2;
    }
    await sleep(250 * (i + 1));
  }
  return last;
}
async function cwSendRetry({ conversationId, headers, content, tries = 3 }) {
  let last;
  for (let i = 0; i < tries; i++) {
    const res = await sendMessage({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers,
      content,
    });
    last = res;
    if (res.ok) return res;
    if (res.status === 401) {
      const h2 = await cwAuth({ force: true });
      headers = h2;
    }
    await sleep(250 * (i + 1));
  }
  return last;
}
async function cwAddLabelRetry({ conversationId, headers, label, tries = 3 }) {
  let last;
  for (let i = 0; i < tries; i++) {
    const res = await addLabels({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers,
      labels: [label],
    });
    last = res;
    if (res.ok) return res;
    if (res.status === 401) {
      const h2 = await cwAuth({ force: true });
      headers = h2;
    }
    await sleep(250 * (i + 1));
  }
  return last;
}
async function cwRemoveLabelRetry({ conversationId, headers, label, tries = 3 }) {
  let last;
  for (let i = 0; i < tries; i++) {
    const res = await removeLabel({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers,
      label,
    });
    last = res;
    if (res.ok) return res;
    if (res.status === 401) {
      const h2 = await cwAuth({ force: true });
      headers = h2;
    }
    await sleep(250 * (i + 1));
  }
  return last;
}
async function cwSetAttrsRetry({ conversationId, headers, attrs, tries = 3 }) {
  let last;
  for (let i = 0; i < tries; i++) {
    const res = await setCustomAttributesMerge({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers,
      attrs,
    });
    last = res;
    if (res.ok) return res;
    if (res.status === 401) {
      const h2 = await cwAuth({ force: true });
      headers = h2;
    }
    await sleep(250 * (i + 1));
  }
  return last;
}
async function cwDownloadAttachmentRetry({ headers, dataUrl, tries = 3 }) {
  let last;
  for (let i = 0; i < tries; i++) {
    const res = await downloadAttachmentAsDataUrl({ headers, dataUrl });
    last = res;
    if (res.ok) return res;
    if (res.status === 401) {
      const h2 = await cwAuth({ force: true });
      headers = h2;
    }
    await sleep(250 * (i + 1));
  }
  return last;
}

// =====================
// Message ordering helper
// =====================
async function sendOrdered({ conversationId, headers, content, delayMs = 900 }) {
  const chunks = chunkString(content, 1400);
  for (const [idx, part] of chunks.entries()) {
    await cwSendRetry({ conversationId, headers, content: part });
    if (idx < chunks.length - 1) await sleep(delayMs);
  }
}

// =====================
// Finance helpers
// =====================
async function findClientByDocOrWa({ cpfcnpj, wa }) {
  if (cpfcnpj) {
    const byDoc = await rnFindClient({
      baseUrl: RECEITANET_BASE_URL,
      token: RECEITANET_TOKEN,
      app: RECEITANET_APP,
      cpfcnpj,
    });
    if (byDoc?.found) return byDoc;
  }

  if (wa) {
    const byWa = await rnFindClient({
      baseUrl: RECEITANET_BASE_URL,
      token: RECEITANET_TOKEN,
      app: RECEITANET_APP,
      phone: wa,
    });
    if (byWa?.found) return byWa;
  }

  return { found: false };
}

async function financeSendBoletoByDoc({
  conversationId,
  headers,
  cpfcnpj,
  wa,
  silent = false,
  skipPreface = false,
} = {}) {
  const client = await findClientByDocOrWa({ cpfcnpj, wa });
  if (!client?.found) {
    if (!silent) {
      await sendOrdered({
        conversationId,
        headers,
        content: "Não encontrei seu cadastro com esse CPF/CNPJ. Confere pra mim se está correto (somente números)?",
        delayMs: 1200,
      });
    }
    return { ok: false, reason: "client_not_found" };
  }

  const idCliente = String(client?.data?.idCliente || client?.data?.id || client?.idCliente || "");
  const nome = client?.data?.nome || client?.data?.name || "";

  const debitos = await rnListDebitos({
    baseUrl: RECEITANET_BASE_URL,
    token: RECEITANET_TOKEN,
    app: RECEITANET_APP,
    idCliente,
  });

  const melhor = pickBestOverdueBoleto(debitos?.data || debitos?.debitos || debitos || []);
  if (!melhor) {
    if (!silent) {
      await sendOrdered({
        conversationId,
        headers,
        content: `✅ ${nome ? `*${nome}* — ` : ""}não encontrei boleto em aberto no momento.`,
        delayMs: 1200,
      });
    }
    return { ok: false, reason: "no_open_boleto", idCliente };
  }

  const boleto = {
    vencimento: melhor?.vencimento || melhor?.dataVencimento || melhor?.dtVencimento || "",
    valor: melhor?.valor || melhor?.valorBoleto || melhor?.vlr || "",
    barras: melhor?.linhaDigitavel || melhor?.codigoBarras || melhor?.barras || "",
    pix: melhor?.pixCopiaECola || melhor?.pix || "",
    link: melhor?.link || melhor?.url || "",
  };

  if (!silent) {
    let preface = "";
    if (!skipPreface) {
      preface =
        "Perfeito 😊 Já localizei aqui.\n" +
        "Vou te enviar agora as informações do boleto (código de barras / PIX / link).\n\n";
    }

    const parts = [];
    parts.push(
      `${preface}📄 *Boleto em aberto*\n` +
        `🗓️ *Vencimento:* ${boleto.vencimento}\n` +
        `💰 *Valor:* R$ ${boleto.valor}`
    );

    if (boleto.barras) {
      parts.push(`🏷️ *Código de barras*\n${boleto.barras}`);
    }

    if (boleto.pix) {
      parts.push(`📌 *PIX copia e cola*\n${boleto.pix}`);
    }

    if (boleto.link) {
      parts.push(`🔗 *Link do boleto (copie e cole no navegador):*\n${boleto.link}`);
    }

    parts.push("Pode pagar pela opção que for mais prática pra você 🙂\n⚡ Pagando via *PIX*, a liberação costuma ser *imediata*.");
    parts.push("👉 Se você já realizou o pagamento, pode enviar o comprovante aqui. Vou validar o *mês correto* e agilizar! ✅");

    // enviando em blocos separados (copiar/colar no app do banco)
    for (const msg of parts) {
      await sendOrdered({ conversationId, headers, content: msg, delayMs: 900 });
      await sleep(600);
    }

    const overdueCount = (debitos?.data || debitos?.debitos || debitos || []).filter((x) => {
      const st = normalizeText(String(x?.status || x?.situacao || "")).toLowerCase();
      return st.includes("venc") || st.includes("atras");
    }).length;

    if (overdueCount > 1) {
      await sendOrdered({
        conversationId,
        headers,
        content:
          "⚠️ Identifiquei *mais de 1 boleto vencido*.\n" +
          "Para ver e emitir todos os boletos, acesse o Portal do Assinante:\n" +
          "https://i9net.centralassinante.com.br/",
        delayMs: 1200,
      });
    }
  }

  return { ok: true, idCliente, client, boleto };
}

// =====================
// Express
// =====================
const app = express();
app.use(express.json({ limit: "12mb" }));

app.get("/", (_req, res) => res.status(200).send("ok"));

app.post("/api/v1/whatsapp/webhook/chatwoot", async (req, res) => {
  try {
    if (!assertEnv()) return res.status(500).json({ ok: false, error: "missing_env" });

    // Segurança: ignorar duplicatas
    if (shouldIgnoreDuplicateEvent(req.body)) {
      return res.status(200).json({ ok: true, ignored: "duplicate" });
    }

    const conversationId = extractConversationId(req.body);
    const incoming = isIncomingMessage(req.body);
    const wa = extractWhatsAppFromPayload(req.body);

    if (!conversationId) return res.status(200).json({ ok: true, ignored: "no_conversation_id" });
    if (!incoming) return res.status(200).json({ ok: true, ignored: "not_incoming" });

    let cwHeaders = await cwAuth({ force: false });

    const convRes = await cwGetConversationRetry({ conversationId, headers: cwHeaders });
    if (!convRes.ok) {
      console.log("❌ getConversation falhou", convRes.status, convRes.body);
      return res.status(200).json({ ok: true, ignored: "conv_fetch_failed" });
    }

    const conv = convRes.body;
    const labels = safeLabelList(conv);
    const labelSet = new Set(labels);

    const ca = conv?.custom_attributes || {};
    const state = String(ca?.bot_state || "triage");
    const gptOn = Boolean(ca?.gpt_on || labelSet.has(LABEL_GPT_MANUAL));

    const rawText = extractMessageText(req.body);
    const customerText = normalizeText(rawText || "");
    const lower = customerText.toLowerCase();

    const attachments = extractAttachments(req.body);

    console.log("📩 msg", {
      conversationId,
      wa,
      gptOn,
      state,
      text: customerText?.slice(0, 120),
      anexos: attachments.length,
      labels,
    });

    // Ignora mensagens do sistema SMSNET (menu automático)
    if (isSmsnetSystemMessage(customerText)) {
      return res.status(200).json({ ok: true, ignored: "smsnet_system_message" });
    }

    // ============================
    // COMANDO: #gpt_on
    // ============================
    if (lower === "#gpt_on") {
      console.log("🟢 comando #gpt_on -> ativando GPT");

      await cwAddLabelRetry({ conversationId, headers: cwHeaders, label: LABEL_GPT_MANUAL });
      await cwSetAttrsRetry({
        conversationId,
        headers: cwHeaders,
        attrs: {
          gpt_on: true,
          bot_state: "triage",
          bot_agent: "isa",
          finance_need: null,
        },
      });

      // Welcome
      if (!labelSet.has(LABEL_WELCOME_SENT)) {
        await cwAddLabelRetry({ conversationId, headers: cwHeaders, label: LABEL_WELCOME_SENT });
        await sendOrdered({
          conversationId,
          headers: cwHeaders,
          content:
            "Oi! Eu sou a *Isa*, da i9NET. 😊\nMe diga o que você precisa:\n1) *Sem internet / suporte*\n2) *Financeiro (boleto/2ª via/pagamento)*\n3) *Planos/contratar*\n\n(Se preferir, escreva: “sem internet”, “boleto”, “planos”…)",
          delayMs: 1200,
        });
      }

      return res.status(200).json({ ok: true });
    }

    // ============================
    // COMANDO: #gpt_off
    // ============================
    if (lower === "#gpt_off") {
      console.log("🔴 comando #gpt_off -> desativando GPT");

      await cwRemoveLabelRetry({ conversationId, headers: cwHeaders, label: LABEL_GPT_ON });
      await cwRemoveLabelRetry({ conversationId, headers: cwHeaders, label: LABEL_GPT_MANUAL });

      await cwSetAttrsRetry({
        conversationId,
        headers: cwHeaders,
        attrs: {
          gpt_on: false,
          bot_state: "triage",
          bot_agent: "isa",
          finance_need: null,
          last_cpfcnpj: null,
          last_receipt_json: null,
          last_receipt_ts: null,
        },
      });

      await sendOrdered({
        conversationId,
        headers: cwHeaders,
        content: "✅ Modo teste desativado. Voltando para o atendimento padrão do menu.",
        delayMs: 1200,
      });

      return res.status(200).json({ ok: true });
    }

    // limpeza opcional
    if (labelSet.has(LABEL_GPT_ON) && !labelSet.has(LABEL_GPT_MANUAL)) {
      await cwRemoveLabelRetry({ conversationId, headers: cwHeaders, label: LABEL_GPT_ON });
    }

    // GPT OFF
    if (!gptOn) return res.status(200).json({ ok: true, ignored: "gpt_off" });

    // ============================
    // ANEXO (imagem/pdf)
    // ============================
    if (attachments.length > 0) {
      const att = pickFirstAttachment(attachments);
      const dataUrl = att?.data_url || att?.dataUrl || null;
      const fileType = att?.file_type || att?.tipo_de_arquivo || "unknown";

      // ✅ não força pedir CPF/CNPJ automaticamente; só registra o anexo
      await cwSetAttrsRetry({
        conversationId,
        headers: cwHeaders,
        attrs: {
          bot_agent: "cassia",
          last_attachment_url: dataUrl || "",
          last_attachment_type: fileType,
        },
      });

      if (dataUrl) {
        const dl = await cwDownloadAttachmentRetry({ headers: cwHeaders, dataUrl });

        console.log("📎 anexo baixado", {
          ok: dl.ok,
          status: dl.status,
          bytes: dl.bytes,
          contentType: dl.contentType,
        });

        // Se for imagem pequena, tenta extrair dados do comprovante
        if (dl.ok && dl.bytes <= 4 * 1024 * 1024 && (dl.contentType || "").startsWith("image/")) {
          const analysis = await openaiAnalyzeImage({
            apiKey: OPENAI_API_KEY,
            model: OPENAI_MODEL,
            imageDataUrl: dl.dataUri,
          });

          console.log("🧾 comprovante extraído (parcial)", {
            has: !!analysis,
            amount: analysis?.amount,
            date: analysis?.date,
            hasLine: !!analysis?.barcode_or_line,
          });

          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { last_receipt_json: analysis || null, last_receipt_ts: Date.now() },
          });

          // ✅ tenta reaproveitar CPF/CNPJ já informado OU localizar por WhatsApp
          const cpfcnpjResolved = await resolveCpfCnpjForReceipt({ ca, wa, analysis });

          if (!cpfcnpjResolved) {
            // só pede se realmente não tiver como identificar
            await cwSetAttrsRetry({
              conversationId,
              headers: cwHeaders,
              attrs: { bot_agent: "cassia", bot_state: "finance_wait_doc" },
            });

            await sendOrdered({
              conversationId,
              headers: cwHeaders,
              content:
                "📎 *Recebi seu comprovante.*\n" +
                (analysis?.summaryText || "Consegui ler o comprovante.") +
                "\n\nPara eu conferir se foi o *mês correto* no sistema, me envie o *CPF ou CNPJ do titular* (somente números).",
              delayMs: 1200,
            });

            return res.status(200).json({ ok: true });
          }

          // ✅ já tem doc: salva e confere automaticamente
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { cpfcnpj: cpfcnpjResolved, last_cpfcnpj: cpfcnpjResolved, bot_agent: "cassia" },
          });

          await sendOrdered({
            conversationId,
            headers: cwHeaders,
            content:
              "📎 *Recebi seu comprovante.*\n" +
              (analysis?.summaryText || "Consegui ler o comprovante.") +
              "\n\nVou conferir se foi o *mês correto* no sistema e já te retorno. ✅",
            delayMs: 1200,
          });

          // tenta buscar boleto em aberto do CPF/CNPJ (sem reenviar boleto pro cliente)
          const result = await financeSendBoletoByDoc({
            conversationId,
            headers: cwHeaders,
            cpfcnpj: cpfcnpjResolved,
            wa,
            silent: true,
            skipPreface: true,
          });

          // se achou boleto, compara com o comprovante e orienta
          if (result?.ok && result?.boleto) {
            const match = receiptMatchesBoleto({ analysis, boleto: result.boleto });

            if (match.ok) {
              const idCliente = String(result?.idCliente || "");
              if (idCliente) {
                try {
                  await rnNotificacaoPagamento({
                    baseUrl: RECEITANET_BASE_URL,
                    token: RECEITANET_TOKEN,
                    app: RECEITANET_APP,
                    idCliente,
                    payload: {
                      valor: analysis?.amount || null,
                      data: analysis?.date || null,
                      linha: analysis?.barcode_or_line || null,
                      origem: "whatsapp",
                    },
                  });
                } catch (e) {
                  console.log("⚠️ rnNotificacaoPagamento falhou (ok continuar)", e?.message || e);
                }
              }

              await sendOrdered({
                conversationId,
                headers: cwHeaders,
                content:
                  "✅ *Tudo certo!* O comprovante bate com a fatura em aberto.\n" +
                  "Se a liberação ainda não ocorreu, aguarde alguns minutos (PIX geralmente é imediato).",
                delayMs: 1200,
              });

              // volta para triagem
              await cwSetAttrsRetry({
                conversationId,
                headers: cwHeaders,
                attrs: { bot_state: "triage", bot_agent: "isa" },
              });

              return res.status(200).json({ ok: true });
            }

            await sendOrdered({
              conversationId,
              headers: cwHeaders,
              content:
                "⚠️ Recebi o comprovante, mas não consegui confirmar que ele corresponde ao *boleto em aberto* deste CPF/CNPJ.\n" +
                "Por favor, me envie o *código de barras/linha digitável* do boleto pago ou confirme o *mês/competência* para eu ajustar.",
              delayMs: 1200,
            });

            await cwSetAttrsRetry({
              conversationId,
              headers: cwHeaders,
              attrs: { bot_state: "finance_wait_need", bot_agent: "cassia" },
            });

            return res.status(200).json({ ok: true });
          }

          // não achou boleto — pede só o essencial
          await sendOrdered({
            conversationId,
            headers: cwHeaders,
            content:
              "📎 Recebi seu comprovante e já localizei seu CPF/CNPJ.\n" +
              "Só que não encontrei um boleto em aberto vinculado no momento.\n" +
              "Você pode me dizer *qual mês* você pagou? (ex: janeiro/2026)",
            delayMs: 1200,
          });

          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "finance_wait_need", bot_agent: "cassia" },
          });

          return res.status(200).json({ ok: true });
        }
      }

      // anexo não era imagem (ou não deu pra ler). Pede CPF/CNPJ apenas se ainda não tiver salvo.
      const savedDoc = extractCpfCnpjDigits(ca?.cpfcnpj || ca?.last_cpfcnpj || "");
      if (!savedDoc) {
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_agent: "cassia", bot_state: "finance_wait_doc" },
        });

        await sendOrdered({
          conversationId,
          headers: cwHeaders,
          content: "📎 Recebi seu arquivo. Me envie o *CPF ou CNPJ do titular* (somente números) para eu localizar no sistema.",
          delayMs: 1200,
        });

        return res.status(200).json({ ok: true });
      }

      // já tem doc salvo: segue o fluxo normal sem pedir de novo
    }

    if (!customerText && attachments.length === 0) return res.status(200).json({ ok: true });

    // ============================
    // TRIAGEM
    // ============================
    const numericChoice = mapNumericChoice(customerText);
    const intent = detectIntent(customerText, numericChoice);

    if (state === "triage") {
      if (intent === "support") {
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_agent: "anderson", bot_state: "support_check" },
        });
        await sendOrdered({
          conversationId,
          headers: cwHeaders,
          content: "Certo! Eu sou o *Anderson*, do suporte. 👍\nVocê está *sem internet* agora ou está *lento/instável*?",
          delayMs: 1200,
        });
        return res.status(200).json({ ok: true });
      }

      if (intent === "finance") {
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_agent: "cassia", bot_state: "finance_wait_need" },
        });
        await sendOrdered({
          conversationId,
          headers: cwHeaders,
          content:
            "Certo! Eu sou a *Cássia*, do financeiro. 😊\n" +
            "Me diga o que você precisa:\n" +
            "1) *2ª via do boleto*\n" +
            "2) *Já paguei / enviar comprovante*\n\n" +
            "(Se preferir, escreva: “boleto”, “paguei”, “PIX”…)",
          delayMs: 1200,
        });
        return res.status(200).json({ ok: true });
      }

      if (intent === "sales") {
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_agent: "isa", bot_state: "sales_menu" },
        });
        await sendOrdered({
          conversationId,
          headers: cwHeaders,
          content:
            "Show! 😊\nMe diga seu bairro e o melhor horário pra contato.\n" +
            "Se preferir, posso te passar os planos por aqui também.",
          delayMs: 1200,
        });
        return res.status(200).json({ ok: true });
      }

      // fallback: conversa geral via GPT
    }

    // ============================
    // FINANCE: WAIT NEED
    // ============================
    if (state === "finance_wait_need") {
      const choice = numericChoice || null;
      const t = normalizeText(customerText).toLowerCase();

      if (choice === 1 || isBoletoIntent(t)) {
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "finance_wait_doc", bot_agent: "cassia", finance_need: "boleto" },
        });
        await sendOrdered({
          conversationId,
          headers: cwHeaders,
          content: "Perfeito 🙂 Me envie o *CPF ou CNPJ do titular* (somente números) para eu localizar o boleto.",
          delayMs: 1200,
        });
        return res.status(200).json({ ok: true });
      }

      if (choice === 2 || isPaymentIntent(t)) {
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "finance_wait_doc", bot_agent: "cassia", finance_need: "payment" },
        });
        await sendOrdered({
          conversationId,
          headers: cwHeaders,
          content:
            "Beleza ✅\n" +
            "Me envie o *comprovante* aqui (foto/print) ou o *CPF/CNPJ do titular* pra eu conferir no sistema.",
          delayMs: 1200,
        });
        return res.status(200).json({ ok: true });
      }

      // fallback GPT
    }

    // ============================
    // FINANCE: WAIT DOC
    // ============================
    if (state === "finance_wait_doc") {
      const doc = extractCpfCnpjDigits(customerText);
      if (doc) {
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { cpfcnpj: doc, last_cpfcnpj: doc, bot_agent: "cassia" },
        });

        const need = String(ca?.finance_need || "");
        if (need === "boleto") {
          await financeSendBoletoByDoc({ conversationId, headers: cwHeaders, cpfcnpj: doc, wa });
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "triage", bot_agent: "isa", finance_need: null },
          });
          return res.status(200).json({ ok: true });
        }

        // se caiu aqui, trata como busca padrão de boleto
        await financeSendBoletoByDoc({ conversationId, headers: cwHeaders, cpfcnpj: doc, wa });
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "triage", bot_agent: "isa", finance_need: null },
        });
        return res.status(200).json({ ok: true });
      }

      // fallback
    }

    // ============================
    // SUPORTE: SUPPORT CHECK
    // ============================
    if (state === "support_check") {
      const t = normalizeText(customerText).toLowerCase();

      if (t.includes("sem") && t.includes("internet")) {
        await sendOrdered({
          conversationId,
          headers: cwHeaders,
          content:
            "Entendi. Vamos por etapas:\n" +
            "1) A luz *PON* está *acesa* ou *piscando*?\n" +
            "2) A luz *LOS* está acesa?\n" +
            "Me diga como está que eu te ajudo. ✅",
          delayMs: 1200,
        });
        return res.status(200).json({ ok: true });
      }

      if (t.includes("lento") || t.includes("inst") || t.includes("queda")) {
        await sendOrdered({
          conversationId,
          headers: cwHeaders,
          content:
            "Certo! Para eu verificar:\n" +
            "1) Está lento no *Wi-Fi* ou também no *cabo*?\n" +
            "2) Qual o plano contratado?\n" +
            "Se puder, me diga o modelo do roteador/ONT também. ✅",
          delayMs: 1200,
        });
        return res.status(200).json({ ok: true });
      }
      // fallback
    }

    // ============================
    // Fallback GPT (conversa geral)
    // ============================
    const persona = buildPersonaHeader({ agent: ca?.bot_agent || "isa" });

    const gpt = await openaiChat({
      apiKey: OPENAI_API_KEY,
      model: OPENAI_MODEL,
      system: persona,
      user: customerText,
    });

    if (gpt?.ok && gpt?.text) {
      await sendOrdered({
        conversationId,
        headers: cwHeaders,
        content: gpt.text,
        delayMs: 1200,
      });
    } else {
      console.log("⚠️ openaiChat falhou", gpt?.status, gpt?.body || gpt);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.log("❌ webhook crash", e?.message || e);
    return res.status(200).json({ ok: true, error: "crash" });
  }
});

export function startServer() {
  app.listen(PORT, () => console.log(`🚀 server on :${PORT}`));
  return app;
}

// Se você rodar "node server.js" direto, ele inicia sozinho.
// Mas quando importar (ex: index.js), só inicia via startServer().
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) startServer();

