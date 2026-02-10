// lib/receitanet.js
// ReceitaNet Chatbot API helpers + seleção de boleto (vencido mais antigo / vigente do mês)

function q(params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    usp.set(k, String(v));
  }
  return usp.toString();
}

/**
 * ReceitaNet Chatbot API:
 * Server: https://sistema.receitanet.net/api/novo/chatbot
 * POST /clientes  (query: token, app, cpfcnpj, phone, idCliente)  404 se não encontrar
 * POST /debitos   (query: token, app, cpfcnpj, status, data_inicio, data_fim, page)
 * POST /verificar-acesso (query: token, app, idCliente, contato)
 * POST /notificacao-pagamento (query: token, app, idCliente, contato)
 * POST /boletos (query: token, app, idCliente, tipo=email|sms, contato)
 */
async function rnPost({ baseUrl, path, queryParams }) {
  const url = `${baseUrl}${path}?${q(queryParams)}`;
  const res = await fetch(url, { method: "POST" });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: res.ok, status: res.status, json, text, url };
}

// ---------------------
// CLIENTE
// ---------------------

function pickFirstNonEmpty(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

/**
 * Garante extração de idCliente mesmo quando vem dentro de "contratos".
 */
function extractIdClienteFromClientPayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};

  // topo do objeto
  const top = pickFirstNonEmpty(
    p.idCliente,
    p.idcliente,
    p.IdCliente,
    p.id,
    p.cliente_id,
    p.clienteId
  );
  if (top) return String(top).trim();

  // dentro de contratos
  const contratos = Array.isArray(p.contratos)
    ? p.contratos
    : Array.isArray(p?.data?.contratos)
    ? p.data.contratos
    : null;

  if (Array.isArray(contratos) && contratos.length) {
    const c0 = contratos[0] || {};
    const cId = pickFirstNonEmpty(
      c0.idCliente,
      c0.idcliente,
      c0.IdCliente,
      c0.id,
      c0.cliente_id,
      c0.clienteId
    );
    if (cId) return String(cId).trim();
  }

  // payload em array
  if (Array.isArray(payload) && payload.length) {
    const first = payload[0] || {};
    const aId = pickFirstNonEmpty(
      first.idCliente,
      first.idcliente,
      first.IdCliente,
      first.id,
      first.cliente_id,
      first.clienteId
    );
    if (aId) return String(aId).trim();
  }

  return "";
}

export async function rnFindClient({ baseUrl, token, app, cpfcnpj, phone, idCliente }) {
  const resp = await rnPost({
    baseUrl,
    path: "/clientes",
    queryParams: { token, app, cpfcnpj, phone, idCliente },
  });

  if (resp.status === 404) return { found: false, status: 404, body: resp.json || resp.text };
  if (!resp.ok) throw new Error(`ReceitaNet /clientes falhou (${resp.status}): ${resp.text}`);

  const raw = Array.isArray(resp.json) ? (resp.json[0] || {}) : (resp.json || {});
  const extracted = extractIdClienteFromClientPayload(raw);

  // sempre devolve data com idCliente “normalizado”
  const data = {
    ...(raw || {}),
    idCliente: extracted || raw?.idCliente || raw?.idcliente || raw?.IdCliente || "",
  };

  return { found: true, status: resp.status, data };
}

