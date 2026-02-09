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
function onlyDigits(s) {
  return (s || "").toString().replace(/\D+/g, "");
}

function is401(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("(401)") || msg.includes(" 401 ") || msg.includes("failed (401)") || msg.includes("status\":401");
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

function isBoletoIntent(text) {
  const t = normalizeText(text).toLowerCase();
  return t.includes("boleto") || t.includes("2ª") || t.includes("2a") || t.includes("fatura") || t.includes("segunda via");
}

function formatMoneyBR(v) {
  // aceita number ou string numérica
  if (typeof v === "number") return v.toFixed(2).replace(".", ",");
  const n = Number(String(v || "").replace(",", "."));
  if (Number.isFinite(n)) return n.toFixed(2).replace(".", ",");
  return "";
}

function chunkString(str, maxLen = 1200) {
  const s = String(str || "");
  if (!s) return [];
  const parts = [];
  for (let i = 0; i < s.length; i += maxLen) parts.push(s.slice(i, i + maxLen));
  return parts;
}

// =====================
// Chatwoot Retry Wrappers (401)
// =====================
async function cwAuth({ force = false }) {
  const auth = await chatwootSignInIfNeeded({
    baseUrl: CHATWOOT_URL,
    email: CW_UID,
    password: CW_PASSWORD,
    force,
  });
  const headers = buildAuthHeaders({ ...auth, uid: auth.uid || CW_UID });
  return headers;
}

async function cwGetConversationRetry({ conversationId, headers }) {
  try {
    return await getConversation({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers,
    });
  } catch (e) {
    if (!is401(e)) throw e;
    console.warn("🔁 401 no getConversation -> renovando token e retry");
    const h2 = await cwAuth({ force: true });
    return await getConversation({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: h2,
    });
  }
}

async function cwSendMessageRetry({ conversationId, headers, content }) {
  try {
    return await sendMessage({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers,
      content,
    });
  } catch (e) {
    if (!is401(e)) throw e;
    console.warn("🔁 401 no sendMessage -> renovando token e retry");
    const h2 = await cwAuth({ force: true });
    return await sendMessage({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: h2,
      content,
    });
  }
}

async function cwSetAttrsRetry({ conversationId, headers, attrs }) {
  try {
    return await setCustomAttributesMerge({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers,
      attrs,
    });
  } catch (e) {
    if (!is401(e)) throw e;
    console.warn("🔁 401 no setCustomAttributes -> renovando token e retry");
    const h2 = await cwAuth({ force: true });
    return await setCustomAttributesMerge({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: h2,
      attrs,
    });
  }
}

async function cwAddLabelsRetry({ conversationId, headers, currentLabels, labelsToAdd }) {
  try {
    return await addLabelsMerged({
      currentLabels,
      labelsToAdd,
      cw: { baseUrl: CHATWOOT_URL, accountId: CHATWOOT_ACCOUNT_ID, conversationId, headers },
    });
  } catch (e) {
    if (!is401(e)) throw e;
    console.warn("🔁 401 no addLabels -> renovando token e retry");
    const h2 = await cwAuth({ force: true });
    return await addLabelsMerged({
      currentLabels,
      labelsToAdd,
      cw: { baseUrl: CHATWOOT_URL, accountId: CHATWOOT_ACCOUNT_ID, conversationId, headers: h2 },
    });
  }
}

async function cwDownloadAttachmentRetry({ headers, dataUrl }) {
  try {
    return await downloadAttachmentAsDataUrl({ baseUrl: CHATWOOT_URL, headers, dataUrl });
  } catch (e) {
    if (!is401(e)) throw e;
    console.warn("🔁 401 no downloadAttachment -> renovando token e retry");
    const h2 = await cwAuth({ force: true });
    return await downloadAttachmentAsDataUrl({ baseUrl: CHATWOOT_URL, headers: h2, dataUrl });
  }
}

// =====================
// ReceitaNet helpers
// =====================
async function financeSendBoletoPieces({ conversationId, headers, boleto }) {
  const venc = boleto?.vencimento || "";
  const valor = formatMoneyBR(boleto?.valor);
  const link = boleto?.link || "";
  const pix = boleto?.qrcode_pix || "";
  const barras = boleto?.barras || "";

  // log “seguro” (sem vazar pix completo)
  console.log("🧾 [FIN] boleto fields", {
    vencimento: venc || "",
    valor_raw_type: typeof boleto?.valor,
    valor_fmt: valor || "",
    link_len: String(link).length,
    pix_len: String(pix).length,
    barras_len: String(barras).length,
  });

  // 1) cabeçalho (curto)
  const headerLines = ["📄 *Boleto em aberto*"];
  if (venc) headerLines.push(`🗓️ *Vencimento:* ${venc}`);
  if (valor) headerLines.push(`💰 *Valor:* R$ ${valor}`);
  await cwSendMessageRetry({
    conversationId,
    headers,
    content: headerLines.join("\n"),
  });

  // 2) link (curto)
  if (link) {
    await cwSendMessageRetry({
      conversationId,
      headers,
      content: `🔗 *Link do boleto:*\n${link}`,
    });
  }

  // 3) pix copia/cola (pode ser enorme -> quebrar)
  if (pix) {
    const parts = chunkString(pix, 1200);
    if (parts.length === 1) {
      await cwSendMessageRetry({
        conversationId,
        headers,
        content: `📌 *PIX copia e cola:*\n${parts[0]}`,
      });
    } else {
      for (let i = 0; i < parts.length; i++) {
        await cwSendMessageRetry({
          conversationId,
          headers,
          content: `📌 *PIX copia e cola* (parte ${i + 1}/${parts.length}):\n${parts[i]}`,
        });
      }
    }
  }

  // 4) barras (curto)
  if (barras) {
    await cwSendMessageRetry({
      conversationId,
      headers,
      content: `🏷️ *Código de barras:*\n${barras}`,
    });
  }

  // se não veio nada útil (debug)
  if (!link && !pix && !barras) {
    await cwSendMessageRetry({
      conversationId,
      headers,
      content:
        "Encontrei um débito em aberto, mas o sistema não retornou link/PIX/código de barras.\n" +
        "Me confirme se você quer que eu gere uma 2ª via por outro meio, por favor.",
    });
  }
}

async function financeSendBoletoByDoc({ conversationId, headers, cpfcnpj, wa }) {
  const waNorm = normalizePhoneBR(wa || "");
  console.log("🧾 [FIN] buscando cliente ReceitaNet", { cpfcnpj, wa: waNorm || null });

  const client = await rnFindClient({
    baseUrl: RECEITANET_BASE_URL,
    token: RECEITANET_TOKEN,
    app: RECEITANET_APP,
    cpfcnpj,
    phone: waNorm || "",
  });

  console.log("🧾 [FIN] rnFindClient retorno", {
    found: client?.found,
    status: client?.status,
    hasData: Boolean(client?.data),
  });

  if (!client.found) {
    await cwSendMessageRetry({
      conversationId,
      headers,
      content:
        "Não consegui localizar esse CPF/CNPJ no sistema.\n" +
        "Me envie o *CPF ou CNPJ do titular do contrato* (somente números), por favor.",
    });
    await cwSetAttrsRetry({
      conversationId,
      headers,
      attrs: { bot_state: "finance_wait_doc", bot_agent: "cassia", last_cpfcnpj: "" },
    });
    return { ok: false, reason: "not_found" };
  }

  const debitos = await rnListDebitos({
    baseUrl: RECEITANET_BASE_URL,
    token: RECEITANET_TOKEN,
    app: RECEITANET_APP,
    cpfcnpj,
    status: 0,
  });

  console.log("🧾 [FIN] rnListDebitos qtd", { qtd: Array.isArray(debitos) ? debitos.length : -1 });

  if (!Array.isArray(debitos) || debitos.length === 0) {
    await cwSendMessageRetry({
      conversationId,
      headers,
      content:
        "✅ Encontrei seu cadastro, mas *não consta boleto em aberto* no momento.\n" +
        "Se você já pagou, pode me enviar o *comprovante* aqui que eu confirmo.",
    });
    await cwSetAttrsRetry({
      conversationId,
      headers,
      attrs: { bot_state: "finance_wait_need", bot_agent: "cassia", last_cpfcnpj: cpfcnpj },
    });
    return { ok: true, sent: "none_open" };
  }

  // DEBUG opcional: estrutura do primeiro débito (sem dados sensíveis)
  const d0 = debitos[0] || {};
  console.log("🧾 [FIN] debito[0] keys", {
    keys: Object.keys(d0 || {}),
    has_boletos: Boolean(d0?.boletos),
    boletos_keys: d0?.boletos ? Object.keys(d0.boletos) : [],
  });

  const boleto = pickBestOverdueBoleto(debitos);
  console.log("🧾 [FIN] pickBestOverdueBoleto", { has: Boolean(boleto), venc: boleto?.vencimento || "" });

  if (!boleto) {
    await cwSendMessageRetry({
      conversationId,
      headers,
      content:
        "Encontrei débitos, mas não consegui montar o boleto automaticamente.\n" +
        "Me confirme: você quer *2ª via do boleto* ou *validar um pagamento*?",
    });
    await cwSetAttrsRetry({
      conversationId,
      headers,
      attrs: { bot_state: "finance_wait_need", bot_agent: "cassia", last_cpfcnpj: cpfcnpj },
    });
    return { ok: false, reason: "no_boleto_obj" };
  }

  await cwSendMessageRetry({
    conversationId,
    headers,
    content:
      "Perfeito. Já localizei o seu boleto. ✅\n" +
      "Vou te enviar agora as informações (link / PIX / código de barras).",
  });

  // ✅ aqui é a correção principal (envio em partes, sem “textão”)
  await financeSendBoletoPieces({ conversationId, headers, boleto });

  await cwSetAttrsRetry({
    conversationId,
    headers,
    attrs: { bot_state: "finance_wait_need", bot_agent: "cassia", last_cpfcnpj: cpfcnpj },
  });

  return { ok: true, sent: "boleto" };
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

      let cwHeaders = await cwAuth({ force: false });
      let conv = await cwGetConversationRetry({ conversationId, headers: cwHeaders });

      const labels = safeLabelList(conv);
      const labelSet = new Set(labels);

      const ca = conv?.custom_attributes || {};
      const state = ca.bot_state || "triage";
      const agent = ca.bot_agent || "isa";

      const waPayload = extractWhatsAppFromPayload(req.body) || normalizePhoneBR(ca.whatsapp_phone || "");
      const wa = normalizePhoneBR(waPayload || "");
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

      if (wa && wa !== normalizePhoneBR(ca.whatsapp_phone || "")) {
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { whatsapp_phone: wa },
        });
      }

      // GPT OFF: só contador
      if (!gptOn) {
        if (isSmsnetMenuAnswer(customerText)) {
          if (menuIgnoreCount !== 0) {
            await cwSetAttrsRetry({
              conversationId,
              headers: cwHeaders,
              attrs: { menu_ignore_count: 0 },
            });
          }
          return;
        }

        if (isMenuEscape(customerText)) {
          const nextCount = menuIgnoreCount + 1;

          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { menu_ignore_count: nextCount },
          });

          if (nextCount < AUTO_GPT_THRESHOLD) return;

          await cwAddLabelsRetry({
            conversationId,
            headers: cwHeaders,
            currentLabels: labels,
            labelsToAdd: [LABEL_GPT_ON],
          });

          await cwSetAttrsRetry({
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

          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "✅ Entendi. Vou te atender por aqui e agilizar pra você 😊",
          });

          return;
        }

        return;
      }

      // GPT ON: ignora "Menu"
      if (normalizeText(customerText).toLowerCase() === "menu" && attachments.length === 0) return;

      // CPF/CNPJ em qualquer state finance/triage -> tenta automático
      const cpfcnpjInText = extractCpfCnpjDigits(customerText);
      if (cpfcnpjInText && (state === "triage" || String(state || "").startsWith("finance"))) {
        console.log("🧾 CPF/CNPJ detectado -> financeiro automático", {
          conversationId,
          cpfcnpj: cpfcnpjInText,
          state,
        });

        if (!labelSet.has(LABEL_WELCOME_SENT) && !ca.welcome_sent) {
          await cwAddLabelsRetry({
            conversationId,
            headers: cwHeaders,
            currentLabels: labels,
            labelsToAdd: [LABEL_GPT_ON, LABEL_WELCOME_SENT],
          });
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { welcome_sent: true, gpt_on: true },
          });
        }

        await financeSendBoletoByDoc({
          conversationId,
          headers: cwHeaders,
          cpfcnpj: cpfcnpjInText,
          wa,
        });
        return;
      }

      // Welcome (sem numeração)
      if (!labelSet.has(LABEL_WELCOME_SENT) && !ca.welcome_sent) {
        await cwAddLabelsRetry({
          conversationId,
          headers: cwHeaders,
          currentLabels: labels,
          labelsToAdd: [LABEL_GPT_ON, LABEL_WELCOME_SENT],
        });

        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { gpt_on: true, bot_state: "triage", bot_agent: "isa", welcome_sent: true },
        });

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content:
            "Oi! Eu sou a *Isa* da i9NET 😊\n" +
            "Como posso ajudar?\n" +
            "• *Suporte* (sem internet / lento)\n" +
            "• *Financeiro* (boleto / pagamento)\n" +
            "• *Planos* (contratar / valores)\n\n" +
            "Responda com uma dessas opções acima.",
        });

        if (!customerText && attachments.length === 0) return;
      }

      // anexos -> leitura comprovante
      if (attachments.length > 0) {
        const att = pickFirstAttachment(attachments);
        const dataUrl = att?.data_url || att?.dataUrl || null;
        const fileType = att?.file_type || att?.tipo_de_arquivo || "unknown";

        await cwSetAttrsRetry({
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
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "📎 Recebi seu arquivo. Me envie o *CPF ou CNPJ do titular* (somente números) para eu validar.",
          });
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "finance_receipt_wait_doc" },
          });
          return;
        }

        const dl = await cwDownloadAttachmentRetry({ headers: cwHeaders, dataUrl });

        if (dl.ok && dl.bytes <= 4 * 1024 * 1024 && (dl.contentType || "").startsWith("image/")) {
          const analysis = await openaiAnalyzeImage({
            apiKey: OPENAI_API_KEY,
            model: OPENAI_MODEL,
            imageDataUrl: dl.dataUri,
          });

          await cwSetAttrsRetry({
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

          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content:
              "📎 *Recebi seu comprovante.*\n" +
              (analysis?.summaryText || "Consegui ler o comprovante.") +
              "\n\nVou validar no sistema agora. ✅",
          });

          if (!docFromReceipt) {
            await cwSendMessageRetry({
              conversationId,
              headers: cwHeaders,
              content: "Para eu confirmar o pagamento, me envie o *CPF ou CNPJ do titular* (somente números).",
            });
            await cwSetAttrsRetry({
              conversationId,
              headers: cwHeaders,
              attrs: { bot_state: "finance_receipt_wait_doc" },
            });
            return;
          }

          await financeSendBoletoByDoc({
            conversationId,
            headers: cwHeaders,
            cpfcnpj: docFromReceipt,
            wa,
          });
          return;
        }

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content: "📎 Recebi seu arquivo. Me envie o *CPF ou CNPJ do titular* (somente números) para eu validar.",
        });
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "finance_receipt_wait_doc" },
        });
        return;
      }

      // finance esperando CPF/CNPJ
      if (state === "finance_receipt_wait_doc" || state === "finance_wait_doc") {
        const doc = extractCpfCnpjDigits(customerText);
        if (!doc) {
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "Me envie o *CPF ou CNPJ* (somente números), por favor.",
          });
          return;
        }
        await financeSendBoletoByDoc({ conversationId, headers: cwHeaders, cpfcnpj: doc, wa });
        return;
      }

      // suporte (mantido)
      if (state === "support_reboot") {
        if (looksLikeYes(customerText)) {
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "Perfeito! ✅ Internet normalizada. Posso ajudar em mais alguma coisa?",
          });
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "triage", bot_agent: "isa" },
          });
          return;
        }

        if (looksLikeNo(customerText)) {
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content:
              "Entendi. Vou encaminhar para o time técnico verificar a conexão. 👍\n" +
              "Se puder, me diga se alguma luz da ONU/roteador está *vermelha* ou *piscando* (ex: LOS).",
          });
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "support_escalated", bot_agent: "anderson" },
          });
          return;
        }

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content: "Só confirmando: após reiniciar, *voltou* ou *não voltou*?",
        });
        return;
      }

      // triagem (sem numeração)
      if (!customerText && attachments.length === 0) return;

      const numericChoice = mapNumericChoice(customerText);
      let intent = detectIntent(customerText, numericChoice);

      if (isPaymentIntent(customerText) || isBoletoIntent(customerText)) intent = "finance";

      if (state === "triage") {
        if (intent === "support") {
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { gpt_on: true, bot_agent: "anderson", bot_state: "support_check" },
          });

          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content:
              "Certo! Eu sou o *Anderson*, do suporte. 👍\n" +
              "Você está *sem internet* agora ou está *lento/instável*?",
          });
          return;
        }

        if (intent === "finance") {
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { gpt_on: true, bot_agent: "cassia", bot_state: "finance_wait_doc" },
          });

          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content:
              "Oi! Eu sou a *Cassia*, do financeiro. 💳\n" +
              "Me envie o *CPF ou CNPJ do titular* (somente números) para eu localizar boleto/pagamento.",
          });
          return;
        }

        if (intent === "sales") {
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { gpt_on: true, bot_agent: "isa", bot_state: "sales_flow" },
          });

          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "Perfeito! Me diga seu *bairro* e *cidade* para eu te informar cobertura e planos. 😊",
          });
          return;
        }

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content:
            "Para eu te direcionar certinho, me diga: *Suporte*, *Financeiro* ou *Planos*.\n" +
            "Responda com uma dessas opções.",
        });
        return;
      }

      // fallback GPT
      const persona = buildPersonaHeader(agent);
      const reply = await openaiChat({
        apiKey: OPENAI_API_KEY,
        model: OPENAI_MODEL,
        system: persona,
        user: customerText,
        maxTokens: 180,
      });

      await cwSendMessageRetry({
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
