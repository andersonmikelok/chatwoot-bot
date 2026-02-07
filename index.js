import express from "express";

const app = express();
app.use(express.json({ limit: "4mb" }));

/**
 * =========================
 * ENV (Render)
 * =========================
 * CHATWOOT_URL=https://chat.smsnet.com.br
 * CHATWOOT_ACCOUNT_ID=195
 * CW_UID=seuemail
 * CW_PASSWORD=suasenha
 *
 * OPENAI_API_KEY=sk-...
 * OPENAI_MODEL=gpt-5.2   (ou gpt-5-mini pra economizar)
 *
 * ReceitaNet:
 * RECEITANET_BASE_URL=https://sistema.receitanet.net/api/novo/chatbot
 * RECEITANET_CHATBOT_TOKEN=69750e44-9fae-426b-a569-1e40403cec68
 * RECEITANET_APP=chatbot
 *
 * Regras:
 * AUTO_GPT_THRESHOLD=3   (fuga do menu por N tentativas)
 * GPT_LABEL=gpt_on
 */

// DEBUG TEMP: imprimir payload quando tiver anexo
const hasAttachments =
  (Array.isArray(req.body?.attachments) && req.body.attachments.length > 0) ||
  (Array.isArray(req.body?.message?.attachments) && req.body.message.attachments.length > 0);

if (hasAttachments) {
  console.log("📎 WEBHOOK COM ANEXO (payload completo):");
  console.log(JSON.stringify(req.body, null, 2));
}
// DEBUG TEMP: imprimir payload quando tiver anexo

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;

const CW_UID = process.env.CW_UID || "";
const CW_PASSWORD = process.env.CW_PASSWORD || "";

let CW_ACCESS_TOKEN = process.env.CW_ACCESS_TOKEN || "";
let CW_CLIENT = process.env.CW_CLIENT || "";
let CW_TOKEN_TYPE = process.env.CW_TOKEN_TYPE || "Bearer";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

const RECEITANET_BASE_URL =
  (process.env.RECEITANET_BASE_URL || "https://sistema.receitanet.net/api/novo/chatbot").replace(
    /\/+$/,
    ""
  );
const RECEITANET_CHATBOT_TOKEN = process.env.RECEITANET_CHATBOT_TOKEN || "";
const RECEITANET_APP = process.env.RECEITANET_APP || "chatbot";

const AUTO_GPT_THRESHOLD = Number(process.env.AUTO_GPT_THRESHOLD || 3);
const GPT_LABEL = process.env.GPT_LABEL || "gpt_on";

function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!CW_UID) missing.push("CW_UID");
  if (!CW_PASSWORD) missing.push("CW_PASSWORD");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!RECEITANET_CHATBOT_TOKEN) missing.push("RECEITANET_CHATBOT_TOKEN");
  if (missing.length) {
    console.error("❌ Faltando ENV:", missing.join(" / "));
    return false;
  }
  return true;
}

/**
 * =========================
 * Estado por conversa (em memória)
 * =========================
 * OBS: ao reiniciar o serviço, zera (ok pra agora).
 */
const stateByConversation = new Map();
/**
 * Estrutura:
 * {
 *   gptMode: boolean,
 *   escapeCount: number,
 *   introSent: boolean,
 *   stage: "idle" | "ask_is_client" | "awaiting_cpf" | "awaiting_proof",
 *   customer: { idCliente, razaoSocial, cpfCnpj, phone } | null,
 *   lastActionAt: number
 * }
 */

function getState(conversationId) {
  const now = Date.now();
  const cur = stateByConversation.get(conversationId);
  if (cur) {
    cur.lastActionAt = now;
    return cur;
  }
  const fresh = {
    gptMode: false,
    escapeCount: 0,
    introSent: false,
    stage: "idle",
    customer: null,
    lastActionAt: now,
    triedPhoneLookup: false
  };
  stateByConversation.set(conversationId, fresh);
  return fresh;
}