export async function rnListDebitos({ baseUrl, token, app, cpfcnpj, status = 0, page, data_inicio, data_fim }) {
  const resp = await rnPost({
    baseUrl,
    path: "/debitos",
    queryParams: { token, app, cpfcnpj, status, page, data_inicio, data_fim },
  });

  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error(`ReceitaNet /debitos falhou (${resp.status}): ${resp.text}`);

  const data = resp.json;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

export async function rnVerificarAcesso({ baseUrl, token, app, idCliente, contato }) {
  const resp = await rnPost({
    baseUrl,
    path: "/verificar-acesso",
    queryParams: { token, app, idCliente, contato },
  });

  if (resp.status === 404) return { ok: false, status: 404, body: resp.json || resp.text };
  if (!resp.ok) throw new Error(`ReceitaNet /verificar-acesso falhou (${resp.status}): ${resp.text}`);

  return { ok: true, status: resp.status, data: resp.json };
}

export async function rnNotificacaoPagamento({ baseUrl, token, app, idCliente, contato }) {
  const resp = await rnPost({
    baseUrl,
    path: "/notificacao-pagamento",
    queryParams: { token, app, idCliente, contato },
  });

  if (resp.status === 404) return { ok: false, status: 404, body: resp.json || resp.text };
  if (!resp.ok) return { ok: false, status: resp.status, body: resp.json || resp.text };

  return { ok: true, status: resp.status, data: resp.json };
}

export async function rnEnviarBoletos({ baseUrl, token, app, idCliente, tipo, contato }) {
  const resp = await rnPost({
    baseUrl,
    path: "/boletos",
    queryParams: { token, app, idCliente, tipo, contato },
  });

  // doc diz “no response body” em alguns casos: ainda assim ok = 200
  if (resp.status === 404) return { ok: false, status: 404, body: resp.json || resp.text };
  if (!resp.ok) return { ok: false, status: resp.status, body: resp.json || resp.text };

  return { ok: true, status: resp.status, data: resp.json };
}

// ---------------------
// BOLETOS: normalização e escolha
// ---------------------

function isNumericKey(k) {
  return /^[0-9]+$/.test(String(k));
}

function normalizeBoletoCollection(boletos) {
  if (!boletos) return [];
  if (Array.isArray(boletos)) return boletos.filter(Boolean);

  if (typeof boletos === "object") {
    const keys = Object.keys(boletos).filter(isNumericKey).sort((a, b) => Number(a) - Number(b));
    if (keys.length) return keys.map((k) => boletos[k]).filter(Boolean);
    return Object.values(boletos).filter(Boolean);
  }
  return [];
}

function mapBoletoFields(raw) {
  const r = raw && typeof raw === "object" ? raw : {};

  const vencimento =
    r.vencimento ||
    r.data_vencimento ||
    r.dt_vencimento ||
    r.vcto ||
    "";

  const valor =
    r.valor ??
    r.valor_boleto ??
    r.vlr ??
    r.total ??
    "";

  const link =
    r.link ||
    r.url ||
    r.boleto_link ||
    r.link_boleto ||
    r.url_boleto ||
    "";

  const qrcode_pix =
    r.qrcode_pix ||
    r.qrcodePix ||
    r.pix ||
    r.pix_copia_cola ||
    r.copia_cola ||
    r.qr_pix ||
    "";

  const barras =
    r.barras ||
    r.codigo_barras ||
    r.linha_digitavel ||
    r.linha ||
    "";

  const pdf =
    r.pdf ||
    r.pdf_url ||
    r.url_pdf ||
    r.boleto_pdf ||
    "";

  // possíveis flags/status (nem sempre existem)
  const statusText =
    String(
      r.status ||
      r.situacao ||
      r.state ||
      r.estado ||
      r.status_boleto ||
      ""
    ).toLowerCase();

  const baixado =
    r.baixado === true ||
    r.pago === true ||
    r.paid === true ||
    statusText.includes("baixad") ||
    statusText.includes("pago") ||
    statusText.includes("paid");

  const excluido =
    r.excluido === true ||
    r.excluído === true ||
    statusText.includes("exclu") ||
    statusText.includes("cancel") ||
    statusText.includes("inativ");

  return { vencimento, valor, link, qrcode_pix, barras, pdf, baixado, excluido };
}

function parseDateBrOrIsoToMs(s) {
  const v = String(s || "").trim();
  if (!v) return NaN;

  // ISO: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v.slice(0, 10) + "T00:00:00Z");
    return d.getTime();
  }

  // BR: DD/MM/YYYY
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yy = Number(m[3]);
    const d = new Date(Date.UTC(yy, mm - 1, dd, 0, 0, 0));
    return d.getTime();
  }

  const d2 = new Date(v);
  const t2 = d2.getTime();
  return Number.isFinite(t2) ? t2 : NaN;
}

function nowMs() {
  return Date.now();
}

