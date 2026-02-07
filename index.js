import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * =========================
 * ENV (Render)
 * =========================
 * CHATWOOT_URL=https://chat.smsnet.com.br
 * CHATWOOT_ACCOUNT_ID=195
 * CW_UID=seuemail
 * CW_PASSWORD=suasenha
 * (opcional) CW_ACCESS_TOKEN=...
 * (opcional) CW_CLIENT=...
 * (opcional) CW_TOKEN_TYPE=Bearer
 *
 * OPENAI_API_KEY=sk-...
 * OPENAI_MODEL=gpt-5.2 (ou gpt-5-mini)
 *
 * RECEITANET_CHATBOT_TOKEN=69750e44-9fae-426b-a569-1e40403cec68
 * RECEITANET_BASE_URL=https://sistema.receitanet.net/api/novo/chatbot
 *
 * =========================
 * Labels (Chatwoot)
 * =========================
 * GPT_LABEL_ON=gpt_on
 * GPT_LABEL_MODE=gpt_mode   (opcional, se quiser separar)
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
// Memória em runtime (rápida)
// (persistência real: label no Chatwoot)
// =========================
const conversationState = new Map();
/**
 * state = {
 *   escapeCount: number,
 *   gptOn: boolean,
 *   greeted: boolean,
 *   lastHandledMessageId: string|number|null,
 *   client: { idCliente, razaoSocial, cpfCnpj } | null,
 *   flow: "unknown"|"client"|"sales"
 * }
 */

function getState(conversationId) {
  if (!conversationState.has(conversationId)) {
    conversationState.set(conversationId, {
      escapeCount: 0,
      gptOn: false,
      greeted: false,
      lastHandledMessageId: null,
      client: null,
      flow: "unknown",
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
// Chatwoot Auth
// =========================
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
  try { json = text ? JSON.parse(text) : null; } catch {}

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
    try { json = text ? JSON.parse(text) : null; } catch {}
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
    {
      method: "POST",
      body: { content, message_type: "outgoing" },
    }
  );
}

// Labels: buscar e atualizar (persistência)
async function getConversation(conversationId) {
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`
  );
}

async function updateConversationLabels(conversationId, labels) {
  // Endpoint padrão do Chatwoot para labels:
  // POST /api/v1/accounts/:account_id/conversations/:conversation_id/labels
  // body: { labels: ["a","b"] }
  return chatwootFetch(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/labels`,
    {
      method: "POST",
      body: { labels },
    }
  );
}

// =========================
// ReceitaNet Client (ChatBot API)
// =========================
function rnUrl(path, params = {}) {
  const u = new URL(`${RECEITANET_BASE_URL}${path}`);
  u.searchParams.set("token", RECEITANET_TOKEN);
  u.searchParams.set("app", "chatbot");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).length > 0) {
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

async function receitanetPost(path, params = {}) {
  const url = rnUrl(path, params);
  const res = await fetch(url, { method: "POST" });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const err = { status: res.status, url, body: json || text };
    throw err;
  }
  return json;
}

function normalizePhone(phoneRaw) {
  if (!phoneRaw) return "";
  // mantém só dígitos
  let p = String(phoneRaw).replace(/\D+/g, "");
  // remove 55 se vier duplicado
  if (p.startsWith("55") && p.length > 11) {
    p = p.slice(2);
  }
  // retorna com DDD+numero (11 dígitos BR geralmente)
  return p;
}

// Tenta extrair telefone do payload do Chatwoot (varia por canal)
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
  // POST /clientes?phone=...
  return receitanetPost("/clientes", { phone });
}

async function rnLookupClientByCpfCnpj(cpfcnpj) {
  // POST /clientes?cpfcnpj=...
  return receitanetPost("/clientes", { cpfcnpj });
}

async function rnDebitosByCpfCnpj(cpfcnpj) {
  // POST /debitos?cpfcnpj=...&status=0
  // status: 0,1,2 (conforme doc)
  return receitanetPost("/debitos", { cpfcnpj, status: 0, page: 1 });
}

