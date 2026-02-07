import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || "";

const CW_UID = process.env.CW_UID || "";
const CW_PASSWORD = process.env.CW_PASSWORD || "";

let CW_ACCESS_TOKEN = process.env.CW_ACCESS_TOKEN || "";
let CW_CLIENT = process.env.CW_CLIENT || "";
let CW_TOKEN_TYPE = process.env.CW_TOKEN_TYPE || "Bearer";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

const RECEITANET_CHATBOT_TOKEN = process.env.RECEITANET_CHATBOT_TOKEN || "";
const RECEITANET_BASE_URL =
  (process.env.RECEITANET_BASE_URL || "https://sistema.receitanet.net/api/novo/chatbot").replace(/\/+$/, "");

const GPT_LABEL = process.env.GPT_LABEL || "gpt_on";
const MENU_FAIL_THRESHOLD = Number(process.env.MENU_FAIL_THRESHOLD || "3");

// ----------------------- Estado em memória -----------------------
const stateMap = new Map();
const STATE_TTL_MS = 30 * 60 * 1000;

function getState(conversationId) {
  const now = Date.now();
  for (const [k, v] of stateMap.entries()) {
    if (!v?.lastTouch || now - v.lastTouch > STATE_TTL_MS) stateMap.delete(k);
  }
  const key = String(conversationId);
  const cur = stateMap.get(key) || {
    failCount: 0,
    gptEnabled: false,
    gptIntroSent: false,
    stage: "INIT", // INIT | ASK_IS_CLIENT | ASK_CPF | READY
    client: null,
    lastTouch: now,
  };
  cur.lastTouch = now;
  stateMap.set(key, cur);
  return cur;
}

// dedupe webhook
const seenMsg = new Map();
const SEEN_TTL_MS = 2 * 60 * 1000;
function hasSeen(key) {
  const now = Date.now();
  for (const [k, t] of seenMsg.entries()) if (now - t > SEEN_TTL_MS) seenMsg.delete(k);
  return seenMsg.has(key);
}
function markSeen(key) {
  const now = Date.now();
  for (const [k, t] of seenMsg.entries()) if (now - t > SEEN_TTL_MS) seenMsg.delete(k);
  seenMsg.set(key, now);
}

// ----------------------- Util -----------------------
function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!RECEITANET_CHATBOT_TOKEN) missing.push("RECEITANET_CHATBOT_TOKEN");
  if (!CW_UID) missing.push("CW_UID");
  if (!CW_PASSWORD) missing.push("CW_PASSWORD");

  if (missing.length) {
    console.error("❌ Faltando ENV:", missing.join(" / "));
    return false;
  }
  return true;
}

function onlyDigits(s) {
  return String(s || "").replace(/\D+/g, "");
}

function normalizeBrPhone(input) {
  let d = onlyDigits(input).replace(/@.*$/, "");
  if (d.length >= 13 && d.startsWith("55")) d = d.slice(2);
  if (d.length >= 12 && d.startsWith("0")) d = d.replace(/^0+/, "");
  return d;
}

function isCpfCnpjDigits(d) {
  const s = onlyDigits(d);
  return s.length === 11 || s.length === 14;
}

function isMenuOption(text) {
  const t = String(text || "").trim();
  return /^[0-9]{1,2}$/.test(t);
}

function looksLikeOffMenu(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (isMenuOption(t)) return false;
  return true;
}

function extractPhoneFromWebhook(body) {
  const candidates = [
    body?.sender?.phone_number,
    body?.sender?.phoneNumber,
    body?.sender?.identifier,
    body?.conversation?.meta?.sender?.phone_number,
    body?.conversation?.meta?.sender?.identifier,
    body?.conversation?.contact_inbox?.source_id,
    body?.contact?.phone_number,
    body?.contact?.identifier,
  ].filter(Boolean);

  for (const c of candidates) {
    const n = normalizeBrPhone(c);
    if (n && n.length >= 10) return n;
  }
  return "";
}

function isYes(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["sim", "s", "claro", "sou", "ss"].includes(t);
}
function isNo(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["nao", "não", "n", "negativo"].includes(t);
}
function looksLikeBoleto(text) {
  const t = String(text || "").toLowerCase();
  return t.includes("boleto") || t.includes("fatura") || t.includes("2 via") || t.includes("2ª via");
}

