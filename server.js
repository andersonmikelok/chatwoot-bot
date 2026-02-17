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
  rnNotificacaoPagamento,
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
const RECEITANET_TOKEN = process.env.RECEITANET_TOKEN || process.env.RECEITANET_CHATBOT_TOKEN || "";
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

function receiptMatchesBoleto({ analysis, boleto }) {
  const boletoLine = normalizeDigits(boleto?.barras || "");
  const recLine = normalizeDigits(analysis?.barcode_or_line || "");

  const strong = boletoLine && recLine && boletoLine === recLine;

  const boletoAmount = parseMoneyToNumber(boleto?.valor);
  const paidAmount = parseMoneyToNumber(analysis?.amount);

  const amountOk = amountsClose(paidAmount, boletoAmount, 0.10); // tolerância por juros/multa
  const hasDate = Boolean(String(analysis?.date || "").trim());
  const medium = amountOk && hasDate;

  return {
    ok: strong || medium,
    level: strong ? "strong" : medium ? "medium" : "none",
    amountOk,
    strong,
    boletoAmount,
    paidAmount,
    boletoLineLen: boletoLine.length,
    recLineLen: recLine.length,
  };
}

function is401(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("(401)") || msg.includes(" 401 ") || msg.includes("failed (401)") || msg.includes('status":401');
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
  return (conv?.labels || []).map((x) => (typeof x === "string" ? x : x?.title)).filter(Boolean);
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

// Menu SMSNET (só quando GPT OFF)
function isSmsnetMenuAnswer(text) {
  const t = (text || "").trim();
  return t === "1" || t === "2" || t === "3";
}

// Fuga do menu (texto diferente de 1/2/3)
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
  return buildAuthHeaders({ ...auth, uid: auth.uid || CW_UID });
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
// Finance helpers (ordem correta + copiável)
// =====================
async function financeSendBoletoPieces({ conversationId, headers, boleto }) {
  const venc = boleto?.vencimento || "";
  const valor = boleto?.valor;
  const link = (boleto?.link || "").trim();
  const pix = (boleto?.qrcode_pix || "").trim();
  const barras = (boleto?.barras || "").trim();
  const pdf = (boleto?.pdf || "").trim();

  const header = [];
  header.push("📄 *Boleto em aberto*");
  if (venc) header.push(`🗓️ *Vencimento:* ${venc}`);
  if (valor !== undefined && valor !== null && String(valor).trim() !== "") {
    header.push(`💰 *Valor:* R$ ${String(valor).replace(".", ",")}`);
  }
  await cwSendMessageRetry({ conversationId, headers, content: header.join("\n") });
  await sleep(250);

  if (link) {
    await cwSendMessageRetry({ conversationId, headers, content: `🔗 *Link do boleto:*\n${link}` });
    await sleep(250);
  }

  if (barras) {
    await cwSendMessageRetry({ conversationId, headers, content: `🏷️ *Código de barras:*\n${barras}` });
    await sleep(250);
  }

  if (pix) {
    const parts = chunkString(pix, 1200);
    if (parts.length === 1) {
      await cwSendMessageRetry({ conversationId, headers, content: `📌 *PIX copia e cola:*\n${parts[0]}` });
      await sleep(250);
    } else {
      await cwSendMessageRetry({
        conversationId,
        headers,
        content: `📌 *PIX copia e cola (parte 1/${parts.length}):*\n${parts[0]}`,
      });
      await sleep(250);
      for (let i = 1; i < parts.length; i++) {
        await cwSendMessageRetry({
          conversationId,
          headers,
          content: `📌 *PIX copia e cola (parte ${i + 1}/${parts.length}):*\n${parts[i]}`,
        });
        await sleep(250);
      }
    }
  }

  if (pdf) {
    await cwSendMessageRetry({ conversationId, headers, content: `📎 *PDF:*\n${pdf}` });
    await sleep(250);
  }
}

async function financeSendBoletoByDoc({ conversationId, headers, cpfcnpj, wa, silent = false }) {
  const waNorm = normalizePhoneBR(wa || "");

  const client = await rnFindClient({
    baseUrl: RECEITANET_BASE_URL,
    token: RECEITANET_TOKEN,
    app: RECEITANET_APP,
    cpfcnpj,
    phone: waNorm || "",
  });

  if (!client?.found) {
    if (!silent) {
      await cwSendMessageRetry({
        conversationId,
        headers,
        content:
          "Não consegui localizar esse CPF/CNPJ no sistema.\nMe envie o *CPF ou CNPJ do titular do contrato* (somente números), por favor.",
      });
    }
    await cwSetAttrsRetry({
      conversationId,
      headers,
      attrs: { bot_state: "finance_wait_doc", bot_agent: "cassia", last_cpfcnpj: "" },
    });
    return { ok: false, reason: "not_found" };
  }

  const idCliente = String(client?.data?.idCliente || "").trim();
  if (!idCliente) {
    console.log("🧾 [FIN] ERRO: rnFindClient retornou sem idCliente. Keys:", Object.keys(client?.data || {}));
    if (!silent) {
      await cwSendMessageRetry({
        conversationId,
        headers,
        content:
          "Consegui localizar o cadastro, mas o sistema não retornou o identificador do cliente para liberação automática.\n" +
          "Vou encaminhar para conferência manual rapidinho. ✅",
      });
    }
    await cwSetAttrsRetry({
      conversationId,
      headers,
      attrs: { bot_state: "finance_wait_need", bot_agent: "cassia", last_cpfcnpj: cpfcnpj },
    });
    return { ok: false, reason: "missing_id_cliente" };
  }

  const contato = waNorm || "";

  const debitos = await rnListDebitos({
    baseUrl: RECEITANET_BASE_URL,
    token: RECEITANET_TOKEN,
    app: RECEITANET_APP,
    cpfcnpj,
    status: 0,
  });

  if (!Array.isArray(debitos) || debitos.length === 0) {
    if (!silent) {
      await cwSendMessageRetry({
        conversationId,
        headers,
        content:
          "✅ Encontrei seu cadastro, mas *não consta boleto em aberto* no momento.\n" +
          "Se você já pagou, pode me enviar o *comprovante* aqui que eu confirmo.",
      });
    }
    await cwSetAttrsRetry({
      conversationId,
      headers,
      attrs: {
        bot_state: "finance_wait_need",
        bot_agent: "cassia",
        last_cpfcnpj: cpfcnpj,
        finance_id_cliente: idCliente,
        finance_current_boleto: null,
      },
    });
    return { ok: true, hasOpen: false };
  }

  const { boleto, overdueCount } = pickBestOverdueBoleto(debitos);

  if (!boleto) {
    if (!silent) {
      await cwSendMessageRetry({
        conversationId,
        headers,
        content:
          "Encontrei débitos, mas não consegui montar o boleto automaticamente.\n" +
          "Você quer *2ª via do boleto* ou quer *validar um pagamento*?",
      });
    }
    await cwSetAttrsRetry({
      conversationId,
      headers,
      attrs: { bot_state: "finance_wait_need", bot_agent: "cassia", last_cpfcnpj: cpfcnpj, finance_id_cliente: idCliente },
    });
    return { ok: false, reason: "no_boleto" };
  }

  await cwSetAttrsRetry({
    conversationId,
    headers,
    attrs: {
      bot_state: "finance_wait_need",
      bot_agent: "cassia",
      last_cpfcnpj: cpfcnpj,
      finance_id_cliente: idCliente,
      finance_overdue_count: overdueCount,
      finance_current_boleto: {
        valor: boleto.valor,
        vencimento: boleto.vencimento,
        barras: boleto.barras,
        debito_id: boleto.debito_id || "",
      },
    },
  });

  if (silent) return { ok: true, hasOpen: true, boleto, overdueCount };

  let blocked = false;
  try {
    const acesso = await rnVerificarAcesso({
      baseUrl: RECEITANET_BASE_URL,
      token: RECEITANET_TOKEN,
      app: RECEITANET_APP,
      idCliente,
      contato,
    });
    const a = acesso?.data || {};
    blocked = a?.bloqueado === true || a?.liberado === false || String(a?.situacao || "").toLowerCase().includes("bloque");
  } catch {}

  if (blocked) {
    await cwSendMessageRetry({
      conversationId,
      headers,
      content:
        "Oi! 😊 Verifiquei aqui que existe uma pendência financeira, por isso o acesso ficou temporariamente bloqueado.\n" +
        "Assim que o pagamento for realizado e compensado, a liberação acontece automaticamente.\n" +
        "Já vou te enviar as opções pra regularizar.",
    });
  }

  await cwSendMessageRetry({
    conversationId,
    headers,
    content: "Perfeito 😊 Já localizei aqui.\nVou te enviar agora as informações do boleto (link / PIX / código de barras).",
  });
  await sleep(200);

  await financeSendBoletoPieces({ conversationId, headers, boleto });

  await cwSendMessageRetry({
    conversationId,
    headers,
    content: "Pode pagar pela opção que for mais prática pra você 🙂\n⚡ Pagando via *PIX*, a liberação costuma ser *imediata*.",
  });
  await sleep(200);

  await cwSendMessageRetry({
    conversationId,
    headers,
    content:
      "👉 Se você já realizou o pagamento, pode enviar o comprovante aqui. Vou analisar a imagem ou PDF pra confirmar que é esse boleto e agilizar a liberação! ✅",
  });
  await sleep(200);

  if (overdueCount > 1) {
    await cwSendMessageRetry({
      conversationId,
      headers,
      content:
        "⚠️ Identifiquei *mais de 1 boleto vencido*.\n" +
        "Para ver e emitir todos os boletos, acesse o Portal do Assinante:\n" +
        "https://i9net.centralassinante.com.br/",
    });
  }

  return { ok: true, hasOpen: true, boleto, overdueCount };
}

// =====================
// Server
// =====================
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

      // evita briga com mensagens do menu do SMSNET
      if (isSmsnetSystemMessage(customerText)) return;

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
        await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { whatsapp_phone: wa } });
      }

      // ============================
      // ATIVA GPT POR 3 "FUGAS" DO MENU (quando GPT OFF)
      // - Se o cliente responder 1/2/3 (menu), zera contador e NÃO interfere.
      // - Se responder texto (fuga), incrementa.
      // ============================
      if (!gptOn) {
        if (isSmsnetMenuAnswer(customerText)) {
          // respondeu o menu do SMSNET -> zera e não briga
          if (menuIgnoreCount !== 0) {
            await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { menu_ignore_count: 0 } });
          }
          console.log("✅ respondeu menu SMSNET => zera contador e não interfere");
          return;
        }

        if (isMenuEscape(customerText)) {
          const next = menuIgnoreCount + 1;
          console.log("🟡 ignorou menu", { conversationId, nextCount: next, limit: AUTO_GPT_THRESHOLD });

          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { menu_ignore_count: next },
          });

          if (next < AUTO_GPT_THRESHOLD) {
            // ainda não ativou, não responde nada (evita dois atendentes)
            return;
          }

          console.log("⚡ GPT autoativado (limite atingido) => aplicando label gpt_on");
          await cwAddLabelsRetry({
            conversationId,
            headers: cwHeaders,
            currentLabels: labels,
            labelsToAdd: [LABEL_GPT_ON],
          });

          // zera contador e marca estado inicial
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { menu_ignore_count: 0, bot_state: "triage", bot_agent: "isa", gpt_on: true },
          });

          // boas-vindas UMA vez
          const welcomeSent = labelSet.has(LABEL_WELCOME_SENT) || ca.welcome_sent === true;
          if (!welcomeSent) {
            await cwAddLabelsRetry({
              conversationId,
              headers: cwHeaders,
              currentLabels: [...labels, LABEL_GPT_ON],
              labelsToAdd: [LABEL_WELCOME_SENT],
            });
            await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { welcome_sent: true } });

            await cwSendMessageRetry({
              conversationId,
              headers: cwHeaders,
              content: "✅ Entendi. Vou te atender por aqui sem precisar do menu.",
            });
            await cwSendMessageRetry({
              conversationId,
              headers: cwHeaders,
              content:
                "Oi! Eu sou a *Isa*, da i9NET. 😊\nMe diga o que você precisa:\n1) *Sem internet / suporte*\n2) *Financeiro (boleto/2ª via/pagamento)*\n3) *Planos/contratar*\n\n(Se preferir, pode escrever: “sem internet”, “boleto”, “planos”…)",
            });
          }

          // não processa a mesma mensagem ainda (evita duplicar pergunta)
          return;
        }

        // se vier vazio e sem anexo, ignora
        if (!customerText && attachments.length === 0) return;

        // qualquer outra coisa com GPT OFF: não responde
        return;
      }

      // ==========================================
      // GPT ON DAQUI PRA BAIXO
      // IMPORTANTE: NUNCA tratar "1/2/3" como menu SMSNET aqui.
      // ==========================================

      // ============================
      // ANEXOS (comprovante)
      // ============================
      if (attachments.length > 0) {
        const att = pickFirstAttachment(attachments);
        const dataUrl = att?.data_url || att?.dataUrl || null;
        const fileType = att?.file_type || att?.tipo_de_arquivo || "unknown";

        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: {
            bot_agent: "cassia",
            bot_state: "finance_wait_doc",
            last_attachment_url: dataUrl || "",
            last_attachment_type: fileType,
          },
        });

        if (dataUrl) {
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
              attrs: { last_receipt_json: analysis || null, last_receipt_ts: Date.now() },
            });

            await cwSendMessageRetry({
              conversationId,
              headers: cwHeaders,
              content:
                "📎 *Recebi seu comprovante.*\n" +
                (analysis?.summaryText || "Consegui ler o comprovante.") +
                "\n\nPara eu conferir se foi o *mês correto* no sistema, me envie o *CPF ou CNPJ do titular* (somente números).",
            });
            return;
          }
        }

        // fallback se não deu pra analisar
        if (!customerText) {
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content:
              "📎 Recebi seu arquivo. Para eu localizar e validar no sistema, me envie o *CPF ou CNPJ do titular* (somente números).",
          });
          return;
        }
      }

      // se não tem nada, ignora
      if (!customerText && attachments.length === 0) return;

      // ============================
      // TRIAGEM (Isa) — aceita 1/2/3 ou texto
      // ============================
      const numericChoice = mapNumericChoice(customerText); // 1/2/3 ou null
      const intent = detectIntent(customerText, numericChoice);

      if (state === "triage") {
        if (intent === "support") {
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_agent: "anderson", bot_state: "support_check" },
          });
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "Certo! Eu sou o *Anderson*, do suporte. 👍\nVocê está *sem internet* agora ou está *lento/instável*?",
          });
          return;
        }

        if (intent === "finance") {
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_agent: "cassia", bot_state: "finance_wait_need" },
          });
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content:
              "Oi! Eu sou a *Cassia*, do financeiro. 💳\nVocê precisa de:\n1) *Boleto/2ª via*\n2) *Informar pagamento / validar comprovante*\n\n(Responda 1/2 ou escreva “boleto” / “paguei”)",
          });
          return;
        }

        if (intent === "sales") {
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_agent: "isa", bot_state: "sales_flow" },
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
          content: "Só para eu te direcionar certinho:\n1) *Sem internet / suporte*\n2) *Financeiro (boleto/pagamento)*\n3) *Planos/contratar*",
        });
        return;
      }

      // ============================
      // SUPORTE (Anderson)
      // ============================
      if (state === "support_check") {
        // Se cliente respondeu "sem internet", já tentamos localizar e checar bloqueio.
        // Primeiro tenta achar por WhatsApp, depois por CPF/CNPJ (se vier na msg).
        const cpfDigits = extractCpfCnpjDigits(customerText);

        let client = null;

        if (wa) {
          client = await rnFindClient({
            baseUrl: RECEITANET_BASE_URL,
            token: RECEITANET_TOKEN,
            app: RECEITANET_APP,
            phone: wa,
          });
        }

        if ((!client || !client.found) && cpfDigits) {
          console.log("🧾 [SUP] buscando cliente por CPF/CNPJ", { conversationId, cpfDigitsLen: cpfDigits.length });
          client = await rnFindClient({
            baseUrl: RECEITANET_BASE_URL,
            token: RECEITANET_TOKEN,
            app: RECEITANET_APP,
            cpfcnpj: cpfDigits,
          });

          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { cpfcnpj: cpfDigits },
          });
        }

        if (!client?.found) {
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_state: "support_need_doc", bot_agent: "anderson" },
          });

          // **texto neutro** (não fala "bloqueio" aqui)
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content:
              "Para eu verificar seu *acesso* no sistema, me envie o *CPF ou CNPJ do titular* (somente números), por favor.",
          });
          return;
        }

        const cpfUse = onlyDigits(String(client?.data?.cpfCnpj || client?.data?.cpfcnpj || ca.cpfcnpj || ""));
        const idCliente = String(client?.data?.idCliente || "").trim();

        if (cpfUse) {
          await cwSetAttrsRetry({ conversationId, headers: cwHeaders, attrs: { cpfcnpj: cpfUse } });
        }

        // Verifica se há débitos (status=0) e se está bloqueado
        let blocked = false;
        if (idCliente && wa) {
          try {
            const acesso = await rnVerificarAcesso({
              baseUrl: RECEITANET_BASE_URL,
              token: RECEITANET_TOKEN,
              app: RECEITANET_APP,
              idCliente,
              contato: wa,
            });
            const a = acesso?.data || {};
            blocked = a?.bloqueado === true || a?.liberado === false || String(a?.situacao || "").toLowerCase().includes("bloque");
          } catch (e) {
            console.log("⚠️ [SUP] rnVerificarAcesso falhou", e?.message || e);
          }
        }

        let debitos = [];
        try {
          debitos = await rnListDebitos({
            baseUrl: RECEITANET_BASE_URL,
            token: RECEITANET_TOKEN,
            app: RECEITANET_APP,
            cpfcnpj: cpfUse,
            status: 0,
          });
        } catch (e) {
          console.log("⚠️ [SUP] rnListDebitos falhou", e?.message || e);
        }

        const { boleto: overdueBoleto } = pickBestOverdueBoleto(Array.isArray(debitos) ? debitos : []);

        if (blocked || overdueBoleto) {
          // manda pro financeiro automaticamente e envia boleto completo
          await cwSetAttrsRetry({
            conversationId,
            headers: cwHeaders,
            attrs: { bot_agent: "cassia", bot_state: "finance_wait_need" },
          });

          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content:
              "Entendi. Verifiquei no sistema e seu acesso está com *pendência financeira*.\n" +
              "Vou te enviar agora as opções pra regularizar (PIX / código de barras). 👇",
          });

          // envia boleto pelo CPF/CNPJ (pega o melhor vencido e manda)
          await financeSendBoletoByDoc({ conversationId, headers: cwHeaders, cpfcnpj: cpfUse, wa, silent: false });
          return;
        }

        // sem bloqueio / sem débito: troubleshooting
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "support_wait_feedback", bot_agent: "anderson" },
        });

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content:
            "No sistema não aparece bloqueio agora.\nVamos fazer um teste rápido:\n" +
            "1) Desligue a ONU/roteador por *2 minutos*\n" +
            "2) Ligue novamente\n" +
            "3) Aguarde *2 minutos*\n\nDepois me diga: voltou?",
        });
        return;
      }

      if (state === "support_need_doc") {
        const cpfDigits = extractCpfCnpjDigits(customerText);
        if (!cpfDigits) {
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "Opa! Envie *CPF (11)* ou *CNPJ (14)*, somente números.",
          });
          return;
        }

        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { cpfcnpj: cpfDigits, bot_state: "support_check", bot_agent: "anderson" },
        });

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content: "Perfeito. Só um instante que vou verificar seu *acesso* no sistema. ✅",
        });
        return;
      }

      // ============================
      // FINANCEIRO (Cassia)
      // ============================
      if (state === "finance_wait_need") {
        const choice = mapNumericChoice(customerText);

        const need =
          choice === 1 || isBoletoIntent(customerText)
            ? "boleto"
            : choice === 2 || isPaymentIntent(customerText)
            ? "comprovante"
            : null;

        if (!need) {
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "Me diga: você quer *1) boleto/2ª via* ou *2) validar pagamento/comprovante*?",
          });
          return;
        }

        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { finance_need: need, bot_state: "finance_wait_doc", bot_agent: "cassia" },
        });

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content: "Certo. Me envie o *CPF ou CNPJ do titular* (somente números).",
        });
        return;
      }

      if (state === "finance_wait_doc") {
        const cpfDigits = extractCpfCnpjDigits(customerText);
        if (!cpfDigits) {
          await cwSendMessageRetry({
            conversationId,
            headers: cwHeaders,
            content: "Para eu localizar no sistema: envie *CPF (11)* ou *CNPJ (14)*, somente números.",
          });
          return;
        }

        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { cpfcnpj: cpfDigits, last_cpfcnpj: cpfDigits, bot_state: "finance_handle", bot_agent: "cassia" },
        });

        console.log("🧾 [FIN] CPF/CNPJ recebido -> consultando ReceitaNet", { conversationId, cpfLen: cpfDigits.length });

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content: "Beleza. Vou verificar seu cadastro e já te retorno. ✅",
        });

        // Se o cliente já mandou comprovante antes (last_receipt_json), validar mês/linha
        const lastReceipt = ca.last_receipt_json || null;

        // Puxa boleto e envia (completo)
        const result = await financeSendBoletoByDoc({
          conversationId,
          headers: cwHeaders,
          cpfcnpj: cpfDigits,
          wa,
          silent: false,
        });

        // Se existe comprovante analisado e existe boleto atual, tenta checar se pagou mês errado
        if (lastReceipt && result?.boleto) {
          const match = receiptMatchesBoleto({ analysis: lastReceipt, boleto: result.boleto });
          if (!match.ok) {
            await cwSendMessageRetry({
              conversationId,
              headers: cwHeaders,
              content:
                "⚠️ Observação: pelo comprovante que você enviou, *não consegui confirmar* que o pagamento corresponde a este boleto em aberto.\n" +
                "Pode ser que tenha sido pago um mês diferente. Se quiser, me envie novamente o comprovante (ou me diga a data/valor) que eu confiro certinho.",
            });
          } else {
            // Se bateu, tenta notificar pagamento/liberar em confiança
            const idCliente = String(ca.finance_id_cliente || "");
            if (idCliente) {
              try {
                await rnNotificacaoPagamento({
                  baseUrl: RECEITANET_BASE_URL,
                  token: RECEITANET_TOKEN,
                  app: RECEITANET_APP,
                  idCliente,
                  contato: wa || "",
                });
              } catch (e) {
                console.log("⚠️ [FIN] rnNotificacaoPagamento falhou", e?.message || e);
              }
            }

            await cwSendMessageRetry({
              conversationId,
              headers: cwHeaders,
              content:
                "✅ Pelo comprovante, o pagamento *parece corresponder* ao boleto em aberto.\n" +
                "Se foi *PIX*, a liberação costuma ser imediata. Se foi *código de barras*, pode levar um prazo de compensação.\n" +
                "Se não liberar em até alguns minutos, me avise aqui.",
            });
          }
        }

        // volta ao “need” para seguir conversa
        await cwSetAttrsRetry({
          conversationId,
          headers: cwHeaders,
          attrs: { bot_state: "finance_wait_need", bot_agent: "cassia" },
        });
        return;
      }

      // ============================
      // VENDAS (Isa)
      // ============================
      if (state === "sales_flow") {
        // aqui pode ser simples, ou usar GPT controlado
        const persona = buildPersonaHeader("isa");
        const reply = await openaiChat({
          apiKey: OPENAI_API_KEY,
          model: OPENAI_MODEL,
          system:
            persona +
            "\nRegras extras:\n- Não envie menu numérico.\n- Seja objetiva.\n- Coletar bairro e cidade e oferecer planos.\n",
          user: customerText,
          maxTokens: 220,
        });

        await cwSendMessageRetry({
          conversationId,
          headers: cwHeaders,
          content: reply || "Certo! Me diga seu bairro e cidade para eu te passar cobertura e planos.",
        });
        return;
      }

      // ============================
      // FALLBACK (GPT bem controlado)
      // ============================
      const persona = buildPersonaHeader(agent);
      const reply = await openaiChat({
        apiKey: OPENAI_API_KEY,
        model: OPENAI_MODEL,
        system:
          persona +
          "\nRegras:\n- Não confundir menu SMSNET com o menu do bot.\n- Se o usuário responder '1/2/3' e o estado for triage/finance_wait_need, interpretar como opção.\n- Não repetir perguntas já respondidas.\n",
        user: customerText,
        maxTokens: 220,
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

// Se você usa `node server.js` direto (sem index.js chamando startServer), descomente:
// startServer();
