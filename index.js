import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * ENV (Render)
 * CHATWOOT_URL=https://chat.smsnet.com.br
 * CHATWOOT_ACCOUNT_ID=195
 * CW_UID=...
 * CW_PASSWORD=...
 * OPENAI_API_KEY=sk-...
 * OPENAI_MODEL=gpt-5.2 (ou gpt-5-mini)
 *
 * RECEITANET_CHATBOT_TOKEN=69750e44-9fae-426b-a569-1e40403cec68
 * RECEITANET_BASE_URL=https://sistema.receitanet.net/api/novo/chatbot
 *
 * GPT_LABEL_ON=gpt_on
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

const RECEITANET_TOKEN = process.env.RECEITANET_CHATBOT_TOKEN || "";
const RECEITANET_BASE_URL =
  (process.env.RECEITANET_BASE_URL || "https://sistema.receitanet.net/api/novo/chatbot").replace(/\/+$/, "");

const GPT_LABEL_ON = process.env.GPT_LABEL_ON || "gpt_on";

// =========================
// Estado em memória por conversa
// =========================
const conversationState = new Map();
/**
 * state = {
 *   escapeCount: number,
 *   gptOn: boolean,
 *   greeted: boolean,
 *   lastHandledMessageId: string|number|null,
 *
 *   phoneChecked: boolean,       // ✅ evita lookup repetido (loop)
 *   phoneNotFound: boolean,
 *
 *   awaiting: "none"|"is_client"|"cpfcnpj",   // ✅ controla perguntas
 *   askedIsClient: boolean,
 *   askedCpf: boolean,
 *
 *   client: { idCliente, razaoSocial, cpfCnpj } | null,
 * }
 */

function getState(conversationId) {
  if (!conversationState.has(conversationId)) {
    conversationState.set(conversationId, {
      escapeCount: 0,
      gptOn: false,
      greeted: false,
      lastHandledMessageId: null,

      phoneChecked: false,
      phoneNotFound: false,

      awaiting: "none",
      askedIsClient: false,
      askedCpf: false,

      client: null,
    });
  }
  return conversationState.get(conversationId);
}

function assertEnv() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!RECEITANET_TOKEN) missing.push("RECEITANET_CHATBOT_TOKEN");

  if (!CW_ACCESS_TOKEN || !CW_CLIENT) {
    if (!CW_UID) missing.push("CW_UID (ou CW_ACCESS_TOKEN/CW_CLIENT)");
    if (!CW_PASSWORD) missing.push("CW_PASSWORD (ou CW_ACCESS_TOKEN/CW_CLIENT)");
  }

  if (missing.length) {
    console.error("❌ Faltando ENV:", missing.join(" / "));
    return false;
  }
  return true;
}

// =========================
// Chatwoot auth + fetch
// =========================
async function chatwootSignIn() {
  const url = `${CHATWOOT_URL}/auth/sign_in`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: CW_UID, password: CW_PASSWORD }),
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    throw { status: res.status, url, body: json || text };
  }

  const accessToken = res.headers.get("access-token") || "";
  const client = res.headers.get("client") || "";
  const tokenType = res.headers.get("token-type") || "Bearer";

  if (!accessToken || !client) throw new Error("Sign-in ok, mas sem access-token/client.");

  CW_ACCESS_TOKEN = accessToken;
  CW_CLIENT = client;
  CW_TOKEN_TYPE = tokenType;
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
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { res, text, json };
  };

  let { res, text, json } = await doRequest();

  if (res.status === 401) {
    await chatwootSignIn();
    ({ res, text, json } = await doRequest());
  }

  if (!res.ok) throw { status: res.status, url, body: json || text };
  return json || { ok: true };
}

async function sendMessageToConversation(conversationId, content) {
  console.log("✅ enviado", { conversaId: conversationId, preview: String(content).slice(0, 90) });
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    { method: "POST", body: { content, message_type: "outgoing" } }
  );
}

async function getConversation(conversationId) {
  return chatwootFetch(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`);
}

async function updateConversationLabels(conversationId, labels) {
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/labels`,
    { method: "POST", body: { labels } }
  );
}