// ----------------------- Chatwoot auth -----------------------
async function chatwootSignIn() {
  const url = `${CHATWOOT_URL}/auth/sign_in`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: CW_UID, password: CW_PASSWORD }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Falha no /auth/sign_in (${res.status}): ${text}`);

  const accessToken = res.headers.get("access-token") || "";
  const client = res.headers.get("client") || "";
  const tokenType = res.headers.get("token-type") || "Bearer";
  if (!accessToken || !client) throw new Error("Sign-in OK, mas não retornou access-token/client.");

  CW_ACCESS_TOKEN = accessToken;
  CW_CLIENT = client;
  CW_TOKEN_TYPE = tokenType;

  console.log("🔄 Tokens renovados via sign_in:", {
    uid: CW_UID,
    client: CW_CLIENT.slice(0, 6) + "…",
    access: CW_ACCESS_TOKEN.slice(0, 6) + "…",
  });
}

function buildChatwootHeaders() {
  return {
    "Content-Type": "application/json",
    "access-token": CW_ACCESS_TOKEN,
    client: CW_CLIENT,
    uid: CW_UID,
    "token-type": CW_TOKEN_TYPE || "Bearer",
  };
}

async function chatwootFetch(path, { method = "GET", body } = {}) {
  const url = `${CHATWOOT_URL}${path}`;

  const doRequest = async () => {
    const res = await fetch(url, {
      method,
      headers: buildChatwootHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { res, text, json };
  };

  let { res, text, json } = await doRequest();
  if (res.status === 401) {
    console.log("⚠️ 401 no Chatwoot. Tentando renovar tokens...");
    await chatwootSignIn();
    ({ res, text, json } = await doRequest());
  }
  if (!res.ok) throw new Error(`Chatwoot API ${res.status}: ${json ? JSON.stringify(json) : text}`);
  return json;
}

async function sendMessageToConversation(conversationId, content) {
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    { method: "POST", body: { content, message_type: "outgoing" } }
  );
}

async function getConversation(conversationId) {
  return chatwootFetch(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`);
}

async function addLabelToConversation(conversationId, label) {
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/labels`,
    { method: "POST", body: { labels: [label] } }
  );
}

// ----------------------- ReceitaNet (FORM-DATA igual Postman) -----------------------
async function receitaNetPostForm(path, formFields) {
  const url = `${RECEITANET_BASE_URL}${path}`;
  const fd = new FormData();

  // sempre
  fd.append("token", RECEITANET_CHATBOT_TOKEN);
  fd.append("app", "chatbot");

  // extras
  for (const [k, v] of Object.entries(formFields || {})) {
    if (v !== undefined && v !== null && String(v).length > 0) fd.append(k, String(v));
  }

  const res = await fetch(url, { method: "POST", body: fd });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) return { ok: false, status: res.status, body: json || text };
  return { ok: true, status: res.status, body: json };
}

async function receitaNetFindClientByPhone(phoneDigits) {
  return receitaNetPostForm("/clientes", { phone: phoneDigits });
}

async function receitaNetFindClientByCpfCnpj(cpfCnpjDigits) {
  return receitaNetPostForm("/clientes", { cpfcnpj: cpfCnpjDigits });
}

async function receitaNetSendBoletoSms(idCliente, contatoPhoneDigits) {
  // conforme docs: /boletos + idCliente + contato + tipo
  return receitaNetPostForm("/boletos", {
    idCliente: String(idCliente),
    contato: contatoPhoneDigits,
    tipo: "sms",
  });
}

// ----------------------- OpenAI -----------------------
async function openaiReply({ customerText, context, client }) {
  const system = `
Você é a atendente virtual da i9NET (provedor de internet).
Objetivo: entender mensagens livres e ajudar rápido.

Regras:
- Responda em PT-BR, curto e objetivo.
- Se o cliente pedir BOLETO / 2ª via / fatura:
  - se já temos idCliente: confirme e diga que vai enviar.
  - se não temos idCliente: peça CPF/CNPJ (somente números).
- Se reclamar de internet lenta/sem sinal: faça 3 passos (desligar ONU/roteador 2 min, ligar, testar cabo/wifi) e peça endereço/telefone.
- Se pedir "falar com atendente": confirme e diga que vai encaminhar.
- Não mande menu numérico.
`.trim();

  const clientCtx = client?.idCliente
    ? `Cliente identificado: ${client.razaoSocial || "Cliente"} (idCliente=${client.idCliente}).`
    : "Cliente ainda não identificado no ERP.";

  const input = [
    { role: "system", content: system },
    {
      role: "user",
      content: `Mensagem do cliente: "${customerText}"
${clientCtx}
Contexto: ${context}`,
    },
  ];

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, input, max_output_tokens: 220 }),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${json ? JSON.stringify(json) : text}`);

  const out =
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    json?.choices?.[0]?.message?.content ||
    null;

  return (out || "Certo! Pode me explicar um pouco melhor o que você precisa?").trim();
}