/**
 * Regra pedida:
 * - Se existir pelo menos 1 vencido => escolher o VENCIDO MAIS ANTIGO (menor vencimento)
 * - Se não existir vencido => escolher o boleto vigente do mês (se der), senão o mais próximo do vencimento futuro
 *
 * Retorna:
 * { boleto, overdueCount, openCount }
 */
export function pickBoletoOldestOverdueElseCurrent(debitos) {
  const all = [];
  if (!Array.isArray(debitos) || !debitos.length) {
    return { boleto: null, overdueCount: 0, openCount: 0 };
  }

  for (const d of debitos) {
    const lista = normalizeBoletoCollection(d?.boletos);
    for (const b of lista) {
      const mapped = mapBoletoFields(b);
      all.push({
        ...mapped,
        nome: d?.nome || "",
        telefone1: d?.telefone1 || "",
        telefone2: d?.telefone2 || "",
        telefone3: d?.telefone3 || "",
        debito_id: d?.id || "",
      });
    }
  }

  // remove itens claramente inválidos
  const usable = all.filter((b) => (b.link || b.qrcode_pix || b.barras || b.pdf));

  // tenta ignorar “baixado/excluído” quando essas flags existirem
  const filtered = usable.filter((b) => !b.baixado && !b.excluido);

  const list = filtered.length ? filtered : usable; // fallback se não houver flags confiáveis
  const nMs = nowMs();

  const withDate = list.map((b) => {
    const ms = parseDateBrOrIsoToMs(b.vencimento);
    return { ...b, _vencMs: ms };
  });

  const dated = withDate.filter((b) => Number.isFinite(b._vencMs));

  // Se não tem data parseável, volta para o primeiro “com conteúdo”
  if (!dated.length) {
    return {
      boleto: list[0] || null,
      overdueCount: 0,
      openCount: list.length,
    };
  }

  const overdue = dated.filter((b) => b._vencMs < nMs);
  const future = dated.filter((b) => b._vencMs >= nMs);

  // 1) existe vencido => mais antigo (menor vencimento)
  if (overdue.length) {
    overdue.sort((a, b) => a._vencMs - b._vencMs);
    return {
      boleto: overdue[0],
      overdueCount: overdue.length,
      openCount: dated.length,
    };
  }

  // 2) sem vencido => tentar “vigente do mês”
  // mês/ano atual em UTC
  const now = new Date(nMs);
  const m0 = now.getUTCMonth();
  const y0 = now.getUTCFullYear();

  const currentMonth = future.filter((b) => {
    const d = new Date(b._vencMs);
    return d.getUTCMonth() === m0 && d.getUTCFullYear() === y0;
  });

  if (currentMonth.length) {
    // “vigente do mês”: o que vence primeiro dentro do mês
    currentMonth.sort((a, b) => a._vencMs - b._vencMs);
    return {
      boleto: currentMonth[0],
      overdueCount: 0,
      openCount: dated.length,
    };
  }

  // 3) fallback: próximo vencimento futuro
  future.sort((a, b) => a._vencMs - b._vencMs);
  return {
    boleto: future[0] || null,
    overdueCount: 0,
    openCount: dated.length,
  };
}

// Compat: se seu server.js ainda importa pickBestOverdueBoleto,
// mantenho export apontando para a nova regra.
export function pickBestOverdueBoleto(debitos) {
  return pickBoletoOldestOverdueElseCurrent(debitos).boleto;
}

export function formatBoletoWhatsApp(b) {
  const parts = [];
  parts.push("📄 *Boleto em aberto*");
  if (b.vencimento) parts.push(`🗓️ *Vencimento:* ${b.vencimento}`);
  if (b.valor !== undefined && b.valor !== null && String(b.valor).trim() !== "") {
    parts.push(`💰 *Valor:* R$ ${String(b.valor).replace(".", ",")}`);
  }
  if (b.link) parts.push(`🔗 *Link do boleto:* ${b.link}`);
  if (b.qrcode_pix) parts.push(`📌 *PIX copia e cola:* ${b.qrcode_pix}`);
  if (b.barras) parts.push(`🏷️ *Código de barras:* ${b.barras}`);
  if (b.pdf) parts.push(`📎 *PDF:* ${b.pdf}`);
  return parts.join("\n");
}