// =========================
// ReceitaNet
// =========================
function rnUrl(path, params = {}) {
  const u = new URL(`${RECEITANET_BASE_URL}${path}`);
  u.searchParams.set("token", RECEITANET_TOKEN);
  u.searchParams.set("app", "chatbot");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).length > 0) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function receitanetPost(path, params = {}) {
  const url = rnUrl(path, params);
  const res = await fetch(url, { method: "POST" });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) throw { status: res.status, url, body: json || text };
  return json;
}

function normalizePhone(phoneRaw) {
  if (!phoneRaw) return "";
  let p = String(phoneRaw).replace(/\D+/g, "");
  if (p.startsWith("55") && p.length > 11) p = p.slice(2);
  return p;
}

function extractWhatsappPhone(payload) {
  const candidates = [
    payload?.sender?.phone_number,
    payload?.sender?.phone,
    payload?.conversation?.meta?.sender?.phone_number,
    payload?.conversation?.meta?.sender?.phone,
    payload?.conversation?.contact_inbox?.contact?.phone_number,
    payload?.conversation?.contact_inbox?.contact?.phone,
    payload?.contact?.phone_number,
    payload?.contact?.phone,
  ];
  const found = candidates.find((x) => x && String(x).trim().length > 0);
  return normalizePhone(found || "");
}

async function rnLookupClientByPhone(phone) {
  return receitanetPost("/clientes", { phone });
}

async function rnLookupClientByCpfCnpj(cpfcnpj) {
  return receitanetPost("/clientes", { cpfcnpj });
}

async function rnDebitosByCpfCnpj(cpfcnpj) {
  return receitanetPost("/debitos", { cpfcnpj, status: 0, page: 1 });
}

// =========================
// OpenAI
// =========================
async function openaiReply({ customerText, context }) {
  const system = `
Você é a atendente virtual da i9NET (provedor de internet).
Regras:
- PT-BR, curto e objetivo.
- Não envie menu numérico.
- Se pedir boleto e não tiver CPF/CNPJ: solicite.
- Se pedir humano: confirme encaminhamento.
`.trim();

  const input = [
    { role: "system", content: system },
    { role: "user", content: `Mensagem: "${customerText}"\nContexto: ${context}` },
  ];

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, input, max_output_tokens: 220 }),
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) throw { status: res.status, body: json || text };

  const out =
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    json?.choices?.[0]?.message?.content ||
    null;

  return (out || "Certo! Pode me explicar um pouco melhor?").trim();
}

// =========================
// Heurística menu / fuga
// =========================
function isMenuAnswer(text) {
  const t = (text || "").trim();
  return /^[1-3]$/.test(t);
}
function looksLikeEscape(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (isMenuAnswer(t)) return false;
  if (/[a-zA-ZÀ-ÿ]/.test(t)) return true;
  if (t.length > 1) return true;
  return false;
}

function isYes(text) {
  const t = (text || "").trim().toLowerCase();
  return ["sim", "s", "sou", "sou sim", "claro", "isso"].includes(t);
}
function isNo(text) {
  const t = (text || "").trim().toLowerCase();
  return ["nao", "não", "n", "negativo", "ainda nao", "ainda não"].includes(t);
}

function extractCpfCnpjDigits(text) {
  const d = String(text || "").replace(/\D+/g, "");
  if (d.length === 11 || d.length === 14) return d;
  return "";
}

function askedBoleto(text) {
  return /boleto|fatura|2a via|segunda via|segunda-via/i.test(text || "");
}

// =========================
// Rotas
// =========================
app.get("/", (req, res) => res.send("Bot online 🚀"));