// limpeza simples de estados velhos (2h)
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [k, v] of stateByConversation.entries()) {
    if ((v.lastActionAt || 0) < cutoff) stateByConversation.delete(k);
  }
}, 10 * 60 * 1000);

/**
 * =========================
 * Chatwoot Auth (Devise token headers)
 * =========================
 */
async function chatwootSignIn() {
  const url = `${CHATWOOT_URL}/auth/sign_in`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: CW_UID, password: CW_PASSWORD })
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    throw {
      ok: false,
      status: res.status,
      url,
      body: json || text,
      message: "Falha no /auth/sign_in"
    };
  }

  const accessToken = res.headers.get("access-token") || "";
  const client = res.headers.get("client") || "";
  const tokenType = res.headers.get("token-type") || "Bearer";

  if (!accessToken || !client) throw new Error("Sign-in OK, mas sem access-token/client.");

  CW_ACCESS_TOKEN = accessToken;
  CW_CLIENT = client;
  CW_TOKEN_TYPE = tokenType;

  console.log("🔄 Tokens renovados via sign_in:", {
    uid: CW_UID,
    client: CW_CLIENT.slice(0, 6) + "…",
    access: CW_ACCESS_TOKEN.slice(0, 6) + "…"
  });
}

function buildChatwootHeaders() {
  return {
    "Content-Type": "application/json",
    "access-token": CW_ACCESS_TOKEN,
    client: CW_CLIENT,
    uid: CW_UID,
    "token-type": CW_TOKEN_TYPE || "Bearer"
  };
}

async function chatwootFetch(path, { method = "GET", body } = {}) {
  const url = `${CHATWOOT_URL}${path}`;

  const doRequest = async () => {
    const res = await fetch(url, {
      method,
      headers: buildChatwootHeaders(),
      body: body ? JSON.stringify(body) : undefined
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
    console.log("⚠️ 401 no Chatwoot. Renovando token...");
    await chatwootSignIn();
    ({ res, text, json } = await doRequest());
  }

  if (!res.ok) {
    throw {
      ok: false,
      status: res.status,
      url,
      body: json || text,
      message: `Chatwoot API ${res.status}`
    };
  }

  return json || { ok: true };
}

async function sendMessageToConversation(conversationId, content) {
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    {
      method: "POST",
      body: { content, message_type: "outgoing" }
    }
  );
}

// Labels (Chatwoot v1)
async function getConversationLabels(conversationId) {
  const data = await chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`
  );
  const labels = data?.labels || data?.conversation?.labels || [];
  return Array.isArray(labels) ? labels : [];
}

async function addConversationLabel(conversationId, label) {
  // endpoint comum: POST labels
  // se sua instância usar outro, me manda o erro que ajusto.
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/labels`,
    { method: "POST", body: { labels: [label] } }
  );
}

/**
 * =========================
 * ReceitaNet helpers
 * =========================
 * Doc indica POST com params token/app e outros (como phone/cpfcnpj).
 * Vamos enviar como application/x-www-form-urlencoded (URLSearchParams),
 * que funciona bem com APIs que esperam form-data.
 */
function rnBody(params) {
  const body = new URLSearchParams();
  body.set("token", RECEITANET_CHATBOT_TOKEN);
  body.set("app", RECEITANET_APP);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && String(v).length) body.set(k, String(v));
  }
  return body;
}

