import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const CHATWOOT_URL = process.env.CHATWOOT_URL.replace(/\/+$/, "");
const ACCOUNT = process.env.CHATWOOT_ACCOUNT_ID;

const CW_UID = process.env.CW_UID;
const CW_PASSWORD = process.env.CW_PASSWORD;

let TOKEN = "";
let CLIENT = "";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ---------------- AUTH ----------------

async function login() {
  const r = await fetch(`${CHATWOOT_URL}/auth/sign_in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: CW_UID, password: CW_PASSWORD })
  });

  TOKEN = r.headers.get("access-token");
  CLIENT = r.headers.get("client");
}

function headers() {
  return {
    "Content-Type": "application/json",
    "access-token": TOKEN,
    client: CLIENT,
    uid: CW_UID
  };
}

async function cw(path, opt = {}) {
  let r = await fetch(`${CHATWOOT_URL}${path}`, {
    ...opt,
    headers: headers(),
    body: opt.body ? JSON.stringify(opt.body) : undefined
  });

  if (r.status === 401) {
    await login();
    r = await fetch(`${CHATWOOT_URL}${path}`, {
      ...opt,
      headers: headers(),
      body: opt.body ? JSON.stringify(opt.body) : undefined
    });
  }

  return r.json();
}

// ---------------- GPT MODE ----------------

async function setGPT(conversationId, enabled) {
  await cw(`/api/v1/accounts/${ACCOUNT}/conversations/${conversationId}`, {
    method: "PATCH",
    body: {
      custom_attributes: {
        gpt_mode: enabled
      }
    }
  });
}

async function getGPT(conversationId) {
  const c = await cw(`/api/v1/accounts/${ACCOUNT}/conversations/${conversationId}`);
  return c?.custom_attributes?.gpt_mode === true;
}

// ---------------- GPT ----------------

async function gpt(text) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      input: [
        { role: "system", content: "Atendente ISP profissional. Responda curto." },
        { role: "user", content: text }
      ]
    })
  });

  const j = await r.json();
  return j.output_text || "Pode explicar melhor?";
}

// ---------------- MSG ----------------

async function send(conversationId, text) {
  await cw(`/api/v1/accounts/${ACCOUNT}/conversations/${conversationId}/messages`, {
    method: "POST",
    body: {
      content: text,
      message_type: "outgoing"
    }
  });
}

// ---------------- WEBHOOK ----------------

app.post("/chatwoot-webhook", async (req, res) => {
  res.send("ok");

  const b = req.body;

  console.log("🔥 webhook:", b?.event);

  if (b?.event !== "message_created") return;
  if (b.message_type !== "incoming") return;

  const id = b.conversation.id;
  const text = (b.content || "").trim();

  console.log("📩", text);

  // comandos
  if (text === "#gpt on") {
    await setGPT(id, true);
    await send(id, "✅ GPT ativado");
    return;
  }

  if (text === "#gpt off") {
    await setGPT(id, false);
    await send(id, "🛑 GPT desativado");
    return;
  }

  // menu numérico = ignora
  if (/^\d+$/.test(text)) return;

  // auto ativar se fugir do menu
  let enabled = await getGPT(id);

  if (!enabled && text.length > 2) {
    await setGPT(id, true);
    enabled = true;
    console.log("⚡ GPT auto ativado");
  }

  if (!enabled) return;

  const reply = await gpt(text);
  await send(id, reply);
});

// ---------------- SERVER ----------------

app.listen(process.env.PORT || 10000, async () => {
  await login();
  console.log("🚀 Bot online");
});
