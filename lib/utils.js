export function normalizeText(s) {
  return (s || "").trim();
}

export function normalizePhoneBR(raw) {
  return (raw || "").replace(/\D+/g, "");
}

export function isIncomingMessage(payload) {
  return payload?.message_type === "incoming" || payload?.tipo_de_mensagem === "recebida";
}

export function extractConversationId(payload) {
  return payload?.conversation?.id;
}

export function extractMessageText(payload) {
  return payload?.content || "";
}

export function extractAttachments(payload) {
  return payload?.attachments || [];
}

export function pickFirstAttachment(a) {
  return a?.[0];
}

export function mapNumericChoice(text) {
  if (text === "1") return 1;
  if (text === "2") return 2;
  if (text === "3") return 3;
  return null;
}

export function detectIntent(text, n) {
  if (n === 1) return "support";
  if (n === 2) return "finance";
  if (n === 3) return "sales";

  const t = text.toLowerCase();
  if (t.includes("suporte")) return "support";
  if (t.includes("financeiro")) return "finance";
  if (t.includes("plano")) return "sales";
  return "unknown";
}

export function shouldIgnoreDuplicateEvent() {
  return false;
}

export function buildPersonaHeader(agent) {
  if (agent === "anderson") {
    return "Você é o Anderson do suporte da i9NET. Seja direto e técnico.";
  }
  return "Você é a Isa da triagem da i9NET.";
}