// =========================
// OpenAI
// =========================
async function openaiReply({ customerText, context }) {
  const system = `
Você é a atendente virtual da i9NET (provedor de internet).
Objetivo: entender mensagens livres e resolver rápido.

Regras:
- Responda em PT-BR, curto e objetivo.
- Nunca envie menu numérico.
- Se o cliente pedir BOLETO/2ª via/fatura: peça CPF/CNPJ se não tiver, ou envie os dados do boleto se já tiver.
- Se internet lenta/sem sinal: faça triagem simples e peça confirmação do procedimento.
- Se pedir humano: confirme e diga que vai encaminhar.
`.trim();

  const input = [
    { role: "system", content: system },
    {
      role: "user",
      content: `Mensagem: "${customerText}"\nContexto: ${context}`,
    },
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
    throw {
      ok: false,
      status: res.status,
      body: json || text,
      message: "OpenAI API error",
    };
  }

  const out =
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    json?.choices?.[0]?.message?.content ||
    null;

  return (out || "Certo! Pode me explicar um pouco melhor?").trim();
}

// =========================
// Menu / Fuga do menu (heurística)
// =========================
function isMenuAnswer(text) {
  const t = (text || "").trim();
  // respostas típicas do menu SMSNET: "1", "2", "3"
  return /^[1-3]$/.test(t);
}

function looksLikeEscape(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (isMenuAnswer(t)) return false;
  // se tem letra, ou frase maior que 1 char, é fuga
  if (/[a-zA-ZÀ-ÿ]/.test(t)) return true;
  if (t.length > 1) return true;
  return false;
}

// =========================
// Webhook
// =========================
app.get("/", (req, res) => res.send("Bot online 🚀"));

app.get("/test-chatwoot", async (req, res) => {
  try {
    if (!assertEnv()) return res.status(500).json({ ok: false, error: "Missing ENV" });
    const profile = await chatwootFetch("/api/v1/profile");
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(500).json(e);
  }
});