app.post("/chatwoot-webhook", async (req, res) => {
  res.status(200).send("ok");

  try {
    if (!assertEnv()) return;

    const event = req.body?.event;
    if (event !== "message_created") return;

    const messageType = req.body?.message_type;
    const isIncoming = messageType === "incoming" || messageType === 0 || messageType === "0";
    if (!isIncoming) return;
    if (req.body?.private) return;

    const conversationId = req.body?.conversation?.id;
    const messageId = req.body?.id;
    const customerText = (req.body?.content || "").trim();
    if (!conversationId || !customerText) return;

    const state = getState(conversationId);

    // dedupe por messageId
    if (state.lastHandledMessageId && String(state.lastHandledMessageId) === String(messageId)) return;
    state.lastHandledMessageId = messageId;

    console.log("🔥 webhook: message_created | tipo: incoming");
    console.log("📩 PROCESSANDO:", { conversaId: conversationId, customerText });

    // Conversa/labels
    let convo = null;
    let labels = [];
    try {
      convo = await getConversation(conversationId);
      labels = convo?.labels || convo?.conversation?.labels || [];
    } catch {}

    if (Array.isArray(labels) && labels.includes(GPT_LABEL_ON)) state.gptOn = true;

    // 1) Se GPT OFF: contar fuga (3x)
    if (!state.gptOn) {
      if (looksLikeEscape(customerText)) {
        state.escapeCount += 1;
        console.log("🟡 fuga do menu:", { conversationId, nextCount: state.escapeCount });

        if (state.escapeCount >= 3) {
          console.log("⚡ GPT autoativador (3 testes) -> ativando GPT");
          state.gptOn = true;

          try {
            const nextLabels = Array.from(new Set([...(labels || []), GPT_LABEL_ON]));
            await updateConversationLabels(conversationId, nextLabels);
            console.log("🏷️ Rótulo aplicado:", { conversationId, label: GPT_LABEL_ON });
          } catch {}

          // mensagem de “assumi” só 1 vez
          if (!state.greeted) {
            await sendMessageToConversation(conversationId, "✅ Entendi. Vou te atender por aqui sem precisar do menu.");
            state.greeted = true;
          }
        } else {
          // não responde antes de ativar (evita briga com SMSNET)
          return;
        }
      } else {
        state.escapeCount = 0;
        return;
      }
    }

    // =========================
    // A partir daqui: GPT ON
    // =========================
    const phone = extractWhatsappPhone(req.body);
    const context = `phone=${phone || "N/A"}; inbox=${req.body?.inbox?.name || ""}; awaiting=${state.awaiting}`;

    // 2) Lookup por telefone: FAZER SÓ UMA VEZ por conversa
    if (!state.client && phone && !state.phoneChecked) {
      state.phoneChecked = true;
      try {
        const rn = await rnLookupClientByPhone(phone);
        if (rn?.idCliente) {
          state.client = { idCliente: rn.idCliente, razaoSocial: rn.razaoSocial, cpfCnpj: rn.cpfCnpj };
          state.awaiting = "none";
          state.askedIsClient = false;
          state.askedCpf = false;

          if (!state.greeted) {
            await sendMessageToConversation(conversationId, `Olá, ${rn.razaoSocial}! 👋 Como posso ajudar?`);
            state.greeted = true;
            return;
          }
        }
      } catch (e) {
        if (e?.status === 404) {
          state.phoneNotFound = true;
          console.log("ℹ️ ReceitaNet: telefone não localizado (404).");
        } else {
          console.log("⚠️ ReceitaNet lookup phone falhou:", e?.status || e);
        }
      }
    }

    // 3) Se ainda não identificado (sem state.client), CONTROLAR PERGUNTAS (sem loop)
    if (!state.client) {
      // Se o cliente mandou o próprio telefone (ex: 7018...), isso não ajuda.
      // Não trate como CPF/CNPJ, apenas continue o fluxo.
      const digits = customerText.replace(/\D+/g, "");
      const looksLikePhone = digits.length >= 10 && digits.length <= 13;

      // Se estamos aguardando SIM/NÃO
      if (state.awaiting === "is_client") {
        if (isYes(customerText)) {
          state.awaiting = "cpfcnpj";
          if (!state.askedCpf) {
            await sendMessageToConversation(conversationId, "Perfeito. Me envie seu CPF/CNPJ (somente números) para eu localizar seu cadastro.");
            state.askedCpf = true;
          }
          return;
        }
        if (isNo(customerText)) {
          state.awaiting = "none";
          await sendMessageToConversation(
            conversationId,
            "Sem problemas 😊 Você quer contratar um plano novo? Se sim, me diga seu bairro e se prefere 2.4G/5G (Wi-Fi 6) e eu te passo as opções."
          );
          return;
        }
        // resposta inválida
        await sendMessageToConversation(conversationId, "Me responda apenas: SIM ou NÃO 🙂");
        return;
      }

      // Se estamos aguardando CPF/CNPJ
      if (state.awaiting === "cpfcnpj") {
        const cpf = extractCpfCnpjDigits(customerText);
        if (!cpf) {
          await sendMessageToConversation(conversationId, "Envie CPF/CNPJ com 11 ou 14 dígitos (somente números), por favor.");
          return;
        }

        try {
          const rn = await rnLookupClientByCpfCnpj(cpf);
          if (rn?.idCliente) {
            state.client = { idCliente: rn.idCliente, razaoSocial: rn.razaoSocial, cpfCnpj: rn.cpfCnpj };
            state.awaiting = "none";
            state.askedIsClient = false;
            state.askedCpf = false;
            await sendMessageToConversation(conversationId, `Encontrei seu cadastro, ${rn.razaoSocial}! ✅ O que você precisa?`);
            return;
          }
        } catch (e) {
          if (e?.status === 404) {
            state.awaiting = "is_client";
            if (!state.askedIsClient) {
              await sendMessageToConversation(conversationId, "Não encontrei esse CPF/CNPJ. Você já é cliente i9NET? (SIM ou NÃO)");
              state.askedIsClient = true;
            }
            return;
          }
          await sendMessageToConversation(conversationId, "Tive uma falha ao consultar agora. Pode tentar novamente em 1 minuto?");
          return;
        }
      }

      // Fluxo inicial quando não identificado:
      // Se pediu boleto -> pedir CPF/CNPJ e setar awaiting
      if (askedBoleto(customerText)) {
        state.awaiting = "cpfcnpj";
        if (!state.askedCpf) {
          await sendMessageToConversation(conversationId, "Para eu localizar seu boleto, me envie seu CPF/CNPJ (somente números), por favor.");
          state.askedCpf = true;
        }
        return;
      }

      // Se mandou um número que parece telefone, não ficar insistindo no lookup do telefone.
      // Pergunta se é cliente.
      if (looksLikePhone) {
        state.awaiting = "is_client";
        if (!state.askedIsClient) {
          await sendMessageToConversation(conversationId, "Você já é cliente i9NET? (SIM ou NÃO)");
          state.askedIsClient = true;
        }
        return;
      }

      // Pergunta padrão única (sem repetir)
      state.awaiting = "is_client";
      if (!state.askedIsClient) {
        await sendMessageToConversation(conversationId, "Você já é cliente i9NET? (SIM ou NÃO)");
        state.askedIsClient = true;
      }
      return;
    }

    // 4) Cliente identificado -> boleto via ReceitaNet
    if (askedBoleto(customerText)) {
      try {
        const cpf = state.client.cpfCnpj;
        const debitos = await rnDebitosByCpfCnpj(cpf);

        const first = Array.isArray(debitos) ? debitos[0] : null;
        const boleto = first?.boletos;

        if (!boleto) {
          await sendMessageToConversation(conversationId, "Não encontrei boletos em aberto no momento. Qual mês/competência você precisa?");
          return;
        }

        const msg =
          `Aqui está seu boleto em aberto:\n\n` +
          `📅 Vencimento: ${boleto.vencimento}\n` +
          `💰 Valor: R$ ${Number(boleto.valor || 0).toFixed(2)}\n\n` +
          `🔗 Link: ${boleto.link}\n\n` +
          `💳 PIX (copia e cola):\n${boleto.qrcode_pix}\n\n` +
          `🏷️ Código de barras:\n${boleto.barras}`;

        await sendMessageToConversation(conversationId, msg);
        return;
      } catch (e) {
        console.log("⚠️ erro debitos:", e?.status || e);
        await sendMessageToConversation(conversationId, "Tive uma falha ao consultar seu boleto agora. Pode tentar novamente em 1 minuto?");
        return;
      }
    }

    // 5) Qualquer outra coisa -> GPT
    const reply = await openaiReply({ customerText, context });
    await sendMessageToConversation(conversationId, reply);
  } catch (e) {
    console.error("❌ erro webhook:", e?.status || e);
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Bot online na porta", port));
