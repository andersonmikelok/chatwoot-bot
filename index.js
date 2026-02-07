import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * ENV (Render)
 * CHATWOOT_URL=https://chat.smsnet.com.br
 * CHATWOOT_ACCOUNT_ID=195
 *
 * Auth (Chatwoot - sign_in)
 * CW_UID=seuemail
 * CW_PASSWORD=suasenha
 * (opcional: pode deixar setado também)
 * CW_ACCESS_TOKEN=...
 * CW_CLIENT=...
 * CW_TOKEN_TYPE=Bearer
 *
 * OpenAI:
 * OPENAI_API_KEY=sk-...
 * OPENAI_MODEL=gpt-5.2   (ou gpt-5-mini etc.)
 *
 * ReceitaNet ChatBot API:
 * RECEITANET_BASE_URL=https://sistema.receitanet.net/api/novo/chatbot
 * RECEITANET_TOKEN=69750e44-9fae-426b-a569-1e40403cec68
 * RECEITANET_APP=chatbot   (opcional; default chatbot)
 */

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;

const CW_UID = process.env.CW_UID || "";
const CW_PASSWORD = process.env.CW_PASSWORD || "";

let CW_ACCESS_TOKEN = process.env.CW_ACCESS_TOKEN || "";
let CW_CLIENT = process.env.CW_CLIENT || "";
let CW_TOKEN_TYPE = process.env.CW_TOKEN_TYPE || "Bearer";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

const RECEITANET_BASE_URL = (process.env.RECEITANET_BASE_URL || "https://sistema.receitanet.net/api/novo/chatbot").replace(/\/+$/, "");
const RECEITANET_TOKEN = process.env.RECEITANET_TOKEN || "";
const RECEITANET_APP = process.env.RECEITANET_APP || "chatbot";

const GPT_LABEL = "gpt_on";
const ESCAPE_LIMIT = 3;

// ----------------------- Estado em memória (por conversa) -----------------------
/**
 * stateByConversation:
 * {
 *   gptEnabled: boolean,
 *   activatedMsgSent: boolean,
 *   escapeCount: number,
 *   stage: "idle"|"ask_is_client"|"ask_cpf"|"sales",
 *   receitanet: { found:boolean, idCliente?:number, nome?:string, cpfcnpj?:string, phone?:string },
 *   lastIncomingHash?:string,
 * }
 */
const stateByConversation = new Map();

function getState(conversationId) {
  if (!stateByConversation.has(conversationId)) {
    stateByConversation.set(conversationId, {
      gptEnabled: false,
      activatedMsgSent: false,
      escapeCount: 0,
      stage: "idle",
      receitanet: { found: false },
      lastIncomingHash: "",
    });
  }
  return stateByConversation.get(conversationId);
}

function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!RECEITANET_TOKEN) missing.push("RECEITANET_TOKEN");

  if (!CW_ACCESS_TOKEN || !CW_CLIENT) {
    if (!CW_UID) missing.push("CW_UID (ou CW_ACCESS_TOKEN/CW_CLIENT)");
    if (!CW_PASSWORD) missing.push("CW_PASSWORD (ou CW_ACCESS_TOKEN/CW_CLIENT)");
  }

  if (missing.length) {
    console.error("Faltando ENV:", missing.join(" / "));
    return false;
  }
  return true;
}

// ----------------------- Util -----------------------
function normalizeDigits(s = "") {
  return String(s).replace(/\D+/g, "");
}

function last11Digits(s = "") {
  const d = normalizeDigits(s);
  return d.length > 11 ? d.slice(-11) : d;
}

function isMenuDigit(text = "") {
  const t = String(text).trim();
  return /^[0-9]{1,2}$/.test(t); // "1", "2", "10" etc.
}

