import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * ENV (Render)
 *
 * Chatwoot:
 *  CHATWOOT_URL=https://chat.smsnet.com.br
 *  CHATWOOT_ACCOUNT_ID=195
 *
 *  (opção A - recomendado) CHATWOOT_API_TOKEN=xxxx  // token de API do Chatwoot (pessoal)
 *
 *  (opção B) CW_UID=anderson_mikel@hotmail.com
 *            CW_PASSWORD=xxxx
 *            (e opcionalmente, se você quiser fixar)
 *            CW_ACCESS_TOKEN=...
 *            CW_CLIENT=...
 *            CW_TOKEN_TYPE=Bearer
 *
 * OpenAI:
 *  OPENAI_API_KEY=sk-...
 *  OPENAI_MODEL=gpt-5-mini
 */

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || "";
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || "";

const CW_UID = process.env.CW_UID || "";
const CW_PASSWORD = process.env.CW_PASSWORD || "";

let CW_ACCESS_TOKEN = process.env.CW_ACCESS_TOKEN || "";
let CW_CLIENT = process.env.CW_CLIENT || "";
let CW_TOKEN_TYPE = process.env.CW_TOKEN_TYPE || "Bearer";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

function assertEnvBasics() {
  const missing = [];
  if (!CHATWOOT_URL) missing.push("CHATWOOT_URL");
  if (!CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");

  if (missing.length) {
    console.error("❌ Faltando ENV:", missing.join(" / "));
    return false;
  }
  return true;
}

function hasChatwootAuth() {
  // Preferência: API token; senão tokens de login; senão email/senha (para logar)
  if (CHATWOOT_API_TOKEN) return true;
  if (CW_ACCESS_TOKEN && CW_CLIENT && CW_UID) return true;
  if (CW_UID && CW_PASSWORD) return true;
  return false;
}

// ---------- Chatwoot auth: login via /auth/sign_in (se precisar) ----------
async function chatwootSignIn() {
  if (!CW_UID || !CW_PASSWORD) {
    throw new Error("CW_UID/CW_PASSWORD não configurados para login.");
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
      message: `Chatwoot sign_in ${res.status}`,
    };
  }

  // Headers retornam access-token, client, token-type, uid
  CW_ACCESS_TOKEN = res.headers.get("access-token") || CW_ACCESS_TOKEN;
  CW_CLIENT = res.headers.get("client") || CW_CLIENT;
  CW_TOKEN_TYPE = res.headers.get("token-type") || CW_TOKEN_TYPE;

  console.log("✅ Login Chatwoot OK. Tokens atualizados.", {
    uid: CW_UID,
    client: CW_CLIENT ? CW_CLIENT.slice(0, 6) + "…" : "",
    accessToken: CW_ACCESS_TOKEN ? CW_ACCESS_TOKEN.slice(0, 6) + "…" : "",
  });

  return json;
}

function buildChatwootHeaders() {
  // 1) API token (instalações usam api_access_token)
  if (CHATWOOT_API_TOKEN) {
    return {
      "Content-Type": "application/json",
      api_access_token: CHATWOOT_API_TOKEN,
      Authorization: `Bearer ${CHATWOOT_API_TOKEN}`,
    };
  }

  // 2) Header tokens do devise_token_auth
  if (CW_ACCESS_TOKEN && CW_CLIENT && CW_UID) {
    return {
      "Content-Type": "application/json",
      "access-token": CW_ACCESS_TOKEN,
      client: CW_CLIENT,
      uid: CW_UID,
      "token-type": CW_TOKEN_TYPE || "Bearer",
    };
  }

  return { "Content-Type": "application/json" };
}

