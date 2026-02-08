export function normalizeText(s) {
  return (s || "").toString().trim();
}

export function onlyDigits(s) {
  return (s || "").toString().replace(/\D+/g, "");
}

/**
 * Normaliza whatsapp para ReceitaNet:
 * - remove 55 se vier com país
 * - retorna 10~11 dígitos (DDD+numero)
 */
export function normalizePhoneBR(raw) {
  let d = onlyDigits(raw);
  if (!d) return "";
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  // mantém 10~11
  if (d.length < 10) return "";
  if (d.length > 11) d = d.slice(-11);
  return d;
}

/**
 * Detecta se é mensagem incoming no Chatwoot (varia por versão)
 */
export function isIncomingMessage(payload) {
  const event = payload?.event || payload?.evento;
  if (event !== "message_created" && event !== "mensagem_criada") return false;

  const mt = payload?.message_type ?? payload?.tipo_de_mensagem;
  // incoming normalmente "incoming" ou 0
  return mt === "incoming" || mt === 0 || mt === "0" || mt === "recebida";
}

export function extractConversationId(payload) {
  return payload?.conversation?.id || payload?.conversa?.id || null;
}

export function extractMessageText(payload) {
  // Chatwoot: content; algumas integrações mandam conteudo
  return payload?.content ?? payload?.conteudo ?? "";
}

export function extractAttachments(payload) {
  const a1 = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const a2 = Array.isArray(payload?.anexos) ? payload.anexos : [];
  const a3 = Array.isArray(payload?.message?.attachments) ? payload.message.attachments : [];
  const a4 = Array.isArray(payload?.mensagem?.anexos) ? payload.mensagem.anexos : [];
  return [...a1, ...a2, ...a3, ...a4].filter(Boolean);
}

export function pickFirstAttachment(attachments) {
  return attachments?.[0] || null;
}

/**
 * Evita loop de webhook duplicado:
 * usa message id + created_at quando existir
 */
const seen = new Map();
export function shouldIgnoreDuplicateEvent(payload, ttlMs = 8000) {
  const msgId =
    payload?.id ||
    payload?.message?.id ||
    payload?.mensagem?.id ||
    payload?.conversation?.messages?.[0]?.id ||
    null;
  const ts = payload?.created_at || payload?.timestamp || Date.now();
  const key = msgId ? String(msgId) : `${String(ts)}:${String(payload?.content || "")}`;

  const now = Date.now();
  const prev = seen.get(key);
  if (prev && now - prev < ttlMs) return true;

  seen.set(key, now);
  // limpeza simples
  for (const [k, v] of seen.entries()) {
    if (now - v > ttlMs * 3) seen.delete(k);
  }
  return false;
}

/**
 * Mapeia entrada numérica 1/2/3
 */
export function mapNumericChoice(text) {
  const t = normalizeText(text);
  if (t === "1") return 1;
  if (t === "2") return 2;
  if (t === "3") return 3;
  return null;
}

/**
 * Decide intenção (triagem)
 */
export function detectIntent(text, numericChoice = null) {
  if (numericChoice === 1) return "support";
  if (numericChoice === 2) return "finance";
  if (numericChoice === 3) return "sales";

  const t = normalizeText(text).toLowerCase();

  if (t.includes("sem internet") || t.includes("sem sinal") || t.includes("caiu") || t.includes("lento") || t.includes("lentid")) {
    return "support";
  }
  if (t.includes("boleto") || t.includes("2ª") || t.includes("2a") || t.includes("fatura") || t.includes("paguei") || t.includes("pagamento") || t.includes("comprov")) {
    return "finance";
  }
  if (t.includes("plano") || t.includes("contratar") || t.includes("assinar") || t.includes("valor")) {
    return "sales";
  }
  return "unknown";
}

/**
 * Persona por atendente (controla o GPT fallback)
 */
export function buildPersonaHeader(agent) {
  if (agent === "anderson") {
    return `
Você é o Anderson do suporte da i9NET.
- Seja objetivo, sem perguntar o óbvio.
- Faça uma pergunta por vez.
- Evite menu numérico, a menos que o usuário peça.
- Sempre confirme o que o cliente quer: sem internet vs lento vs instável.
`.trim();
  }
  if (agent === "cassia") {
    return `
Você é a Cassia do financeiro da i9NET.
- Seja direto e educado.
- Não repita perguntas já respondidas.
- Quando o cliente mencionar boleto/pagamento, peça CPF/CNPJ apenas se ainda não tiver.
`.trim();
  }
  return `
Você é a Isa (triagem) da i9NET.
- Direcione o cliente para suporte/financeiro/vendas.
- Não confunda o cliente nem repita perguntas.
`.trim();
}
