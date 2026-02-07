import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * ENV (Render)
 * CHATWOOT_URL=https://chat.smsnet.com.br
 * CHATWOOT_ACCOUNT_ID=195
 * CW_UID=...
 * CW_PASSWORD=...
 *
 * OPENAI_API_KEY=...
 * OPENAI_MODEL=gpt-4o-mini
 */

const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/+$/, "");
const ACCOUNT = process.env.CHATWOOT_ACCOUNT_ID;

const CW_UID = process.env.CW_UID;
const CW_PASSWORD = process.env.CW_PASSWORD;

let TOKEN = process.env.CW_ACCESS_TOKEN || "";
let CLIENT = process.env.CW_CLIENT || "";

const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// anti repetição por conversa (evita spam se webhook repetir)
const lastReplyByConversation = new Map(); // id -> { inHash, outText, ts }
const REPLY_TTL_MS = 60 * 1000;

// cooldown de autoativação (não ficar ativando toda msg)
const autoEnableCooldown = new Map(); // id -> ts
const AUTO_ENABLE_COOLDOWN_MS = 2 * 60 * 1000;

function now() {
  return Date.now();
}

function cleanupMaps() {
  const cutoff = now() - 10 * 60 * 1000;
  for (const [k, v] of lastReplyByConversation.entries()) {
    if (v?.ts < cutoff) lastReplyByConversation.delete(k);
  }
  for (const [k, v] of autoEnableCooldown.entries()) {
    if (v < cutoff) autoEnableCooldown.delete(k);
  }
}

function needEnv() {
  const miss = [];
  if (!CHATWOOT_URL) miss.push("CHATWOOT_URL");
  if (!ACCOUNT) miss.push("CHATWOOT_ACCOUNT_ID");
  if (!CW_UID) miss.push("CW_UID");
  if (!CW_PASSWORD) miss.push("CW_PASSWORD");
  if (!OPENAI_KEY) miss.push("OPENAI_API_KEY");
  if (miss.length) console.error("❌ ENV faltando:", miss.join(", "));
  return miss.length === 0;
}

