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

// ====== Timeouts (ms) ======
const TIMEOUT_CHATWOOT = 15000;
const TIMEOUT_RECEITANET = 20000;
const TIMEOUT_OPENAI = 30000;

// =========================
// Estado em memória por conversa
// =========================
const conversationState = new Map();

function getState(conversationId) {
  if (!conversationState.has(conversationId)) {
    conversationState.set(conversationId, {
      escapeCount: 0,
      gptOn: false,
      greeted: false,
      lastHandledMessageId: null,

      phoneChecked: false,
      phoneNotFound: false,

      awaiting: "none", // none | is_client | cpfcnpj
      askedIsClient: false,
      askedCpf: false,

      // evita repetir “Consultando...”
      cpfLookupInProgress: false,

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
// fetch com timeout
// =========================
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// =========================
// Chatwoot auth + fetch
// =========================
async function chatwootSignIn() {
  const url = `${CHATWOOT_URL}/auth/sign_in`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: CW_UID, password: CW_PASSWORD }),
    },
    TIMEOUT_CHATWOOT
  );

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) throw { status: res.status, url, body: json || text };

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
    const res = await fetchWithTimeout(
      url,
      {
        method,
        headers: buildChatwootHeaders(),
        body: body ? JSON.stringify(body) : undefined,
      },
      TIMEOUT_CHATWOOT
    );

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
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
  console.log("✅ enviado", { conversaId: conversationId, preview: String(content).slice(0, 120) });
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
// ReceitaNet (multipart/form-data no BODY)
// =========================
async function receitanetPost(path, fields = {}) {
  const url = `${RECEITANET_BASE_URL}${path}`;

  const fd = new FormData();
  fd.append("token", RECEITANET_TOKEN);
  fd.append("app", "chatbot");
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s) continue;
    fd.append(k, s);
  }

  const res = await fetchWithTimeout(url, { method: "POST", body: fd }, TIMEOUT_RECEITANET);

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) throw { status: res.status, url, body: json || text };
  return json;
}

