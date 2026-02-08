// servidor.js
import express from "express";
import {
  buildHeaders,
  signIn,
  getConversation,
  sendMessage,
  addLabel,
  setCustomAttributes,
  downloadAttachment
} from "./biblioteca/chatwoot.js";

import {
  normalizeText,
  looksLikeCPFOrCNPJ,
  normalizePhoneForReceita,
  onlyDigits,
  isYes,
  isNo,
  mapNumericMenu,
  isConnectivityIssue,
  parseProofOrBoleto
} from "./biblioteca/utils.js";

import { rnFindClient, rnListDebitos, pickOpenBoletoFromDebitos, summarizeClient } from "./biblioteca/receitanet.js";
import { oaiAnalyzePaymentProof, oaiFallbackReply } from "./biblioteca/openai.js";

// labels
const LABEL_GPT_ON = "gpt_on";
const LABEL_WELCOME_SENT = "gpt_welcome_sent";

// anti spam simples
const recentSent = new Map();
function throttleSend(conversationId, text, ms = 5000) {
  const now = Date.now();
  const prev = recentSent.get(conversationId);
  if (prev && prev.text === text && now - prev.ts < ms) return true;
  recentSent.set(conversationId, { text, ts: now });
  return false;
}

function extractWhatsAppFromPayload(payload) {
  const w =
    payload?.contact?.phone_number ||
    payload?.sender?.additional_attributes?.whatsapp ||
    payload?.remetente?.atributos_adicionais?.whatsapp ||
    payload?.conversation?.meta?.sender?.additional_attributes?.whatsapp ||
    payload?.conversation?.meta?.remetente?.atributos_adicionais?.whatsapp ||
    payload?.conversation?.meta?.contact?.phone_number ||
    null;

  const digits = onlyDigits(w);
  return digits || null;
}

function extractAttachments(payload) {
  const a1 = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const a2 = Array.isArray(payload?.anexos) ? payload.anexos : [];
  const a3 = Array.isArray(payload?.message?.attachments) ? payload.message.attachments : [];
  const a4 = Array.isArray(payload?.mensagem?.anexos) ? payload.mensagem.anexos : [];
  return [...a1, ...a2, ...a3, ...a4].filter(Boolean);
}

function pickAttachmentInfo(att) {
  const fileType = att.file_type || att.tipo_de_arquivo || "unknown";
  const dataUrl = att.data_url || att.dataUrl || null;
  return { fileType, dataUrl };
}

function choosePersona(intent) {
  // triagem: Isa, financeiro: Cassia, suporte: Anderson
  if (intent === "financeiro" || intent === "boleto" || intent === "comprovante") {
    return { name: "Cassia", role: "Financeiro: boletos, 2ª via, pagamentos, comprovação." };
  }
  if (intent === "suporte") {
    return { name: "Anderson", role: "Suporte técnico: sem internet, instabilidade, orientações básicas e abertura de chamado." };
  }
  return { name: "Isa", role: "Triagem: identifica rapidamente se é suporte, financeiro ou vendas e encaminha." };
}