// ----------------------- Rotas -----------------------
app.get("/", (_req, res) => res.send("🚀 Bot online"));

app.post("/chatwoot-webhook", async (req, res) => {
  res.status(200).send("ok");

  try {
    if (!assertEnv()) return;

    const event = req.body?.event;
    if (event !== "message_created") return;

    const messageType = req.body?.message_type;
    const isIncoming = messageType === "incoming" || messageType === 0 || messageType === "0";

    console.log(`🔥 webhook: ${event} | tipo: ${isIncoming ? "incoming" : "outgoing"}`);

    if (!isIncoming) return;
    if (req.body?.private) return;

    const conversationId = req.body?.conversation?.id;
    const messageId = req.body?.id || req.body?.message?.id || "";
    const customerText = String(req.body?.content || "").trim();
    if (!conversationId || !customerText) return;

    const dedupeKey = `${conversationId}:${messageId}:${customerText}`;
    if (hasSeen(dedupeKey)) return;
    markSeen(dedupeKey);

    console.log("📩 PROCESSANDO:", { conversaId: conversationId, customerText });

    let convo = null;
    try {
      convo = await getConversation(conversationId);
    } catch {
      console.log("⚠️ Falha ao buscar conversa no Chatwoot (seguindo assim mesmo).");
    }

    const labels = convo?.labels || convo?.conversation?.labels || [];
    const hasGptLabel = Array.isArray(labels) && labels.includes(GPT_LABEL);

    const st = getState(conversationId);
    st.gptEnabled = st.gptEnabled || hasGptLabel;

    // GPT autoativador por 3 fugas do menu
    if (!st.gptEnabled) {
      if (looksLikeOffMenu(customerText)) {
        st.failCount = (st.failCount || 0) + 1;
        console.log("🟡 fuga do menu:", { conversationId, nextCount: st.failCount });
      } else {
        st.failCount = 0;
      }

      if (st.failCount >= MENU_FAIL_THRESHOLD) {
        console.log(`⚡ GPT autoativador (${MENU_FAIL_THRESHOLD} testes) -> ativando GPT`);
        st.gptEnabled = true;
        st.stage = "INIT";
        try {
          await addLabelToConversation(conversationId, GPT_LABEL);
          console.log("🏷️ Rótulo aplicado:", { conversationId, label: GPT_LABEL });
        } catch {
          console.log("⚠️ Não consegui aplicar rótulo (seguindo com estado em memória).");
        }

        // Mensagem de entrada só uma vez
        if (!st.gptIntroSent) {
          st.gptIntroSent = true;
          await sendMessageToConversation(conversationId, "✅ Entendi. Vou te atender por aqui sem precisar do menu.");
        }
      } else {
        return; // ainda não ativa
      }
    }

    // GPT ativo: fluxo ReceitaNet
    const phone = extractPhoneFromWebhook(req.body);
    const phoneNorm = normalizeBrPhone(phone);

    // INIT: tenta localizar por telefone UMA VEZ
    if (st.stage === "INIT" && !st.client) {
      if (phoneNorm) {
        const r = await receitaNetFindClientByPhone(phoneNorm);

        if (r.ok && r.body?.success) {
          const c = r.body?.contratos || {};
          st.client = {
            idCliente: c.idCliente,
            razaoSocial: c.razaoSocial,
            phone: phoneNorm,
          };
          st.stage = "READY";

          await sendMessageToConversation(
            conversationId,
            `Olá, ${st.client.razaoSocial || "tudo bem"}! ✅ Encontrei seu cadastro. Como posso ajudar?`
          );
          return;
        }

        if (!r.ok && r.status === 404) {
          console.log("ℹ️ ReceitaNet: telefone não localizado (404).");
          st.stage = "ASK_IS_CLIENT";
          await sendMessageToConversation(
            conversationId,
            "Não encontrei seu número no cadastro. Você já é cliente i9NET? (Responda: SIM ou NÃO)"
          );
          return;
        }

        console.log("⚠️ ReceitaNet erro:", r.status, r.body);
        st.stage = "ASK_IS_CLIENT";
        await sendMessageToConversation(
          conversationId,
          "Tive uma instabilidade ao consultar seu cadastro. Você já é cliente i9NET? (SIM ou NÃO)"
        );
        return;
      }

      st.stage = "ASK_IS_CLIENT";
      await sendMessageToConversation(conversationId, "Você já é cliente i9NET? (SIM ou NÃO)");
      return;
    }

    // ASK_IS_CLIENT
    if (st.stage === "ASK_IS_CLIENT") {
      if (isYes(customerText)) {
        st.stage = "ASK_CPF";
        await sendMessageToConversation(conversationId, "Perfeito ✅ Me envie seu CPF/CNPJ (somente números) para eu localizar seu cadastro.");
        return;
      }
      if (isNo(customerText)) {
        st.stage = "READY";
        await sendMessageToConversation(conversationId, "Certo! 😊 Você quer contratar um plano novo? Me diga seu bairro e rua (ou ponto de referência).");
        return;
      }
      await sendMessageToConversation(conversationId, "Só pra confirmar: você já é cliente i9NET? (SIM ou NÃO)");
      return;
    }

    // ASK_CPF
    if (st.stage === "ASK_CPF") {
      const cpf = onlyDigits(customerText);
      if (!isCpfCnpjDigits(cpf)) {
        await sendMessageToConversation(conversationId, "Me envie CPF (11 dígitos) ou CNPJ (14 dígitos), somente números.");
        return;
      }

      const r = await receitaNetFindClientByCpfCnpj(cpf);

      if (r.ok && r.body?.success) {
        const c = r.body?.contratos || {};
        st.client = {
          idCliente: c.idCliente,
          razaoSocial: c.razaoSocial,
          phone: phoneNorm,
          cpfCnpj: cpf,
        };
        st.stage = "READY";
        await sendMessageToConversation(conversationId, `✅ Cadastro localizado, ${st.client.razaoSocial || "cliente"}! Como posso ajudar?`);
        return;
      }

      if (!r.ok && r.status === 404) {
        await sendMessageToConversation(conversationId, "Não localizei esse CPF/CNPJ no sistema. Confere se está correto? (Somente números)");
        return;
      }

      console.log("⚠️ ReceitaNet erro CPF:", r.status, r.body);
      await sendMessageToConversation(conversationId, "Tive uma instabilidade para localizar seu CPF/CNPJ. Pode tentar novamente em instantes?");
      return;
    }

    // READY
    if (st.stage === "READY") {
      if (looksLikeBoleto(customerText)) {
        if (st.client?.idCliente) {
          const contato = phoneNorm || st.client.phone || "";
          if (!contato) {
            await sendMessageToConversation(conversationId, "Para enviar seu boleto, me confirme seu telefone com DDD (somente números).");
            return;
          }

          await sendMessageToConversation(conversationId, "Certo ✅ Vou enviar sua fatura agora.");

          const r = await receitaNetSendBoletoSms(st.client.idCliente, contato);
          if (r.ok && r.body?.success) {
            await sendMessageToConversation(
              conversationId,
              `✅ Boleto enviado! Protocolo: ${r.body?.protocolo || "gerado"}. Se não chegar em alguns minutos, me avise.`
            );
            return;
          }

          console.log("⚠️ ReceitaNet boleto erro:", r.status, r.body);
          await sendMessageToConversation(conversationId, "Não consegui enviar o boleto agora. Quer tentar por outro número ou prefere falar com atendente?");
          return;
        } else {
          st.stage = "ASK_CPF";
          await sendMessageToConversation(conversationId, "Para localizar seu boleto, me envie seu CPF/CNPJ (somente números), por favor.");
          return;
        }
      }

      const context = `inbox=${req.body?.inbox?.name || ""}; can_reply=${req.body?.conversation?.can_reply}`;
      const reply = await openaiReply({ customerText, context, client: st.client });
      await sendMessageToConversation(conversationId, reply);
      return;
    }
  } catch (e) {
    console.error("❌ Erro no webhook:", e?.message || e);
  }
});

const port = Number(process.env.PORT || 10000);
app.listen(port, () => console.log("🚀 Bot online na porta", port));
