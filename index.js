// index.js
import "dotenv/config";
import { createServer } from "./server.js";

const env = {
  // Chatwoot
  CHATWOOT_URL: (process.env.CHATWOOT_URL || "").replace(/\/+$/, ""),
  CHATWOOT_ACCOUNT_ID: process.env.CHATWOOT_ACCOUNT_ID,
  CW_UID: process.env.CW_UID,
  CW_PASSWORD: process.env.CW_PASSWORD,
  CW_ACCESS_TOKEN: process.env.CW_ACCESS_TOKEN || "",
  CW_CLIENT: process.env.CW_CLIENT || "",
  CW_TOKEN_TYPE: process.env.CW_TOKEN_TYPE || "Bearer",

  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-5.2",

  // ReceitaNet
  RECEITANET_BASE_URL: (process.env.RECEITANET_BASE_URL || "https://sistema.receitanet.net/api/novo/chatbot").replace(/\/+$/, ""),
  RECEITANET_CHATBOT_TOKEN: process.env.RECEITANET_CHATBOT_TOKEN || "",
  RECEITANET_APP: process.env.RECEITANET_APP || "chatbot"
};

// checagem mínima
const missing = [];
if (!env.CHATWOOT_URL) missing.push("CHATWOOT_URL");
if (!env.CHATWOOT_ACCOUNT_ID) missing.push("CHATWOOT_ACCOUNT_ID");
if (!env.CW_UID) missing.push("CW_UID");
if (!env.CW_PASSWORD) missing.push("CW_PASSWORD");
if (!env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
if (!env.RECEITANET_CHATBOT_TOKEN) missing.push("RECEITANET_CHATBOT_TOKEN");

if (missing.length) {
  console.error("❌ Faltando ENV:", missing.join(" / "));
}

const app = createServer(env);

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Bot online na porta", port));