// ---------------- AUTH (Chatwoot) ----------------
async function login() {
  const r = await fetch(`${CHATWOOT_URL}/auth/sign_in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: CW_UID, password: CW_PASSWORD }),
  });

  const access = r.headers.get("access-token");
  const client = r.headers.get("client");

  if (!r.ok || !access || !client) {
    const t = await r.text().catch(() => "");
    throw new Error(`Chatwoot login falhou (${r.status}): ${t}`);
  }

  TOKEN = access;
  CLIENT = client;
  console.log("🔑 Chatwoot token ok", { client: CLIENT.slice(0, 6) + "…" });
}

function headers() {
  return {
    "Content-Type": "application/json",
    "access-token": TOKEN,
    client: CLIENT,
    uid: CW_UID,
  };
}

async function cw(path, opt = {}) {
  const url = `${CHATWOOT_URL}${path}`;

  const doReq = async () => {
    const r = await fetch(url, {
      method: opt.method || "GET",
      headers: headers(),
      body: opt.body ? JSON.stringify(opt.body) : undefined,
    });
    const txt = await r.text().catch(() => "");
    let json = null;
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch {}
    return { r, txt, json };
  };

  let { r, txt, json } = await doReq();

  if (r.status === 401) {
    await login();
    ({ r, txt, json } = await doReq());
  }

  if (!r.ok) {
    throw new Error(`Chatwoot API erro (${r.status}) ${url}: ${JSON.stringify(json || txt)}`);
  }

  return json ?? { ok: true };
}

// ---------------- Conversation flags (custom_attributes) ----------------
async function setGPT(conversationId, enabled) {
  await cw(`/api/v1/accounts/${ACCOUNT}/conversations/${conversationId}`, {
    method: "PATCH",
    body: { custom_attributes: { gpt_mode: !!enabled } },
  });
}

async function getGPT(conversationId) {
  const c = await cw(`/api/v1/accounts/${ACCOUNT}/conversations/${conversationId}`);
  return c?.custom_attributes?.gpt_mode === true;
}

// ---------------- Sending message ----------------
async function send(conversationId, text) {
  await cw(`/api/v1/accounts/${ACCOUNT}/conversations/${conversationId}/messages`, {
    method: "POST",
    body: { content: text, message_type: "outgoing" },
  });
  console.log("✅ enviado", { conversationId, preview: String(text).slice(0, 60) });
}

// ---------------- Incoming detection ----------------
function isIncoming(messageType) {
  // Pode vir: "incoming", "recebida", 0, "0"
  return (
    messageType === "incoming" ||
    messageType === "recebida" ||
    messageType === 0 ||
    messageType === "0"
  );
}

function isMenuNumeric(text) {
  return /^\d{1,2}$/.test(text.trim());
}

function isCommand(text) {
  const lower = text.trim().toLowerCase();
  return lower === "#gpt on" || lower === "#gpt off";
}

function hashInput(s) {
  // hash simples pra dedupe
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return String(h);
}

// ---------------- OpenAI (robust parser) ----------------
function extractResponseText(j) {
  // 1) output_text (quando vem)
  if (typeof j?.output_text === "string" && j.output_text.trim()) return j.output_text.trim();

  // 2) output[].content[].text
  const out = j?.output;
  if (Array.isArray(out)) {
    const texts = [];
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === "string" && c.text.trim()) texts.push(c.text.trim());
          // alguns modelos retornam "output_text" dentro de content também
          if (typeof c?.output_text === "string" && c.output_text.trim()) texts.push(c.output_text.trim());
        }
      }
    }
    if (texts.length) return texts.join("\n").trim();
  }

  // 3) compat
  if (typeof j?.choices?.[0]?.message?.content === "string" && j.choices[0].message.content.trim()) {
    return j.choices[0].message.content.trim();
  }

  return "";
}

async function gptReply(customerText) {
  const system = `
Você é a atendente virtual da i9NET (provedor de internet).
Responda sempre em PT-BR, de forma objetiva.

Intenções:
- BOLETO / 2ª via / fatura: peça CPF/CNPJ ou nº do contrato e confirme o WhatsApp do titular.
- INTERNET SEM SINAL: peça para reiniciar ONU/roteador (desligar 2 min), verificar luzes (PON/LOS) e diga o que fazer se LOS vermelho.
- INTERNET LENTA: peça teste via cabo, reinício, e 1 pergunta (quantos dispositivos?).
- FALAR COM HUMANO: confirme e diga que vai encaminhar.
- Se for vago: faça 1 pergunta de triagem.

Nunca mande menu numérico.
`.trim();

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_output_tokens: 250,
      input: [
        { role: "system", content: system },
        { role: "user", content: customerText },
      ],
    }),
  });

  const raw = await r.text().catch(() => "");
  let j = null;
  try {
    j = raw ? JSON.parse(raw) : null;
  } catch {}

  if (!r.ok) {
    throw new Error(`OpenAI erro (${r.status}): ${JSON.stringify(j || raw)}`);
  }

  const text = extractResponseText(j);
  if (text) return text;

  // Se não conseguiu extrair, retorna fallback melhor
  return "Entendi. Você pode me informar seu CPF/CNPJ ou número do contrato para eu localizar seu cadastro?";
}

// ---------------- WEBHOOK ----------------
app.post("/chatwoot-webhook", async (req, res) => {
  res.status(200).send("ok");
  cleanupMaps();

  const b = req.body || {};

  console.log("🔥 webhook:", b?.event, "| type:", b?.message_type);

  try {
    if (!needEnv()) return;

    if (b?.event !== "message_created") return;
    if (!isIncoming(b?.message_type)) return;
    if (b?.private) return;

    const id = b?.conversation?.id;
    const text = (b?.content || "").trim();
    if (!id || !text) return;

    console.log("📩", { id, text });

    // comandos
    if (isCommand(text)) {
      const enabled = text.trim().toLowerCase().endsWith("on");
      await setGPT(id, enabled);
      await send(id, enabled ? "✅ GPT ativado para esta conversa." : "🛑 GPT desativado para esta conversa.");
      console.log("🟣 comando GPT", { id, enabled });
      return;
    }

    // não brigar com menu numérico
    if (isMenuNumeric(text)) {
      console.log("🔢 menu numérico -> ignorando", { id, text });
      return;
    }

    // autoativar quando fugir do menu (texto livre)
    let enabled = await getGPT(id);

    if (!enabled) {
      const lastAuto = autoEnableCooldown.get(id) || 0;
      const okCooldown = now() - lastAuto > AUTO_ENABLE_COOLDOWN_MS;

      if (okCooldown && text.length >= 3) {
        autoEnableCooldown.set(id, now());
        await setGPT(id, true);
        enabled = true;
        console.log("⚡ GPT autoativado", { id });
        // (opcional) comentar se não quiser essa frase
        await send(id, "✅ Entendi. Vou te atender por aqui sem precisar do menu.");
      }
    }

    if (!enabled) return;

    // dedupe: evita responder a mesma entrada repetida em curto tempo
    const inHash = hashInput(text);
    const last = lastReplyByConversation.get(id);
    if (last && last.inHash === inHash && now() - last.ts < REPLY_TTL_MS) {
      console.log("🧊 dedupe -> ignorando repetição", { id });
      return;
    }

    // responde com GPT
    let reply = "";
    try {
      reply = await gptReply(text);
    } catch (e) {
      console.error("❌ OpenAI falhou:", String(e?.message || e));
      reply =
        "Estou com instabilidade no atendimento automático agora. Me diga se é: boleto, internet sem sinal, internet lenta, ou falar com atendente.";
    }

    // evita mandar igual duas vezes
    if (last && last.outText === reply && now() - last.ts < REPLY_TTL_MS) {
      console.log("🧊 dedupe saída -> evitando repetir a mesma resposta", { id });
      return;
    }

    await send(id, reply);
    lastReplyByConversation.set(id, { inHash, outText: reply, ts: now() });
  } catch (e) {
    console.error("❌ erro geral webhook:", String(e?.message || e));
  }
});

// ---------------- SERVER ----------------
app.get("/", (_req, res) => res.send("Bot online 🚀"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

app.listen(process.env.PORT || 10000, async () => {
  if (!needEnv()) return;
  await login();
  console.log("🚀 Bot online");
});