async function chatwootFetch(path, { method = "GET", body } = {}) {
  const url = `${CHATWOOT_URL}${path}`;

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

// Se der 401, tenta login e repete 1x
async function chatwootFetchWithRetry(path, opts = {}) {
  try {
    return await chatwootFetch(path, opts);
  } catch (e) {
    if (e?.status === 401 && !CHATWOOT_API_TOKEN) {
      console.log("🔁 401 no Chatwoot. Tentando relogar e repetir…");
      await chatwootSignIn();
      return await chatwootFetch(path, opts);
    }
    throw e;
  }
}

async function sendMessageToConversation(conversationId, content) {
  return chatwootFetchWithRetry(
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    {
      method: "POST",
      body: { content, message_type: "outgoing" },
    }
  );
}

// ---------- OpenAI ----------
async function openaiReply({ userText, conversationId, contactName, phone }) {
  const system =
    "Você é a ISA, atendente virtual da i9NET (provedor de internet). " +
    "Responda em PT-BR, de forma objetiva e educada. " +
    "Quando a mensagem do cliente for vaga, faça 1 pergunta para destravar. " +
    "Se o cliente falar de: sem internet, lentidão, queda, boleto, mudança de endereço, planos, visita técnica, " +
    "oriente e peça dados mínimos (nome/CPF ou número do contrato), sem expor informações sensíveis. " +
    "Se parecer urgência (sem internet), priorize passos rápidos e confirmação de luzes do roteador/ONU.";

  const prompt =
    `Cliente: ${contactName || "N/D"} ${phone ? `(${phone})` : ""}\n` +
    `Conversa ID: ${conversationId}\n` +
    `Mensagem do cliente: ${userText}\n\n` +
    "Gere a resposta para enviar no WhatsApp via Chatwoot. " +
    "Não use markdown; use texto simples; pode usar emojis moderadamente.";

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: system,
      input: prompt,
      max_output_tokens: 250,
    }),
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
      body: json || text,
      message: `OpenAI ${res.status}`,
    };
  }

  // Responses API retorna o texto em output_text (helper) OU em output[].content[].text dependendo do SDK.
  // Aqui vamos extrair de forma robusta:
  const outputText =
    json?.output_text ||
    json?.output?.flatMap((o) => o?.content || [])
      ?.map((c) => c?.text)
      ?.filter(Boolean)
      ?.join("\n")
      ?.trim() ||
    "";

  return outputText || "Certo! Pode me dizer seu CPF ou número do contrato para eu localizar seu cadastro?";
}

// ---------- Rotas ----------
app.get("/", (req, res) => res.send("Bot online 🚀"));

app.get("/test-chatwoot", async (req, res) => {
  try {
    if (!assertEnvBasics()) return res.status(500).json({ ok: false, error: "Missing ENV" });
    if (!hasChatwootAuth()) return res.status(500).json({ ok: false, error: "Missing Chatwoot auth ENV" });

    // garante login se necessário
    if (!CHATWOOT_API_TOKEN && !(CW_ACCESS_TOKEN && CW_CLIENT && CW_UID) && (CW_UID && CW_PASSWORD)) {
      await chatwootSignIn();
    }

    const profile = await chatwootFetchWithRetry("/api/v1/profile");
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(500).json(e);
  }
});

app.post("/chatwoot-webhook", async (req, res) => {
  // Responde rápido pro Chatwoot não reenviar
  res.status(200).send("ok");

  try {
    if (!assertEnvBasics()) return;
    if (!hasChatwootAuth()) {
      console.error("❌ Sem credenciais de autenticação do Chatwoot (API token OU login tokens OU email/senha).");
      return;
    }

    const event = req.body?.event;
    if (event !== "message_created") return;

    // Normaliza message_type (varia por canal). No seu payload: "incoming"/"outgoing" (string).
    const messageType = req.body?.message_type;

    // Evita loop: ignora outgoing (mensagem do agente/bot)
    if (messageType === "outgoing" || messageType === 1) {
      console.log("🔁 Ignorando outgoing para evitar loop.");
      return;
    }

    // Ignora mensagens privadas
    if (req.body?.private) return;

    const conversationId = req.body?.conversation?.id;
    if (!conversationId) return;

    const userText = (req.body?.content || "").trim();
    if (!userText) return;

    // (opcional) se quiser ignorar “mensagens automáticas” do próprio Chatwoot:
    const senderType = req.body?.sender?.type || req.body?.sender_type; // pode variar
    if (senderType && String(senderType).toLowerCase() === "user") {
      console.log("🔁 Ignorando sender_type user.");
      return;
    }

    // Garantir tokens por login se necessário
    if (!CHATWOOT_API_TOKEN && !(CW_ACCESS_TOKEN && CW_CLIENT && CW_UID) && (CW_UID && CW_PASSWORD)) {
      await chatwootSignIn();
    }

    const contactName = req.body?.sender?.name || req.body?.sender?.additional_attributes?.name || "";
    const phone =
      req.body?.sender?.phone_number ||
      req.body?.sender?.additional_attributes?.whatsapp ||
      req.body?.sender?.additional_attributes?.numero_de_telefone ||
      "";

    const reply = await openaiReply({ userText, conversationId, contactName, phone });

    const sent = await sendMessageToConversation(conversationId, reply);

    console.log("✅ Resposta enviada", {
      conversationId,
      sentId: sent?.id,
    });
  } catch (e) {
    console.error("❌ Erro no webhook:", e);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Rodando na porta", port));