app.post("/chatwoot-webhook", async (req, res) => {
  // ACK rápido
  res.status(200).send("ok");

  try {
    if (!assertEnv()) return;

    const event = req.body?.event;
    if (event !== "message_created") return;

    const messageType = req.body?.message_type;
    const isIncoming =
      messageType === "incoming" || messageType === 0 || messageType === "0";

    // anti-loop
    if (!isIncoming) return;
    if (req.body?.private) return;

    const conversationId = req.body?.conversation?.id;
    const messageId = req.body?.id;
    const customerText = (req.body?.content || "").trim();

    if (!conversationId || !customerText) return;

    // Dedupe simples por messageId
    const state = getState(conversationId);
    if (state.lastHandledMessageId && String(state.lastHandledMessageId) === String(messageId)) {
      return;
    }
    state.lastHandledMessageId = messageId;

    console.log("🔥 webhook: message_created | tipo: incoming");
    console.log("📩 PROCESSANDO:", { conversaId: conversationId, customerText });

    // Carrega conversa do Chatwoot para ler labels atuais (persistência)
    let convo = null;
    try {
      convo = await getConversation(conversationId);
    } catch (e) {
      console.log("⚠️ Não consegui ler conversa no Chatwoot (seguindo mesmo assim).", e?.status || e);
    }

    const labels = convo?.labels || convo?.conversation?.labels || [];
    const hasGptLabel = Array.isArray(labels) && labels.includes(GPT_LABEL_ON);

    // Se já tiver label, GPT está ON
    if (hasGptLabel) {
      state.gptOn = true;
    }

    // =========================
    // 1) Se GPT ainda OFF: contar fuga do menu
    // =========================
    if (!state.gptOn) {
      if (looksLikeEscape(customerText)) {
        state.escapeCount = (state.escapeCount || 0) + 1;
        console.log("🟡 fuga do menu:", { conversationId, nextCount: state.escapeCount });

        if (state.escapeCount >= 3) {
          console.log("⚡ GPT autoativador (3 tentativas) -> ativando GPT");
          state.gptOn = true;

          // marca label no Chatwoot (persistente)
          try {
            const nextLabels = Array.from(new Set([...(labels || []), GPT_LABEL_ON]));
            await updateConversationLabels(conversationId, nextLabels);
            console.log("🏷️ Label aplicada:", { conversationId, label: GPT_LABEL_ON });
          } catch (e) {
            console.log("⚠️ Falha ao aplicar label (ok, fica em memória):", e?.status || e);
          }

          // IMPORTANTE: manda “assumi” apenas UMA vez por conversa
          if (!state.greeted) {
            await sendMessageToConversation(
              conversationId,
              "✅ Entendi. Vou te atender por aqui sem precisar do menu."
            );
            state.greeted = true;
          }
        } else {
          // ainda não ativou, não responda para não brigar com SMSNET
          return;
        }
      } else {
        // se cliente está respondendo o menu, zera fuga
        state.escapeCount = 0;
        return;
      }
    }

    // =========================
    // 2) GPT ON -> ReceitaNet: identificar cliente por telefone
    // =========================
    const phone = extractWhatsappPhone(req.body);
    let context = `inbox=${req.body?.inbox?.name || ""}; phone=${phone || "N/A"}`;

    // Se ainda não temos cliente no state, tenta buscar no ReceitaNet pelo telefone
    if (!state.client && phone) {
      try {
        const rn = await rnLookupClientByPhone(phone);
        // Resposta tipo ClienteResponse (idCliente, razaoSocial, cpfCnpj)
        if (rn?.idCliente) {
          state.client = {
            idCliente: rn.idCliente,
            razaoSocial: rn.razaoSocial,
            cpfCnpj: rn.cpfCnpj,
          };
          state.flow = "client";

          // Saúda só uma vez (não repetir toda mensagem)
          if (!state.greeted) {
            await sendMessageToConversation(
              conversationId,
              `Olá, ${rn.razaoSocial}! 👋 Como posso ajudar hoje?`
            );
            state.greeted = true;
          }
        }
      } catch (e) {
        if (e?.status === 404) {
          console.log("ℹ️ ReceitaNet: telefone não localizado (404).");
        } else {
          console.log("⚠️ ReceitaNet lookup phone falhou:", e?.status || e);
        }
      }
    }

    // Se não achou por telefone, decidir fluxo (cliente x vendas)
    if (!state.client) {
      // Se cliente pediu boleto sem estar identificado -> pedir CPF/CNPJ
      if (/boleto|fatura|2a via|segunda via|segunda-via/i.test(customerText)) {
        await sendMessageToConversation(
          conversationId,
          "Para eu localizar seu boleto, me envie seu CPF/CNPJ (somente números), por favor."
        );
        return;
      }

      // Se mandou CPF/CNPJ, tenta identificar
      const cpfCnpjDigits = customerText.replace(/\D+/g, "");
      if (cpfCnpjDigits.length === 11 || cpfCnpjDigits.length === 14) {
        try {
          const rn = await rnLookupClientByCpfCnpj(cpfCnpjDigits);
          if (rn?.idCliente) {
            state.client = {
              idCliente: rn.idCliente,
              razaoSocial: rn.razaoSocial,
              cpfCnpj: rn.cpfCnpj,
            };
            state.flow = "client";
            await sendMessageToConversation(
              conversationId,
              `Perfeito, ${rn.razaoSocial}! Encontrei seu cadastro. Como posso ajudar?`
            );
            return;
          }
        } catch (e) {
          if (e?.status === 404) {
            await sendMessageToConversation(
              conversationId,
              "Não encontrei esse CPF/CNPJ como cliente. Você já é cliente i9NET? (Responda: SIM ou NÃO)"
            );
            return;
          }
          console.log("⚠️ ReceitaNet lookup cpfcnpj falhou:", e?.status || e);
        }
      }

      // Pergunta padrão quando não identificado
      await sendMessageToConversation(
        conversationId,
        "Você já é cliente i9NET? (Responda: SIM ou NÃO)"
      );
      return;
    }

    // =========================
    // 3) Cliente identificado -> ações ReceitaNet (boleto etc.)
    // =========================
    if (/boleto|fatura|2a via|segunda via/i.test(customerText)) {
      const cpf = state.client.cpfCnpj;
      try {
        const debitos = await rnDebitosByCpfCnpj(cpf);

        // A doc mostra lista com boletos {vencimento, valor, link, qrcode_pix, barras}
        const first = Array.isArray(debitos) ? debitos[0] : null;
        const boleto = first?.boletos;

        if (!boleto) {
          await sendMessageToConversation(
            conversationId,
            "Não encontrei boletos em aberto no momento. Se quiser, me diga qual mês/competência você precisa."
          );
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
        console.log("⚠️ Erro ao buscar débitos:", e?.status || e);
        await sendMessageToConversation(
          conversationId,
          "Tive uma falha ao consultar seu boleto agora. Pode tentar novamente em 1 minuto?"
        );
        return;
      }
    }

    // =========================
    // 4) Se não caiu em ação -> responde com GPT (continua conversa)
    // =========================
    const reply = await openaiReply({ customerText, context });
    await sendMessageToConversation(conversationId, reply);
  } catch (e) {
    console.error("❌ Erro no webhook:", e);
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Bot online na porta", port));