// tenta extrair telefone do payload (varia por instalação)
function extractPhoneFromWebhook(payload) {
  const candidates = [
    payload?.sender?.phone_number,
    payload?.sender?.phone,
    payload?.contact?.phone_number,
    payload?.contact?.phone,
    payload?.conversation?.meta?.sender?.phone_number,
    payload?.conversation?.meta?.sender?.phone,
    payload?.conversation?.contact_inbox?.source_id, // às vezes vem aqui
  ];
  for (const c of candidates) {
    const d = normalizeDigits(c || "");
    if (d.length >= 10) return d;
  }
  return "";
}

// dedupe simples para evitar resposta duplicada por retry
function hashIncoming(conversationId, messageId, content) {
  return `${conversationId}|${messageId || ""}|${String(content || "").trim()}`;
}

// ----------------------- Chatwoot auth -----------------------
async function chatwootSignIn() {
  if (!CW_UID || !CW_PASSWORD) {
    throw new Error("Sem CW_UID/CW_PASSWORD para renovar tokens.");
  }

  const url = `${CHATWOOT_URL}/auth/sign_in`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: CW_UID, password: CW_PASSWORD }),
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
      message: "Falha no /auth/sign_in",
    };
  }

  const accessToken = res.headers.get("access-token") || "";
  const client = res.headers.get("client") || "";
  const tokenType = res.headers.get("token-type") || "Bearer";

  if (!accessToken || !client) {
    throw new Error("Sign-in OK, mas não retornou access-token/client.");
  }

  CW_ACCESS_TOKEN = accessToken;
  CW_CLIENT = client;
  CW_TOKEN_TYPE = tokenType;

  console.log("🔄 Tokens renovados via sign_in:", {
    uid: CW_UID,
    client: CW_CLIENT.slice(0, 6) + "…",
    access: CW_ACCESS_TOKEN.slice(0, 6) + "…",
  });

  return true;
}

function buildChatwootHeaders() {
  return {
    "Content-Type": "application/json",
    "access-token": CW_ACCESS_TOKEN,
    client: CW_CLIENT,
    uid: CW_UID || "",
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

  if (!res.ok) {
    throw {
      ok: false,
      status: res.status,
      url,
      body: json || text,
      message: `Chatwoot API ${res.status}`,
    };
  }

  return json || { ok: true };
}

async function sendMessageToConversation(conversationId, content) {
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    { method: "POST", body: { content, message_type: "outgoing" } }
  );
}

// tenta setar label (se não existir no SMSNET/Chatwoot, ignora)
async function setConversationLabels(conversationId, labels = []) {
  try {
    // em muitas instalações funciona assim:
    // POST /conversations/:id/labels { labels: ["gpt_on"] }
    await chatwootFetch(
      `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/labels`,
      { method: "POST", body: { labels } }
    );
    return true;
  } catch (e) {
    console.log("⚠️ Não consegui setar labels (ignorando).", { conversationId, labels });
    return false;
  }
}

// ----------------------- ReceitaNet API -----------------------
function rnUrl(path, query = {}) {
  const u = new URL(`${RECEITANET_BASE_URL}${path}`);
  u.searchParams.set("token", RECEITANET_TOKEN);
  u.searchParams.set("app", RECEITANET_APP);

  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function rnPost(path, query = {}) {
  const url = rnUrl(path, query);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}), // a API aceita, mesmo sem body
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    throw { ok: false, status: res.status, url, body: json || text, message: "ReceitaNet API error" };
  }
  return json;
}

