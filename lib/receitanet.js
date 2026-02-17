// lib/receitanet.js
// ✅ Arquivo completo (pronto para copiar e colar)
// Observação: mantive as funções já usadas no server.js:
// rnFindClient, rnListDebitos, rnVerificarAcesso, rnNotificacaoPagamento
// e corrigi pickBestOverdueBoleto para NUNCA retornar "Baixado" quando existir "Pendente".

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function onlyDigits(s) {
  return String(s || "").replace(/\D+/g, "");
}

function parseBRDateToTime(d) {
  const s = String(d || "").trim();
  if (!s) return NaN;

  // dd/mm/yyyy
  const m1 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m1) {
    const [, dd, mm, yyyy] = m1;
    return new Date(Number(yyyy), Number(mm) - 1, Number(dd), 12, 0, 0).getTime();
  }

  // yyyy-mm-dd
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) {
    const [, yyyy, mm, dd] = m2;
    return new Date(Number(yyyy), Number(mm) - 1, Number(dd), 12, 0, 0).getTime();
  }

  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

function getVencTime(b) {
  const v =
    b?.vencimento ||
    b?.dataVencimento ||
    b?.dtVencimento ||
    b?.venc ||
    b?.due_date ||
    "";
  return parseBRDateToTime(v);
}

function isBaixado(b) {
  const s = norm(b?.status || b?.situacao || b?.estado || b?.state);

  if (s.includes("baix")) return true;
  if (s.includes("pago")) return true;
  if (s.includes("liquid")) return true;

  // campos alternativos
  if (b?.pagamento || b?.dataPagamento || b?.dtPagamento) return true;
  if (b?.baixado === true || b?.pago === true || b?.liquidado === true) return true;

  return false;
}

function isPendente(b) {
  const s = norm(b?.status || b?.situacao || b?.estado || b?.state);

  if (s.includes("pend")) return true;
  if (s.includes("aberto")) return true;
  if (s.includes("em aberto")) return true;

  // alguns backends usam status=0 como "aberto"
  if (String(b?.status).trim() === "0") return true;

  return false;
}

function getAtrasoDias(b) {
  // tenta campo pronto
  const raw =
    b?.diasAtraso ??
    b?.dias_em_atraso ??
    b?.atrasoDias ??
    b?.diasEmAtraso ??
    null;

  const rawStr = String(raw ?? "").trim();
  if (rawStr) {
    const n = Number(rawStr.replace(/[^\d-]/g, ""));
    if (Number.isFinite(n)) return n;
  }

  // calcula pelo vencimento
  const vt = getVencTime(b);
  if (!Number.isFinite(vt)) return -999999;

  const today = new Date();
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0).getTime();
  const diff = Math.floor((now - vt) / (24 * 60 * 60 * 1000));
  return diff; // >0 atrasado
}

function safeJson(res) {
  return res?.json ? res.json() : null;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`ReceitaNet error (${res.status})`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json;
}

// =========================
// ✅ Função corrigida
// =========================
export function pickBestOverdueBoleto(list) {
  const items = Array.isArray(list) ? list : [];

  // 1) filtra SOMENTE pendentes
  const pendentes = items.filter((b) => isPendente(b) && !isBaixado(b));

  if (pendentes.length > 0) {
    // escolhe o MAIS ATRASADO (maior atraso) e, em empate, o vencimento mais antigo
    const sorted = pendentes
      .slice()
      .sort((a, b) => getAtrasoDias(b) - getAtrasoDias(a) || getVencTime(a) - getVencTime(b));

    return { boleto: sorted[0] || null, overdueCount: pendentes.length };
  }

  // 2) se não tem pendente, não devolve "baixado" aleatório (evita erro)
  return { boleto: null, overdueCount: 0 };
}

// =========================
// API wrappers (compatíveis com seu server.js)
// =========================
// Base do seu sistema (exemplo):
// https://sistema.receitanet.net/api/novo/chatbot
// Você passa "app" e "token" e os outros parâmetros.

export async function rnFindClient({ baseUrl, token, app = "chatbot", cpfcnpj = "", phone = "" }) {
  const cpf = onlyDigits(cpfcnpj);
  const fone = onlyDigits(phone);

  // ⚠️ Ajuste de endpoint/campos caso o seu backend use nomes diferentes.
  // Mantive um padrão bem comum: /cliente/find
  const url = `${baseUrl}/cliente/find`;

  const body = {
    app,
    token,
    cpfcnpj: cpf || undefined,
    phone: fone || undefined,
  };

  const json = await fetchJson(url, { method: "POST", body });

  // Normaliza formato esperado no server.js
  // server.js espera { found: boolean, data: {...} }
  if (json?.found !== undefined) return json;

  // Se a API retornar em outro formato, tentamos inferir:
  const data = json?.data || json?.cliente || json?.result || json;
  const found = Boolean(data && (data.idCliente || data.idcliente || data.id || data.cpfCnpj || data.cpfcnpj));

  return { found, data };
}

export async function rnListDebitos({ baseUrl, token, app = "chatbot", cpfcnpj = "", status = 0 }) {
  const cpf = onlyDigits(cpfcnpj);

  // ⚠️ Endpoint padrão: /debitos/list
  const url = `${baseUrl}/debitos/list`;

  const body = {
    app,
    token,
    cpfcnpj: cpf || undefined,
    status, // você já usa status:0 no server.js
  };

  const json = await fetchJson(url, { method: "POST", body });

  // Pode vir direto como array
  if (Array.isArray(json)) return json;

  // Ou encapsulado
  const list = json?.data || json?.debitos || json?.boletos || json?.result || [];
  return Array.isArray(list) ? list : [];
}

export async function rnVerificarAcesso({ baseUrl, token, app = "chatbot", idCliente, contato = "" }) {
  const id = String(idCliente || "").trim();
  const fone = onlyDigits(contato);

  // ⚠️ Endpoint padrão: /acesso/verificar
  const url = `${baseUrl}/acesso/verificar`;

  const body = {
    app,
    token,
    idCliente: id || undefined,
    contato: fone || undefined,
  };

  const json = await fetchJson(url, { method: "POST", body });

  // server.js usa acesso?.data
  if (json?.data !== undefined) return json;

  return { data: json };
}

export async function rnNotificacaoPagamento({ baseUrl, token, app = "chatbot", idCliente, contato = "" }) {
  const id = String(idCliente || "").trim();
  const fone = onlyDigits(contato);

  // ⚠️ Endpoint padrão: /pagamento/notificar
  const url = `${baseUrl}/pagamento/notificar`;

  const body = {
    app,
    token,
    idCliente: id || undefined,
    contato: fone || undefined,
  };

  const json = await fetchJson(url, { method: "POST", body });
  return json;
}