function normalizePhone(phoneRaw) {
  if (!phoneRaw) return "";
  let p = String(phoneRaw).replace(/\D+/g, "");

  // remove 55 se vier junto
  if (p.startsWith("55") && p.length >= 12) p = p.slice(2);

  // se vier com 10 dígitos (sem 9), você pode ajustar aqui, mas por enquanto mantém
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

// =========================
// OpenAI
// =========================
async function openaiReply({ customerText, context }) {
  const system = `
Você é a atendente virtual da i9NET (provedor de internet).
Regras:
- PT-BR, curto e objetivo.
- Não envie menu numérico.
- Se pedir boleto e não tiver CPF/CNPJ: solicite CPF/CNPJ (somente números).
- Se pedir humano: confirme encaminhamento.
`.trim();

  const input = [
    { role: "system", content: system },
    { role: "user", content: `Mensagem: "${customerText}"\nContexto: ${context}` },
  ];

  const res = await fetchWithTimeout(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: OPENAI_MODEL, input, max_output_tokens: 220 }),
    },
    TIMEOUT_OPENAI
  );

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

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
  // qualquer texto livre conta como fuga
  return true;
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
  // ACK rápido
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

    // labels da conversa
    let labels = [];
    try {
      const convo = await getConversation(conversationId);
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

          if (!state.greeted) {
            await sendMessageToConversation(conversationId, "✅ Entendi. Vou te atender por aqui sem precisar do menu.");
            state.greeted = true;
          }
        } else {
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
    const context = `phone=${phone || "N/A"}; awaiting=${state.awaiting}`;

    // 2) Lookup por telefone: só 1x por conversa
    if (!state.client && phone && !state.phoneChecked) {
      state.phoneChecked = true;
      console.log("📞 ReceitaNet lookup por phone:", phone);
      try {
        const rn = await rnLookupClientByPhone(phone);
        if (rn?.idCliente) {
          state.client = rn;
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
        } else if (String(e?.name || "").includes("AbortError")) {
          console.log("⏱️ ReceitaNet timeout (phone).");
        } else {
          console.log("⚠️ ReceitaNet erro (phone):", e?.status || e);
        }
      }
    }

    // 3) Se não identificado: controlar perguntas (sem loop)
    if (!state.client) {
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
            "Sem problemas 😊 Você quer contratar um plano novo? Me diga seu bairro e se é casa ou apartamento que eu te passo as opções."
          );
          return;
        }
        await sendMessageToConversation(conversationId, "Me responda apenas: SIM ou NÃO 🙂");
        return;
      }

      if (state.awaiting === "cpfcnpj") {
        const cpf = extractCpfCnpjDigits(customerText);
        if (!cpf) {
          await sendMessageToConversation(conversationId, "Envie CPF/CNPJ com 11 ou 14 dígitos (somente números), por favor.");
          return;
        }

        // evita “perder” a conversa: avisa 1x que está consultando
        if (!state.cpfLookupInProgress) {
          state.cpfLookupInProgress = true;
          await sendMessageToConversation(conversationId, "🔎 Consultando seu cadastro… só um instante.");
        }

        try {
          console.log("🧾 ReceitaNet lookup por CPF/CNPJ:", cpf);
          const rn = await rnLookupClientByCpfCnpj(cpf);

          state.cpfLookupInProgress = false;

          if (rn?.idCliente) {
            state.client = rn;
            state.awaiting = "none";
            state.askedIsClient = false;
            state.askedCpf = false;

            await sendMessageToConversation(conversationId, `Encontrei seu cadastro, ${rn.razaoSocial}! ✅ O que você precisa?`);
            return;
          }

          // se vier success false sem 404, trata igual “não encontrado”
          state.awaiting = "is_client";
          if (!state.askedIsClient) {
            await sendMessageToConversation(conversationId, "Não encontrei esse CPF/CNPJ. Você já é cliente i9NET? (SIM ou NÃO)");
            state.askedIsClient = true;
          }
          return;
        } catch (e) {
          state.cpfLookupInProgress = false;

          if (e?.status === 404) {
            state.awaiting = "is_client";
            if (!state.askedIsClient) {
              await sendMessageToConversation(conversationId, "Não encontrei esse CPF/CNPJ. Você já é cliente i9NET? (SIM ou NÃO)");
              state.askedIsClient = true;
            }
            return;
          }

          if (String(e?.name || "").includes("AbortError")) {
            await sendMessageToConversation(
              conversationId,
              "⏱️ A consulta demorou mais que o normal. Pode me enviar o CPF/CNPJ novamente daqui a alguns segundos?"
            );
            return;
          }

          console.log("⚠️ ReceitaNet erro (cpfcnpj):", e?.status || e);
          await sendMessageToConversation(conversationId, "Tive uma falha ao consultar agora. Pode tentar novamente em 1 minuto?");
          return;
        }
      }

      if (askedBoleto(customerText)) {
        state.awaiting = "cpfcnpj";
        if (!state.askedCpf) {
          await sendMessageToConversation(conversationId, "Para eu localizar seu boleto, me envie seu CPF/CNPJ (somente números), por favor.");
          state.askedCpf = true;
        }
        return;
      }

      state.awaiting = "is_client";
      if (!state.askedIsClient) {
        await sendMessageToConversation(conversationId, "Você já é cliente i9NET? (SIM ou NÃO)");
        state.askedIsClient = true;
      }
      return;
    }

    // 4) Cliente identificado -> boleto (vamos evoluir depois para “enviar boleto” de verdade)
    if (askedBoleto(customerText)) {
      await sendMessageToConversation(
        conversationId,
        "Perfeito ✅ Para enviar o boleto automaticamente, agora vou integrar o endpoint de *Enviar Boletos* do ReceitaNet. Me diga: você quer o boleto *do mês atual*?"
      );
      return;
    }

    // 5) Qualquer outra coisa -> GPT
    try {
      const reply = await openaiReply({ customerText, context });
      await sendMessageToConversation(conversationId, reply);
    } catch (e) {
      if (String(e?.name || "").includes("AbortError")) {
        await sendMessageToConversation(conversationId, "⏱️ Demorei um pouco pra responder. Pode repetir sua última mensagem?");
        return;
      }
      console.log("⚠️ OpenAI erro:", e?.status || e);
      await sendMessageToConversation(conversationId, "Tive uma instabilidade aqui. Pode tentar novamente em 1 minuto?");
    }
  } catch (e) {
    console.error("❌ erro webhook:", e?.status || e);
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Bot online na porta", port));