// Busca cliente por telefone (WhatsApp)
async function rnBuscarClientePorTelefone(phoneDigits) {
  // tenta "completo" e tenta "últimos 11"
  const full = normalizeDigits(phoneDigits);
  const d11 = last11Digits(phoneDigits);

  // endpoint: POST /clientes?phone=...
  const tryPhones = [];
  if (full) tryPhones.push(full);
  if (d11 && d11 !== full) tryPhones.push(d11);

  for (const p of tryPhones) {
    const r = await rnPost("/clientes", { phone: p });
    // r deve ter campos de cliente. Se não achou, normalmente vem lista vazia ou status/msg
    // Vamos considerar "achou" se vier algum idCliente/id/cliente
    const found =
      r?.idCliente ||
      r?.cliente?.idCliente ||
      r?.clientes?.[0]?.idCliente ||
      r?.data?.[0]?.idCliente ||
      r?.id ||
      false;

    if (found) {
      const c =
        r?.cliente ||
        r?.clientes?.[0] ||
        r?.data?.[0] ||
        r;

      return {
        found: true,
        raw: r,
        idCliente: c?.idCliente ?? c?.id ?? r?.idCliente ?? r?.id,
        nome: c?.nome ?? c?.nomeCliente ?? c?.razao_social ?? c?.fantasia ?? "Cliente",
        cpfcnpj: c?.cpfcnpj ?? c?.cpf_cnpj ?? "",
        phone: p,
      };
    }
  }

  return { found: false };
}

// Busca cliente por CPF/CNPJ
async function rnBuscarClientePorCpfCnpj(cpfcnpj) {
  const doc = normalizeDigits(cpfcnpj);
  const r = await rnPost("/clientes", { cpfcnpj: doc });
  const found =
    r?.idCliente ||
    r?.cliente?.idCliente ||
    r?.clientes?.[0]?.idCliente ||
    r?.data?.[0]?.idCliente ||
    r?.id ||
    false;

  if (!found) return { found: false };

  const c =
    r?.cliente ||
    r?.clientes?.[0] ||
    r?.data?.[0] ||
    r;

  return {
    found: true,
    raw: r,
    idCliente: c?.idCliente ?? c?.id ?? r?.idCliente ?? r?.id,
    nome: c?.nome ?? c?.nomeCliente ?? c?.razao_social ?? c?.fantasia ?? "Cliente",
    cpfcnpj: c?.cpfcnpj ?? c?.cpf_cnpj ?? doc,
  };
}

// Lista débitos e pega boleto (link/barras/pix)
async function rnListarDebitosPorCpfCnpj(cpfcnpj) {
  const doc = normalizeDigits(cpfcnpj);
  // endpoint: POST /debitos?cpfcnpj=...&status=...
  // status: 0/1/2 (depende da doc). Vamos tentar sem status e depois com status=0
  let r = await rnPost("/debitos", { cpfcnpj: doc });
  if (!r) r = await rnPost("/debitos", { cpfcnpj: doc, status: 0 });

  // tentativa de achar lista
  const debitos = r?.debitos || r?.data || r?.itens || r?.items || [];
  // alguns retornos trazem boletos dentro de cada débito. Outros retornam direto.
  return { raw: r, debitos };
}

async function rnEnviarBoletoEmailSms({ idCliente, contato, tipo }) {
  // endpoint: POST /boletos?idCliente=...&contato=...&tipo=email|sms
  return rnPost("/boletos", { idCliente, contato, tipo });
}

// ----------------------- OpenAI -----------------------
async function openaiReply({ customerText, context, mode }) {
  const systemBase = `
Você é a atendente virtual da i9NET (provedor de internet).
Fale sempre em PT-BR, curto, objetivo e profissional.

Regras:
- NÃO envie menu numérico.
- Quando pedir dados (CPF/Endereço/Contrato), peça um de cada vez.
- Para BOLETO/2ª via: se já temos CPF/CNPJ, buscar e enviar link/código de barras/PIX.
- Para "internet lenta/sem sinal": faça triagem (ONT/ONU com LOS vermelho? reiniciou modem/roteador? cabo?) e proponha solução.
- Se cliente pedir "atendente humano": confirme e oriente que será encaminhado.

Contexto do sistema:
- Atendimento via WhatsApp (Chatwoot).
- Existe um robô de menu do SMSNET em paralelo, mas você deve manter conversa livre e clara.
`.trim();

  let system = systemBase;

  if (mode === "sales") {
    system += `

Você está no modo VENDAS:
- Faça 2 perguntas no máximo: bairro/cidade e se é casa ou empresa.
- Ofereça planos e destaque: suporte no bairro, instalação rápida, wi-fi 6 (se tiver), estabilidade.
- Se o cliente quiser contratar, peça nome + endereço + telefone e diga que um consultor finaliza.
`.trim();
  }

  const input = [
    { role: "system", content: system },
    { role: "user", content: `Mensagem do cliente: "${customerText}"\n\nContexto:\n${context}` },
  ];

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      max_output_tokens: 220,
    }),
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    throw { ok: false, status: res.status, body: json || text, message: "OpenAI API error" };
  }

  const out =
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    json?.choices?.[0]?.message?.content ||
    null;

  return (out || "Certo! Pode me explicar um pouco melhor o que você precisa?").trim();
}