async function receitanetPost(path, params) {
  const url = `${RECEITANET_BASE_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: rnBody(params)
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const err = { status: res.status, url, body: json };
    return { ok: false, ...err };
  }
  return { ok: true, data: json };
}

function onlyDigits(s) {
  return String(s || "").replace(/\D+/g, "");
}

function normalizeBRPhone(raw) {
  // Ex: (83)98770-7832 -> 83987707832
  return onlyDigits(raw);
}

/**
 * =========================
 * OpenAI reply (texto)
 * =========================
 */
async function openaiReply({ customerText, context, customer }) {
  const system = `
Você é a atendente virtual da i9NET (provedor de internet).
Responda em PT-BR, curto e objetivo. Sem mandar menu numérico.

Regras:
- Se pedir BOLETO/2ª via/FATURA: peça CPF/CNPJ (somente números) ou confirme se já identificamos o cliente.
- Se disser SEM INTERNET/LENTO: peça 3 passos (desligar ONU/roteador 2 min, ligar, testar cabo/wifi) e informe que vamos checar se há bloqueio por fatura.
- Se pedir atendente humano: confirme e diga que vai encaminhar.
- Faça no máximo 1 pergunta por vez.

Contexto:
${context}

Cliente (se identificado):
${customer ? JSON.stringify(customer) : "não identificado"}
`.trim();

  const input = [
    { role: "system", content: system },
    { role: "user", content: customerText }
  ];

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      max_output_tokens: 260
    })
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    console.error("OpenAI error:", res.status, json || text);
    return "Desculpe, tive uma instabilidade aqui. Pode repetir sua última mensagem?";
  }

  const out =
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    json?.choices?.[0]?.message?.content ||
    null;

  return (out || "Pode me explicar um pouco melhor o que você precisa?").trim();
}

/**
 * =========================
 * Regras de menu / fuga
 * Ajuste conforme seu menu do SMSNET.
 * =========================
 */
function isMenuOption(text) {
  const t = String(text || "").trim();
  // opções típicas: "1", "2", "3"
  return /^[1-9]$/.test(t);
}

function looksLikeGreeting(text) {
  const t = String(text || "").toLowerCase().trim();
  return ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite"].includes(t);
}

function isYes(text) {
  const t = String(text || "").toLowerCase().trim();
  return ["sim", "s", "claro", "sou", "já", "ja"].includes(t);
}

function isNo(text) {
  const t = String(text || "").toLowerCase().trim();
  return ["não", "nao", "n"].includes(t);
}

function looksLikeCPFOrCNPJ(text) {
  const d = onlyDigits(text);
  return d.length === 11 || d.length === 14;
}

/**
 * =========================
 * Core: fluxo ReceitaNet + GPT
 * =========================
 */
async function tryIdentifyCustomerByPhone(st, phoneDigits) {
  if (!phoneDigits) return { found: false };
  if (st.triedPhoneLookup) return { found: !!st.customer }; // evita loop

  st.triedPhoneLookup = true;

  const r = await receitanetPost("/clientes", { phone: phoneDigits });
  if (!r.ok) {
    // 404 = não localizado (normal)
    if (r.status === 404) return { found: false, notFound: true };
    console.log("ReceitaNet /clientes erro:", r.status, r.body);
    return { found: false, error: true };
  }

  // Quando encontra, API geralmente traz dados (depende da instalação)
  // Vamos tentar extrair campos comuns.
  const data = r.data || {};
  const idCliente = data?.idCliente ?? data?.id ?? data?.cliente?.idCliente;
  const razaoSocial = data?.razaoSocial ?? data?.nome ?? data?.cliente?.razaoSocial;
  const cpfCnpj = data?.cpfCnpj ?? data?.cpfcnpj ?? data?.cliente?.cpfCnpj;

  if (idCliente) {
    st.customer = { idCliente, razaoSocial: razaoSocial || "Cliente", cpfCnpj: cpfCnpj || "", phone: phoneDigits };
    return { found: true, customer: st.customer };
  }

  // Se o retorno for diferente, considera não encontrado
  return { found: false };
}

async function identifyCustomerByCpfCnpj(st, cpfcnpjDigits) {
  const r = await receitanetPost("/clientes", { cpfcnpj: cpfcnpjDigits });
  if (!r.ok) {
    if (r.status === 404) return { found: false, notFound: true };
    return { found: false, error: true };
  }

  const data = r.data || {};
  const idCliente = data?.idCliente ?? data?.id ?? data?.cliente?.idCliente;
  const razaoSocial = data?.razaoSocial ?? data?.nome ?? data?.cliente?.razaoSocial;
  const cpfCnpj = data?.cpfCnpj ?? data?.cpfcnpj ?? data?.cliente?.cpfCnpj ?? cpfcnpjDigits;

  if (idCliente) {
    st.customer = { idCliente, razaoSocial: razaoSocial || "Cliente", cpfCnpj, phone: st.customer?.phone || "" };
    return { found: true, customer: st.customer };
  }
  return { found: false };
}

async function listDebitsByCpf(cpfcnpjDigits) {
  // /debitos aceita cpfcnpj e status/page/data_inicio/data_fim (conforme doc) :contentReference[oaicite:6]{index=6}
  // Vamos pedir status=0/1/2? (depende do seu uso). Aqui: sem status.
  const r = await receitanetPost("/debitos", { cpfcnpj: cpfcnpjDigits, page: 1 });
  return r;
}

async function sendBoletoViaSmsOrEmail(idCliente, contato, tipo) {
  // /boletos: idCliente + contato + tipo(email|sms) :contentReference[oaicite:7]{index=7}
  return receitanetPost("/boletos", { idCliente, contato, tipo });
}

async function verificarAcesso(idCliente, contato) {
  // /verificar-acesso :contentReference[oaicite:8]{index=8}
  return receitanetPost("/verificar-acesso", { idCliente, contato });
}

async function notificacaoPagamento(idCliente, contato) {
  // /notificacao-pagamento :contentReference[oaicite:9]{index=9}
  return receitanetPost("/notificacao-pagamento", { idCliente, contato });
}

/**
 * =========================
 * Rotas
 * =========================
 */
app.get("/", (_req, res) => res.send("Bot online 🚀"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

app.post("/chatwoot-webhook", async (req, res) => {
  // ACK rápido
  res.status(200).send("ok");

  try {
    if (!assertEnv()) return;

    const event = req.body?.event;
    if (event !== "message_created") return;

    const messageType = req.body?.message_type;
    const isIncoming = messageType === "incoming" || messageType === 0 || messageType === "0";
    if (!isIncoming) {
      // evita loop de responder a outgoing
      return;
    }

    const conversationId = req.body?.conversation?.id;
    const customerText = String(req.body?.content || "").trim();
    if (!conversationId || !customerText) return;
    if (req.body?.private) return;

    console.log("📩 PROCESSANDO:", { conversaId: conversationId, customerText });

    const st = getState(conversationId);

    // ======= detectar telefone do contato (do payload) =======
    const contactPhoneRaw =
      req.body?.sender?.phone_number ||
      req.body?.sender?.phone ||
      req.body?.conversation?.meta?.sender?.phone_number ||
      req.body?.conversation?.meta?.sender?.phone ||
      "";
    const phoneDigits = normalizeBRPhone(contactPhoneRaw);

    // ======= modo GPT atual: via label no Chatwoot (fonte da verdade) =======
    const labels = await getConversationLabels(conversationId).catch(() => []);
    const hasGptLabel = labels.includes(GPT_LABEL);
    st.gptMode = !!hasGptLabel;

    // ======= comando manual (opcional) =======
    const lower = customerText.toLowerCase();
    if (lower === "#gpt on" || lower === "#gpt ligado") {
      await addConversationLabel(conversationId, GPT_LABEL);
      st.gptMode = true;
      st.introSent = false; // para mandar a intro UMA vez
      await sendMessageToConversation(conversationId, `✅ GPT ativado nesta conversa. (rótulo: ${GPT_LABEL})`);
      return;
    }
    if (lower === "#gpt off" || lower === "#gpt desligado") {
      // remover label varia por versão; por enquanto só avisa
      await sendMessageToConversation(conversationId, `ℹ️ Para desligar, remova o rótulo "${GPT_LABEL}" na conversa.`);
      return;
    }

    // ======= Fuga do menu (3 tentativas) =======
    if (!st.gptMode) {
      if (isMenuOption(customerText)) {
        st.escapeCount = 0;
      } else {
        st.escapeCount = (st.escapeCount || 0) + 1;
        console.log("🟡 fuga do menu:", { conversationId, nextCount: st.escapeCount });

        if (st.escapeCount >= AUTO_GPT_THRESHOLD) {
          console.log(`⚡ GPT autoativador (${AUTO_GPT_THRESHOLD} testes) -> ativando GPT`);
          await addConversationLabel(conversationId, GPT_LABEL);
          st.gptMode = true;
          st.introSent = false;
        } else {
          // ainda não ativou, deixa SMSNET seguir
          return;
        }
      }
    }

    // ======= GPT ON daqui pra frente =======
    if (st.gptMode) {
      // manda a intro UMA vez por conversa (e não toda mensagem)
      if (!st.introSent) {
        st.introSent = true;
        await sendMessageToConversation(conversationId, "✅ Entendi. Vou te atender por aqui sem precisar do menu.");
      }

      // 1) tentar identificar pelo telefone apenas 1 vez (evita loop)
      if (!st.customer) {
        const phoneTry = await tryIdentifyCustomerByPhone(st, phoneDigits);

        if (phoneTry.found) {
          await sendMessageToConversation(
            conversationId,
            `Olá, ${phoneTry.customer.razaoSocial}! 😊 Como posso ajudar? (Boleto, suporte técnico, planos...)`
          );
          st.stage = "idle";
          return;
        }

        if (phoneTry.notFound) {
          // Não fica repetindo isso a cada msg: entra em stage fixo
          st.stage = "ask_is_client";
          await sendMessageToConversation(conversationId, "Você já é cliente i9NET? (Responda: SIM ou NÃO)");
          return;
        }

        // erro diferente de 404
        await sendMessageToConversation(conversationId, "Tive dificuldade para consultar o cadastro agora. Você já é cliente? (SIM ou NÃO)");
        st.stage = "ask_is_client";
        return;
      }

      // 2) Se está perguntando se é cliente
      if (st.stage === "ask_is_client") {
        if (isYes(customerText)) {
          st.stage = "awaiting_cpf";
          await sendMessageToConversation(conversationId, "Perfeito. Me envie seu CPF/CNPJ (somente números), por favor.");
          return;
        }
        if (isNo(customerText)) {
          st.stage = "idle";
          // aqui você pode iniciar vendas (GPT) sem ReceitaNet
          const reply = await openaiReply({
            customerText: "Cliente NÃO é cliente. Iniciar abordagem de vendas e coletar endereço/bairro/plano desejado.",
            context: "Fluxo: Vendas",
            customer: st.customer
          });
          await sendMessageToConversation(conversationId, reply);
          return;
        }

        await sendMessageToConversation(conversationId, "Responda apenas: SIM ou NÃO 🙂");
        return;
      }

      // 3) Se aguardando CPF/CNPJ
      if (st.stage === "awaiting_cpf") {
        if (!looksLikeCPFOrCNPJ(customerText)) {
          await sendMessageToConversation(conversationId, "Me envie o CPF/CNPJ com 11 ou 14 dígitos (somente números), por favor.");
          return;
        }

        const cpfcnpj = onlyDigits(customerText);
        const found = await identifyCustomerByCpfCnpj(st, cpfcnpj);

        if (found.found) {
          await sendMessageToConversation(conversationId, `Certo, ${found.customer.razaoSocial}! ✅ Como posso ajudar?`);
          st.stage = "idle";
          return;
        }

        if (found.notFound) {
          await sendMessageToConversation(conversationId, "Não localizei esse CPF/CNPJ. Confere se está correto? (somente números)");
          return;
        }

        await sendMessageToConversation(conversationId, "Estou com instabilidade para consultar agora. Tenta novamente em instantes ou chame um atendente humano.");
        return;
      }

      // 4) Fluxo “boleto” / “sem internet”
      const textLower = customerText.toLowerCase();

      // Se cliente diz "sem internet" ou "bloqueado"
      if (textLower.includes("sem internet") || textLower.includes("bloque") || textLower.includes("sem sinal")) {
        // checa acesso (se API responder algo)
        const contato = st.customer?.phone || phoneDigits || "";
        const va = await verificarAcesso(st.customer.idCliente, contato);
        if (va.ok) {
          // resposta varia; aqui só ecoa msg
          await sendMessageToConversation(conversationId, `✅ Consulta feita: ${va.data?.msg || "verificado"}. Protocolo: ${va.data?.protocolo || "-"}`);
        } else {
          await sendMessageToConversation(conversationId, "Certo. Faça um teste rápido: desligue ONU/roteador por 2 min, ligue e teste no cabo. Enquanto isso, vou checar se existe bloqueio por fatura.");
        }
        // também checa débitos pelo cpfCnpj se tiver
        if (st.customer?.cpfCnpj) {
          const deb = await listDebitsByCpf(st.customer.cpfCnpj);
          if (deb.ok) {
            const arr = Array.isArray(deb.data) ? deb.data : [];
            const hasAny = arr.length > 0;
            if (hasAny) {
              await sendMessageToConversation(conversationId, "Vi que existem débitos em aberto. Quer que eu envie o boleto por aqui? (SIM ou NÃO)");
              st.stage = "idle";
              return;
            }
          }
        }
      }

      // Se pede boleto
      if (textLower.includes("boleto") || textLower.includes("fatura") || textLower.includes("2 via") || textLower.includes("segunda via")) {
        // Se não tem CPF/CNPJ ainda, pede
        if (!st.customer?.cpfCnpj) {
          st.stage = "awaiting_cpf";
          await sendMessageToConversation(conversationId, "Para localizar seu boleto, me envie seu CPF/CNPJ (somente números), por favor.");
          return;
        }

        // Lista débitos e manda link/pix
        const deb = await listDebitsByCpf(st.customer.cpfCnpj);

        if (!deb.ok) {
          await sendMessageToConversation(conversationId, "Não consegui consultar seus débitos agora. Quer que eu envie o boleto por SMS mesmo assim? (SIM ou NÃO)");
          return;
        }

        const list = Array.isArray(deb.data) ? deb.data : [];
        // tenta pegar o primeiro boleto disponível
        const first = list.find((x) => x?.boletos?.link || x?.boletos?.qrcode_pix || x?.boletos?.barras);

        if (!first) {
          await sendMessageToConversation(conversationId, "Não encontrei boleto pendente no sistema. Se você acha que deveria ter, posso abrir um chamado para o financeiro.");
          return;
        }

        const b = first.boletos || {};
        const parts = [];
        if (b.vencimento) parts.push(`Vencimento: ${b.vencimento}`);
        if (b.valor !== undefined) parts.push(`Valor: R$ ${b.valor}`);

        if (b.link) parts.push(`Link: ${b.link}`);
        if (b.qrcode_pix) parts.push(`PIX (QR/linha): ${b.qrcode_pix}`);
        if (b.barras) parts.push(`Código de barras: ${b.barras}`);

        await sendMessageToConversation(conversationId, `Aqui está seu boleto ✅\n${parts.join("\n")}`);

        await sendMessageToConversation(
          conversationId,
          "Se você já pagou, me envie o comprovante (print/foto) por gentileza. Se ainda vai pagar, quando finalizar me mande o comprovante para eu tentar liberar em confiança."
        );
        st.stage = "awaiting_proof";
        return;
      }

      // Se aguardando comprovante, mas chegou só texto, orienta
      if (st.stage === "awaiting_proof") {
        await sendMessageToConversation(
          conversationId,
          "Perfeito. Envie o comprovante como *foto/print* aqui na conversa, por favor. (Se for PDF, também serve — mas foto costuma ser mais rápido.)"
        );
        return;
      }

      // fallback geral GPT
      const context = `gpt_on=true; escapeCount=${st.escapeCount}; phone=${phoneDigits || ""}`;
      const reply = await openaiReply({ customerText, context, customer: st.customer });
      await sendMessageToConversation(conversationId, reply);
      return;
    }
  } catch (e) {
    console.error("❌ Erro no webhook:", e);
  }
});

const port = Number(process.env.PORT || 10000);
app.listen(port, () => console.log("🚀 Bot online na porta", port));