export function createServer(env) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  const {
    CHATWOOT_URL,
    CHATWOOT_ACCOUNT_ID,
    CW_UID,
    CW_PASSWORD,
    OPENAI_API_KEY,
    OPENAI_MODEL,
    RECEITANET_BASE_URL,
    RECEITANET_CHATBOT_TOKEN,
    RECEITANET_APP
  } = env;

  let cwAuth = {
    accessToken: env.CW_ACCESS_TOKEN || "",
    client: env.CW_CLIENT || "",
    uid: CW_UID || "",
    tokenType: env.CW_TOKEN_TYPE || "Bearer"
  };

  async function ensureChatwootAuth() {
    if (cwAuth.accessToken && cwAuth.client) return;
    const signed = await signIn({ baseUrl: CHATWOOT_URL, email: CW_UID, password: CW_PASSWORD });
    cwAuth = signed;
  }

  async function cw(method) {
    await ensureChatwootAuth();
    return method(buildHeaders(cwAuth));
  }

  async function safeSend(conversationId, content) {
    if (throttleSend(conversationId, content, 5000)) return;
    try {
      return await cw((headers) =>
        sendMessage({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers,
          content
        })
      );
    } catch (e) {
      // se token expirou, renova e tenta 1x
      if (e?.status === 401) {
        const signed = await signIn({ baseUrl: CHATWOOT_URL, email: CW_UID, password: CW_PASSWORD });
        cwAuth = signed;
        return cw((headers) =>
          sendMessage({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers,
            content
          })
        );
      }
      throw e;
    }
  }

  async function saveState(conversationId, attrs) {
    return cw((headers) =>
      setCustomAttributes({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers,
        attrs
      })
    );
  }

  async function getConv(conversationId) {
    try {
      return await cw((headers) =>
        getConversation({
          baseUrl: CHATWOOT_URL,
          accountId: CHATWOOT_ACCOUNT_ID,
          conversationId,
          headers
        })
      );
    } catch (e) {
      if (e?.status === 401) {
        const signed = await signIn({ baseUrl: CHATWOOT_URL, email: CW_UID, password: CW_PASSWORD });
        cwAuth = signed;
        return cw((headers) =>
          getConversation({
            baseUrl: CHATWOOT_URL,
            accountId: CHATWOOT_ACCOUNT_ID,
            conversationId,
            headers
          })
        );
      }
      throw e;
    }
  }

  async function ensureGptOn(conversationId) {
    // simples: se já estiver on não faz nada
    const conv = await getConv(conversationId);
    const labels = new Set((conv?.labels || []).map((x) => (typeof x === "string" ? x : x?.title)).filter(Boolean));
    if (labels.has(LABEL_GPT_ON)) return { conv, labels };

    await cw((headers) =>
      addLabel({
        baseUrl: CHATWOOT_URL,
        accountId: CHATWOOT_ACCOUNT_ID,
        conversationId,
        headers,
        label: LABEL_GPT_ON
      })
    );

    return { conv: await getConv(conversationId), labels: new Set([...labels, LABEL_GPT_ON]) };
  }

  // ---------- ReceitaNet helpers ----------
  async function rnEnsureClient({ cpfcnpj, phone, ca, conversationId }) {
    // cache simples (evita chamar toda msg)
    const now = Date.now();
    const cached = ca?.rn_client_cache || null;
    const fresh = cached && cached.ts && now - cached.ts < 2 * 60 * 1000; // 2min

    // se já tenho idCliente e fresh, retorna
    if (fresh && cached?.idCliente) return cached;

    // tenta buscar por CPF/CNPJ primeiro
    if (cpfcnpj) {
      const r = await rnFindClient({
        baseUrl: RECEITANET_BASE_URL,
        token: RECEITANET_CHATBOT_TOKEN,
        app: RECEITANET_APP,
        cpfcnpj
      });
      if (r.ok) {
        const summary = summarizeClient(r.data);
        const next = { ts: now, ...summary, cpfcnpj };
        await saveState(conversationId, { rn_client_cache: next, cpfcnpj });
        return next;
      }
    }

    // se não, tenta por telefone
    if (phone) {
      const r = await rnFindClient({
        baseUrl: RECEITANET_BASE_URL,
        token: RECEITANET_CHATBOT_TOKEN,
        app: RECEITANET_APP,
        phone
      });
      if (r.ok) {
        const summary = summarizeClient(r.data);
        const next = { ts: now, ...summary, phone };
        await saveState(conversationId, { rn_client_cache: next, whatsapp_phone: phone });
        return next;
      }
    }

    const next = { ts: now, idCliente: null, razaoSocial: "", cpfCnpj: "", notFound: true };
    await saveState(conversationId, { rn_client_cache: next });
    return next;
  }

  async function rnGetOpenBoletoByCpf(cpfcnpj) {
    const deb = await rnListDebitos({
      baseUrl: RECEITANET_BASE_URL,
      token: RECEITANET_CHATBOT_TOKEN,
      app: RECEITANET_APP,
      cpfcnpj,
      status: 0,
      page: 1
    });

    if (!deb.ok) return null;
    return pickOpenBoletoFromDebitos(deb.data);
  }

  function formatBoletoMessage(b) {
    const parts = [];
    parts.push(`⚠️ Identifiquei *fatura em aberto* (pode causar bloqueio).`);
    if (b.vencimento) parts.push(`📅 Vencimento: *${b.vencimento}*`);
    if (b.valor !== null && b.valor !== undefined) parts.push(`💰 Valor: *R$ ${Number(b.valor).toFixed(2)}*`);
    if (b.link) parts.push(`🔗 Boleto (PDF/link): ${b.link}`);
    if (b.qrcode_pix) parts.push(`💠 PIX (QR/Texto): ${b.qrcode_pix}`);
    if (b.barras) parts.push(`🏦 Código de barras: ${b.barras}`);
    parts.push(`\nSe você *já pagou*, envie o *comprovante* aqui que eu confiro se foi o mês correto e te explico o prazo de compensação.`);
    return parts.join("\n");
  }

  // ---------- Rotas ----------
  app.get("/", (_req, res) => res.send("🚀 Bot online"));

  app.post("/chatwoot-webhook", async (req, res) => {
    res.status(200).send("ok");

    try {
      const event = req.body?.event || req.body?.evento;
      if (event !== "message_created" && event !== "mensagem_criada") return;

      const messageType = req.body?.message_type || req.body?.tipo_de_mensagem;
      const isIncoming =
        messageType === "incoming" || messageType === 0 || messageType === "0" || messageType === "recebida";
      if (!isIncoming) return;

      const conversationId = req.body?.conversation?.id || req.body?.conversa?.id;
      if (!conversationId) return;

      const customerText = normalizeText(req.body?.content || req.body?.conteudo || "");
      const attachments = extractAttachments(req.body);

      console.log("🔥 webhook incoming:", { conversationId, customerText: customerText || "(vazio)", anexos: attachments.length });

      // garante gpt_on e pega conversa atual
      const { conv } = await ensureGptOn(conversationId);

      const ca = conv?.custom_attributes || {};
      const state = ca.gpt_state || "idle";
      const intent = ca.gpt_intent || "triagem";

      const waRaw = extractWhatsAppFromPayload(req.body);
      const waPhone = normalizePhoneForReceita(waRaw);

      // salva whatsapp no state
      if (waPhone && waPhone !== ca.whatsapp_phone) {
        await saveState(conversationId, { whatsapp_phone: waPhone });
      }

      // se menu numérico
      const mapped = mapNumericMenu(customerText);
      if (mapped) {
        await saveState(conversationId, { gpt_intent: mapped, gpt_state: "awaiting_need" });
        const who = choosePersona(mapped);
        await safeSend(conversationId, `Oi! Eu sou a ${who.name}, da i9NET. 😊 Me diga rapidinho o que aconteceu.`);
        return;
      }

      const parsed = parseProofOrBoleto(customerText);

      // Detecta intenção forte mesmo fora do estado atual (evita “voltar atrás” e causar loop)
      let nextIntent = intent;
      if (isConnectivityIssue(customerText)) nextIntent = "suporte";
      else if (parsed.mentionsBoleto) nextIntent = "boleto";
      else if (parsed.mentionsProof || attachments.length > 0) nextIntent = "comprovante";
      else if (customerText.toLowerCase().includes("plano") || customerText.toLowerCase().includes("contratar")) nextIntent = "vendas";

      // CPF/CNPJ vindo em qualquer estado deve ser aceito
      let cpfcnpj = ca.cpfcnpj || "";
      if (looksLikeCPFOrCNPJ(customerText)) {
        cpfcnpj = onlyDigits(customerText);
        await saveState(conversationId, { cpfcnpj });
      }

      // ----- 1) Se chegou anexo (imagem/pdf) -----
      if (attachments.length > 0) {
        await saveState(conversationId, { gpt_intent: "comprovante", gpt_state: "awaiting_after_proof" });

        const { fileType, dataUrl } = pickAttachmentInfo(attachments[0]);
        console.log("📎 ANEXO:", { fileType, dataUrl: dataUrl ? dataUrl.slice(0, 80) + "..." : null });

        if (dataUrl) {
          // baixa e tenta analisar se for imagem
          const headers = buildHeaders(cwAuth);
          const dl = await downloadAttachment({ baseUrl: CHATWOOT_URL, headers, dataUrl });
          console.log("⬇️ download:", { ok: dl.ok, status: dl.status, bytes: dl.bytes, contentType: dl.contentType });

          if (dl.ok && dl.contentType.startsWith("image/") && dl.bytes <= 4 * 1024 * 1024) {
            const who = choosePersona("financeiro");
            const analysis = await oaiAnalyzePaymentProof({
              apiKey: OPENAI_API_KEY,
              model: OPENAI_MODEL,
              noteText: customerText || "Comprovante enviado.",
              imageDataUrl: dl.dataUri,
              personaName: who.name
            });

            await safeSend(conversationId, analysis);

            // depois do comprovante: se tenho CPF, cruza com débitos (mês errado / boleto anterior)
            if (!cpfcnpj) {
              await saveState(conversationId, { gpt_state: "awaiting_cpf_for_proof" });
              await safeSend(conversationId, "Para eu confirmar se foi o *mês correto*, me envie o *CPF ou CNPJ do titular* (somente números).");
              return;
            }

            const openBoleto = await rnGetOpenBoletoByCpf(cpfcnpj);
            if (openBoleto) {
              await safeSend(
                conversationId,
                `⚠️ Ainda consta *fatura em aberto* no sistema (pode ser mês anterior). Vou te enviar os dados:`
              );
              await safeSend(conversationId, formatBoletoMessage(openBoleto));
              return;
            }

            await safeSend(conversationId, "✅ Aqui no sistema não apareceu boleto vencido no momento. Se sua internet ainda estiver bloqueada, me diga: *sem internet* ou *lentidão*?");
            return;
          }
        }

        // se não deu para analisar (pdf, etc)
        await safeSend(conversationId, "📎 Recebi seu arquivo. Ele é comprovante de pagamento? Se sim, foi *PIX* ou *boleto (código de barras)*?");
        return;
      }

      // texto vazio sem anexo: ignora
      if (!customerText) return;

      // ----- 2) Se o cliente disse “sem internet” (ou suporte) -----
      if (isConnectivityIssue(customerText) || nextIntent === "suporte") {
        await saveState(conversationId, { gpt_intent: "suporte", gpt_state: "support_flow" });

        const client = await rnEnsureClient({ cpfcnpj, phone: waPhone || ca.whatsapp_phone || "", ca, conversationId });

        if (client?.notFound || !client?.idCliente) {
          await safeSend(conversationId, "Não localizei seu cadastro pelo WhatsApp. Você já é cliente i9NET? (Responda *SIM* ou *NÃO*)");
          await saveState(conversationId, { gpt_state: "awaiting_customer_status", gpt_intent: "suporte" });
          return;
        }

        // se achou cliente, checa débitos (bloqueio)
        const openBoleto = cpfcnpj ? await rnGetOpenBoletoByCpf(cpfcnpj) : null;

        if (openBoleto) {
          await safeSend(conversationId, `Oi ${client.razaoSocial || "cliente"}! Encontrei *fatura em aberto* que pode estar causando a falta de internet.`);
          await safeSend(conversationId, formatBoletoMessage(openBoleto));
          return;
        }

        // sem débito aberto: passo básico suporte
        const who = choosePersona("suporte");
        await safeSend(conversationId, `Oi ${client.razaoSocial || ""}! Eu sou o ${who.name}. Vamos fazer um teste rápido: desligue o roteador/ONU por *2 minutos*, ligue novamente e me diga se voltou.`);
        return;
      }

      // ----- 3) Estado: aguardando “já é cliente?” -----
      if (state === "awaiting_customer_status") {
        if (looksLikeCPFOrCNPJ(customerText)) {
          // cliente pulou direto para CPF -> segue sem perguntar de novo
          await saveState(conversationId, { gpt_state: "support_flow", gpt_intent: "suporte" });
          await safeSend(conversationId, "Perfeito. Só um instante que vou localizar seu cadastro...");
          // reprocessa como suporte (simplificado)
          const client = await rnEnsureClient({ cpfcnpj, phone: waPhone || ca.whatsapp_phone || "", ca, conversationId });
          if (client?.idCliente) {
            const openBoleto = await rnGetOpenBoletoByCpf(cpfcnpj);
            if (openBoleto) {
              await safeSend(conversationId, formatBoletoMessage(openBoleto));
              return;
            }
            await safeSend(conversationId, "Cadastro localizado ✅ Agora me diga: está *sem internet total* ou só *lento/instável*?");
            return;
          }
          await safeSend(conversationId, "Não consegui localizar com esse CPF/CNPJ. Confere se está correto (somente números)?");
          return;
        }

        if (isYes(customerText)) {
          await saveState(conversationId, { gpt_state: "awaiting_cpf", gpt_intent: "suporte" });
          await safeSend(conversationId, "Perfeito! Me envie o *CPF ou CNPJ do titular* (somente números).");
          return;
        }
        if (isNo(customerText)) {
          await saveState(conversationId, { gpt_state: "sales_flow", gpt_intent: "vendas" });
          await safeSend(conversationId, "Sem problemas! Me diga seu *bairro/cidade* e se prefere atendimento por *WhatsApp* ou *ligação*.");
          return;
        }
        await safeSend(conversationId, "Só para confirmar: você já é cliente? Responda *SIM* ou *NÃO*.");
        return;
      }

      // ----- 4) Financeiro: boleto / comprovante (sem menu) -----
      if (parsed.mentionsBoleto || nextIntent === "boleto") {
        await saveState(conversationId, { gpt_intent: "boleto", gpt_state: "boleto_flow" });

        if (!cpfcnpj) {
          await safeSend(conversationId, "Certo! Para eu enviar a 2ª via, me informe o *CPF ou CNPJ do titular* (somente números).");
          return;
        }

        const openBoleto = await rnGetOpenBoletoByCpf(cpfcnpj);
        if (!openBoleto) {
          await safeSend(conversationId, "Não encontrei boleto vencido no sistema agora. Você quer a 2ª via do boleto do mês atual ou está falando de um mês específico?");
          return;
        }

        await safeSend(conversationId, formatBoletoMessage(openBoleto));
        return;
      }

      if (parsed.mentionsProof || nextIntent === "comprovante") {
        await saveState(conversationId, { gpt_intent: "comprovante", gpt_state: "awaiting_proof_attachment" });
        await safeSend(conversationId, "Perfeito. Envie aqui o *comprovante* (imagem ou PDF). Se foi *PIX*, pode mandar o print também.");
        return;
      }

      // ----- 5) fallback GPT (só se caiu fora de tudo) -----
      const who = choosePersona(nextIntent);
      const reply = await oaiFallbackReply({
        apiKey: OPENAI_API_KEY,
        model: OPENAI_MODEL,
        personaName: who.name,
        personaRole: who.role,
        contextText: `INTENCAO:${nextIntent}\nSTATE:${state}\nCPF:${cpfcnpj || "n/a"}\nFONE:${waPhone || ca.whatsapp_phone || "n/a"}\nMSG:${customerText}`
      });
      await safeSend(conversationId, reply);
    } catch (e) {
      console.error("❌ Erro no webhook:", e?.message || e, e?.body || "");
    }
  });

  return app;
}