// ----------------------- Regras de fluxo (cliente / não cliente) -----------------------
function looksLikeCpfCnpj(text = "") {
  const d = normalizeDigits(text);
  return d.length === 11 || d.length === 14;
}

function isAffirmative(text = "") {
  const t = String(text).trim().toLowerCase();
  return ["1", "sim", "sou cliente", "ja sou cliente", "já sou cliente", "cliente"].includes(t);
}
function isNegative(text = "") {
  const t = String(text).trim().toLowerCase();
  return ["2", "nao", "não", "nao sou", "não sou", "nao sou cliente", "não sou cliente", "quero contratar", "contratar"].includes(t);
}

// ativa GPT uma vez (mensagem + label), sem repetir sempre
async function activateGpt(conversationId, st, reason = "") {
  st.gptEnabled = true;
  st.escapeCount = 0;

  // tenta label (não é crítico)
  await setConversationLabels(conversationId, [GPT_LABEL]);

  // manda UMA vez a mensagem de transição
  if (!st.activatedMsgSent) {
    st.activatedMsgSent = true;
    const msg = reason
      ? `✅ Entendi. Vou te atender por aqui sem precisar do menu. (${reason})`
      : `✅ Entendi. Vou te atender por aqui sem precisar do menu.`;
    await sendMessageToConversation(conversationId, msg);
  }
}

// ----------------------- Rotas -----------------------
app.get("/", (_req, res) => res.send("Bot online 🚀"));

app.get("/test-chatwoot", async (_req, res) => {
  try {
    if (!assertEnv()) return res.status(500).json({ ok: false, error: "Missing ENV" });
    const profile = await chatwootFetch("/api/v1/profile");
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(500).json(e);
  }
});

