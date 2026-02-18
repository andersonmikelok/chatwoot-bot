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

// ============================
// ✅ Anti-duplicidade (conservador)
// ============================
// Guarda fingerprints recentes por conversa para ignorar eventos repetidos.
const DEDUPE_WINDOW_MS = Number(process.env.CW_DEDUPE_WINDOW_MS || 8000); // 8s (conservador)
const MAX_KEYS_PER_CONV = 40;

const dedupeMap = new Map(); // conversationId -> { keys: Map(fingerprint->ts) }

function safeStr(v) {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

function normalizeForKey(s) {
  return safeStr(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getMessageId(payload) {
  return (
    payload?.id ||
    payload?.message?.id ||
    payload?.conversation?.last_message?.id ||
    payload?.content_attributes?.message_id ||
    payload?.message_id ||
    null
  );
}

function getEventTs(payload) {
  // tenta campos comuns (segundos ou ms)
  const candidates = [
    payload?.created_at,
    payload?.message?.created_at,
    payload?.timestamp,
    payload?.event_timestamp,
    payload?.conversation?.last_message?.created_at,
  ];

  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    const n = Number(c);
    if (!Number.isFinite(n)) continue;
    // se parece segundos, converte
    if (n > 0 && n < 2e10) return n < 2e12 ? n * 1000 : n;
  }

  return Date.now();
}

function attachmentsKey(payload) {
  const atts = payload?.attachments || [];
  if (!Array.isArray(atts) || atts.length === 0) return "noatt";

  // usa só informações estáveis (id/url/tipo)
  const parts = atts
    .slice(0, 3)
    .map((a) => {
      const id = a?.id || a?.file_id || "";
      const url = a?.data_url || a?.dataUrl || a?.url || "";
      const type = a?.file_type || a?.tipo_de_arquivo || "";
      return `${safeStr(id)}|${safeStr(type)}|${safeStr(url).slice(0, 60)}`;
    })
    .join(",");

  return parts ? `att:${normalizeForKey(parts)}` : "att:unknown";
}

function purgeOld(mapKeys, now) {
  for (const [k, ts] of mapKeys.entries()) {
    if (now - ts > DEDUPE_WINDOW_MS) mapKeys.delete(k);
  }
  // limita crescimento (remove mais antigos)
  if (mapKeys.size > MAX_KEYS_PER_CONV) {
    const arr = Array.from(mapKeys.entries()).sort((a, b) => a[1] - b[1]);
    const toDrop = arr.slice(0, mapKeys.size - MAX_KEYS_PER_CONV);
    for (const [k] of toDrop) mapKeys.delete(k);
  }
}

export function shouldIgnoreDuplicateEvent(payload) {
  try {
    const conversationId = extractConversationId(payload);
    if (!conversationId) return false;

    const now = Date.now();
    const bucket = dedupeMap.get(String(conversationId)) || { keys: new Map() };
    const keys = bucket.keys;

    purgeOld(keys, now);

    const msgId = getMessageId(payload);
    const text = normalizeForKey(extractMessageText(payload));
    const attKey = attachmentsKey(payload);

    // timestamp arredondado para “agrupar” reentregas quase iguais
    const ts = getEventTs(payload);
    const tsBucket = Math.floor(ts / 2000); // 2s

    // Preferência: se tem msgId, usa ele (mais preciso)
    const fingerprint = msgId
      ? `mid:${msgId}`
      : `t:${text.slice(0, 120)}|${attKey}|b:${tsBucket}`;

    if (keys.has(fingerprint)) {
      // duplicado dentro da janela
      return true;
    }

    keys.set(fingerprint, now);
    dedupeMap.set(String(conversationId), bucket);
    return false;
  } catch {
    return false;
  }
}

export function buildPersonaHeader(agent) {
  if (agent === "anderson") return "Você é o Anderson do suporte da i9NET. Seja direto e técnico.";
  if (agent === "cassia") return "Você é a Cassia do financeiro da i9NET. Seja objetiva e cordial.";
  return "Você é a Isa da triagem da i9NET. Seja cordial, objetiva e humana.";
}
