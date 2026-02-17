// lib/utils.js

export function normalizeText(s) {
  return (s || "").toString().replace(/\s+/g, " ").trim();
}

export function normalizePhoneBR(raw) {
  return (raw || "").toString().replace(/\D+/g, "");
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
  const t = normalizeText(text);
  if (t === "1") return 1;
  if (t === "2") return 2;
  if (t === "3") return 3;
  return null;
}

// Retorna: "support" | "finance" | "sales" | null
export function detectIntent(text, n) {
  if (n === 1) return "support";
  if (n === 2) return "finance";
  if (n === 3) return "sales";

  const t = normalizeText(text).toLowerCase();
  if (!t) return null;

  // SUPORTE
  const supportKw = [
    "sem internet",
    "sem net",
    "internet nao",
    "internet não",
    "nao funciona",
    "não funciona",
    "nao ta funcionando",
    "não ta funcionando",
    "nao está funcionando",
    "não está funcionando",
    "caiu",
    "caiu a internet",
    "sem conexao",
    "sem conexão",
    "sem sinal",
    "offline",
    "sem rede",
    "sem wifi",
    "sem wi-fi",
    "wifi caiu",
    "lento",
    "lenta",
    "lentidão",
    "lentidao",
    "travando",
    "oscilando",
    "instavel",
    "instável",
    "queda",
    "perda de pacote",
    "ping alto",
    "latencia",
    "latência",
  ];
  if (supportKw.some((k) => t.includes(k)) || t.includes("suporte")) return "support";

  // FINANCEIRO
  const financeKw = [
    "boleto",
    "2 via",
    "2ª via",
    "segunda via",
    "fatura",
    "mensalidade",
    "venc",
    "atraso",
    "atrasado",
    "paguei",
    "pagamento",
    "pix",
    "comprov",
    "comprovante",
    "recibo",
    "codigo de barras",
    "código de barras",
    "liberar",
    "liberação",
    "desbloquear",
    "bloqueado",
    "corte",
    "cortou",
    "cobrança",
    "cobranca",
    "regularizar",
  ];
  if (financeKw.some((k) => t.includes(k)) || t.includes("financeiro")) return "finance";

  // VENDAS
  const salesKw = [
    "plano",
    "planos",
    "contratar",
    "assinar",
    "instalar",
    "instalação",
    "instalacao",
    "valor",
    "preço",
    "preco",
    "quanto custa",
    "cobertura",
    "tem cobertura",
    "disponibilidade",
    "bairro",
    "cidade",
    "endereço",
    "endereco",
    "quero internet",
    "adesão",
    "adesao",
  ];
  if (salesKw.some((k) => t.includes(k))) return "sales";

  return null;
}

export function shouldIgnoreDuplicateEvent() {
  return false;
}

export function buildPersonaHeader(agent) {
  if (agent === "anderson") return "Você é o Anderson do suporte da i9NET. Seja direto e técnico.";
  if (agent === "cassia") return "Você é a Cassia do financeiro da i9NET. Seja objetiva e cordial.";
  return "Você é a Isa da triagem da i9NET. Seja cordial, objetiva e humana.";
}