app.post("/chatwoot-webhook", async (req, res) => {
  // ACK rápido para evitar retry do Chatwoot
  res.status(200).send("ok");

  try {
    if (!assertEnv()) return;

    const event = req.body?.event;
    const messageType = req.body?.message_type; // "incoming"/"outgoing" ou 0/1
    const isIncoming = messageType === "incoming" || messageType === 0 || messageType === "0";

    console.log("🔥 webhook:", event, "| tipo:", isIncoming ? "incoming" : "outgoing");

    if (event !== "message_created") return;

    // Anti-loop: ignora outgoing
    if (!isIncoming) return;

    const conversationId = req.body?.conversation?.id;
    const customerText = (req.body?.content || "").trim();
    const messageId = req.body?.id;

    if (!conversationId || !customerText) return;
    if (req.body?.private) return;

    const st = getState(conversationId);

    // dedupe por webhook retry
    const incomingKey = hashIncoming(conversationId, messageId, customerText);
    if (st.lastIncomingHash === incomingKey) {
      console.log("♻️ Dedupe: ignorando repetição.");
      return;
    }
    st.lastIncomingHash = incomingKey;

    console.log("📩 PROCESSANDO:", { conversaId: conversationId, customerText });

    // 1) Sempre tentar identificar telefone e buscar no ReceitaNet UMA vez por conversa (ou até achar)
    if (!st.receitanet.found && st.stage === "idle") {
      const phone = extractPhoneFromWebhook(req.body);
      if (phone) {
        try {
          const rn = await rnBuscarClientePorTelefone(phone);
          if (rn.found) {
            st.receitanet = { found: true, idCliente: rn.idCliente, nome: rn.nome, cpfcnpj: rn.cpfcnpj, phone: rn.phone };
            st.stage = "idle";

            // Ativa GPT imediatamente para cliente já identificado
            await activateGpt(conversationId, st, "cliente identificado");

            await sendMessageToConversation(
              conversationId,
              `Olá, ${st.receitanet.nome}! Encontrei seu cadastro. 😊\nComo posso te ajudar hoje? (ex.: boleto, suporte, internet lenta)`
            );
          } else {
            // não achou no telefone: perguntar se já é cliente (fluxo determinístico)
            st.stage = "ask_is_client";
            await sendMessageToConversation(
              conversationId,
              `Olá! Eu sou a Isa, atendente virtual da i9NET.\nNão localizei seu número no cadastro.\n\nVocê já é cliente?\n1) Sim\n2) Não`
            );
            return; // não chama GPT ainda
          }
        } catch (e) {
          console.log("⚠️ ReceitaNet lookup phone falhou (seguindo fluxo):", e?.status || e?.message || e);
          st.stage = "ask_is_client";
          await sendMessageToConversation(
            conversationId,
            `Olá! Eu sou a Isa, atendente virtual da i9NET.\nVocê já é cliente?\n1) Sim\n2) Não`
          );
          return;
        }
      } else {
        // sem telefone no payload: cai no fluxo de pergunta
        st.stage = "ask_is_client";
        await sendMessageToConversation(
          conversationId,
          `Olá! Eu sou a Isa, atendente virtual da i9NET.\nVocê já é cliente?\n1) Sim\n2) Não`
        );
        return;
      }
    }

    // 2) Se estamos perguntando "já é cliente?"
    if (st.stage === "ask_is_client") {
      if (isAffirmative(customerText)) {
        st.stage = "ask_cpf";
        await sendMessageToConversation(conversationId, `Perfeito. Me informe seu CPF/CNPJ para eu localizar seu cadastro.`);
        return;
      }
      if (isNegative(customerText)) {
        st.stage = "sales";
        // Ativa GPT no modo vendas (sem depender de fuga do menu)
        await activateGpt(conversationId, st, "modo vendas");
        // deixa o GPT seguir daqui
      } else {
        await sendMessageToConversation(conversationId, `Responda com:\n1) Sim (já sou cliente)\n2) Não (quero contratar)`);
        return;
      }
    }

    // 3) Se estamos pedindo CPF/CNPJ
    if (st.stage === "ask_cpf") {
      if (!looksLikeCpfCnpj(customerText)) {
        await sendMessageToConversation(conversationId, `CPF/CNPJ inválido. Envie apenas os números (11 ou 14 dígitos).`);
        return;
      }

      const rn = await rnBuscarClientePorCpfCnpj(customerText);
      if (!rn.found) {
        await sendMessageToConversation(conversationId, `Não encontrei esse CPF/CNPJ no sistema. Confere os números?`);
        return;
      }

      st.receitanet = { found: true, idCliente: rn.idCliente, nome: rn.nome, cpfcnpj: rn.cpfcnpj };
      st.stage = "idle";

      await activateGpt(conversationId, st, "cliente confirmado");

      await sendMessageToConversation(
        conversationId,
        `Certo, ${st.receitanet.nome}! Cadastro localizado. 😊\nComo posso te ajudar? (ex.: boleto, suporte, internet lenta)`
      );
      return;
    }

    // 4) Autoativador por “fuga do menu” (somente se GPT ainda estiver OFF)
    if (!st.gptEnabled) {
      // conta “fuga” quando o cliente não digita opção numérica
      if (!isMenuDigit(customerText)) {
        st.escapeCount = (st.escapeCount || 0) + 1;
        console.log("🟡 fuga do menu:", { conversationId, nextCount: st.escapeCount });

        if (st.escapeCount >= ESCAPE_LIMIT) {
          console.log("⚡ GPT autoativador");
          await activateGpt(conversationId, st, `após ${ESCAPE_LIMIT} tentativas fora do menu`);
          // não retorna — deixa processar com GPT já ligado
        } else {
          // ainda não atingiu limite: não responde com GPT ainda
          return;
        }
      } else {
        // digitou menu: zera fuga
        st.escapeCount = 0;
        return;
      }
    }

    // 5) Se GPT está ON: atender normalmente.
    // Primeiro: se intenção for BOLETO e já temos CPF/CNPJ, buscar débitos e mandar.
    const low = customerText.toLowerCase();
    const wantsBoleto = /(boleto|2a\s*via|2ª\s*via|fatura|mensalidade|cobrança|pagamento)/i.test(customerText);

    if (wantsBoleto && st.receitanet?.found) {
      const cpfcnpj = st.receitanet.cpfcnpj;
      if (!cpfcnpj) {
        await sendMessageToConversation(conversationId, `Para eu enviar seu boleto, me informe seu CPF/CNPJ (somente números).`);
        return;
      }

      try {
        const deb = await rnListarDebitosPorCpfCnpj(cpfcnpj);

        // Vamos procurar o primeiro boleto com link/barras/pix em qualquer lugar do retorno
        const rawStr = JSON.stringify(deb.raw || {});
        // tentativas de achar array "boletos"
        let boletos = deb.raw?.boletos || [];
        if (!Array.isArray(boletos) || boletos.length === 0) {
          // procurar em debitos
          const debitos = deb.debitos || [];
          for (const d of debitos) {
            if (Array.isArray(d?.boletos) && d.boletos.length) {
              boletos = d.boletos;
              break;
            }
          }
        }

        const b0 = Array.isArray(boletos) ? boletos[0] : null;
        if (b0 && (b0.link || b0.barras || b0.qrcode_pix)) {
          const venc = b0.vencimento ? `Vencimento: ${b0.vencimento}\n` : "";
          const val = b0.valor ? `Valor: R$ ${b0.valor}\n` : "";
          const link = b0.link ? `Link do boleto: ${b0.link}\n` : "";
          const barras = b0.barras ? `Código de barras: ${b0.barras}\n` : "";
          const pix = b0.qrcode_pix ? `Pix (copia e cola): ${b0.qrcode_pix}\n` : "";

          await sendMessageToConversation(
            conversationId,
            `✅ Encontrei seu boleto.\n${venc}${val}${link}${barras}${pix}`.trim()
          );
          return;
        }

        // Se não achou nada estruturado, cai no GPT (com contexto)
        console.log("⚠️ Não encontrei boleto estruturado no retorno. raw size:", rawStr.length);
      } catch (e) {
        console.log("❌ erro ao buscar débitos:", e?.status || e?.message || e);
        // continua pro GPT responder pedindo CPF/canal etc.
      }
    }

    // 6) GPT (sales ou suporte)
    const mode = st.stage === "sales" ? "sales" : "support";
    const context = [
      `conversation_id=${conversationId}`,
      `gpt_enabled=${st.gptEnabled}`,
      `stage=${st.stage}`,
      st.receitanet?.found ? `cliente=${st.receitanet.nome}; idCliente=${st.receitanet.idCliente}; cpfcnpj=${st.receitanet.cpfcnpj || ""}` : `cliente_nao_identificado`,
      `inbox=${req.body?.inbox?.name || ""}`,
    ].join("\n");

    const reply = await openaiReply({ customerText, context, mode });

    await sendMessageToConversation(conversationId, reply);
  } catch (e) {
    console.error("❌ Erro no webhook:", e);
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Bot online na porta", port));
