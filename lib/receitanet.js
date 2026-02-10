// lib/receitanet.js
// ReceitaNet Chatbot API helpers + seleção correta de boleto
// Regra:
// - Se existir boleto vencido => enviar o VENCIDO MAIS ANTIGO
// - Se não existir vencido => enviar o BOLETO VIGENTE DO MÊS (se der), senão o PRÓXIMO A VENCER

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
 * POST /clientes  (query: token, app, cpfcnpj, phone, idCliente) 404 se não encontrar
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
// Helpers: idCliente (fallback em contratos)
// ---------------------

function toId(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  if (!s) return "";
  if (s === "0") return "";
  const sl = s.toLowerCase();
  if (sl === "null" || sl === "undefined") return "";
  return s;
}

function normalizeCollection(maybeArrayOrObj) {
  if (!maybeArrayOrObj) return [];
  if (Array.isArray(maybeArrayOrObj)) return maybeArrayOrObj.filter(Boolean);

  if (typeof maybeArrayOrObj === "object") {
    // caso { "0": {...}, "1": {...} }
    const keys = Object.keys(maybeArrayOrObj)
      .filter((k) => /^[0-9]+$/.test(String(k)))
      .sort((a, b) => Number(a) - Number(b));
    if (keys.length) return keys.map((k) => maybeArrayOrObj[k]).filter(Boolean);

    return Object.values(maybeArrayOrObj).filter(Boolean);
  }
  return [];
}

/**
 * ✅ extrai id do root; se vier vazio, cai para contratos
 * (muitas vezes o ID utilizável para liberação vem como idContrato)
 */
function extractIdClienteFromClientPayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};

  // 1) root idCliente
  const rootId = toId(
    p.idCliente ??
      p.idcliente ??
      p.IdCliente ??
      p.cliente_id ??
      p.clienteId ??
      p.id
  );
  if (rootId) return rootId;

  // 2) contratos (array ou objeto indexado)
  const contratosRaw = p.contratos ?? p.data?.contratos ?? p.cliente?.contratos ?? null;
  const contratos = normalizeCollection(contratosRaw);

  for (const c of contratos) {
    if (!c || typeof c !== "object") continue;

    // tenta idCliente dentro do contrato
    const idCli = toId(
      c.idCliente ?? c.idcliente ?? c.IdCliente ?? c.cliente_id ?? c.clienteId
    );
    if (idCli) return idCli;

    // fallback: idContrato (mais comum e normalmente funciona p/ liberação)
    const idContrato = toId(
      c.idContrato ??
        c.idcontrato ??
        c.IdContrato ??
        c.id_contrato ??
        c.contrato_id ??
        c.contratoId ??
        c.id
    );
    if (idContrato) return idContrato;

    // fallback aninhado
    const nested = c.cliente || c.contrato || c.titular || null;
    if (nested && typeof nested === "object") {
      const idNested = toId(
        nested.idCliente ??
          nested.idcliente ??
          nested.IdCliente ??
          nested.idContrato ??
          nested.idcontrato ??
          nested.IdContrato ??
          nested.id_contrato ??
          nested.contrato_id ??
          nested.id
      );
      if (idNested) return idNested;
    }
  }

  return "";
}

// ---------------------
// API wrappers
// ---------------------

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

  return {
    found: true,
    status: resp.status,
    data: {
      ...(raw || {}),
      idCliente: extracted || raw.idCliente || raw.idcliente || raw.IdCliente || "",
    },
  };
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

  if (resp.status === 404) return { ok: false, status: 404, body: resp.json || resp.text };
  if (!resp.ok) return { ok: false, status: resp.status, body: resp.json || resp.text };

  return { ok: true, status: resp.status, data: resp.json };
}

// ---------------------
// BOLETOS: normalização + regra de escolha
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

  const vencimento = r.vencimento || r.data_vencimento || r.dt_vencimento || r.vcto || "";
  const valor = r.valor ?? r.valor_boleto ?? r.vlr ?? r.total ?? "";

  const link = r.link || r.url || r.boleto_link || r.link_boleto || r.url_boleto || "";
  const qrcode_pix = r.qrcode_pix || r.pix || r.pix_copia_cola || r.copia_cola || r.qr_pix || "";
  const barras = r.barras || r.codigo_barras || r.linha_digitavel || r.linha || "";
  const pdf = r.pdf || r.pdf_url || r.url_pdf || r.boleto_pdf || "";

  const statusText = String(r.status || r.situacao || r.estado || r.status_boleto || "").toLowerCase();
  const pago = r.pago === true || r.paid === true || statusText.includes("pago") || statusText.includes("baix");
  const excluido = r.excluido === true || statusText.includes("exclu") || statusText.includes("cancel") || statusText.includes("inativ");

  return { vencimento, valor, link, qrcode_pix, barras, pdf, pago, excluido };
}

function parseDateBrOrIsoToMs(s) {
  const v = String(s || "").trim();
  if (!v) return NaN;

  // ISO: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    return new Date(v.slice(0, 10) + "T00:00:00Z").getTime();
  }

  // BR: DD/MM/YYYY
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yy = Number(m[3]);
    return new Date(Date.UTC(yy, mm - 1, dd, 0, 0, 0)).getTime();
  }

  const d2 = new Date(v);
  const t2 = d2.getTime();
  return Number.isFinite(t2) ? t2 : NaN;
}

function nowMs() {
  return Date.now();
}

/**
 * Retorna:
 * { boleto, overdueCount, openCount }
 *
 * Regra pedida:
 * - Se existir vencido: retorna o vencido MAIS ANTIGO (menor data)
 * - Senão: retorna o boleto vigente do mês (mesmo mês/ano atual), senão o próximo a vencer
 */
export function pickBoletoOldestOverdueElseCurrent(debitos) {
  if (!Array.isArray(debitos) || !debitos.length) {
    return { boleto: null, overdueCount: 0, openCount: 0 };
  }

  const all = [];
  for (const d of debitos) {
    const lista = normalizeBoletoCollection(d?.boletos);
    for (const b of lista) {
      const mapped = mapBoletoFields(b);
      all.push({
        ...mapped,
        debito_id: d?.id || "",
      });
    }
  }

  const withContent = all.filter((b) => (b.link || b.qrcode_pix || b.barras || b.pdf));
  const usable = withContent.length ? withContent : all;

  // tenta ignorar pago/excluído se essas flags existirem
  const filtered = usable.filter((b) => !b.pago && !b.excluido);
  const list = filtered.length ? filtered : usable;

  const listDated = list
    .map((b) => ({ ...b, _vencMs: parseDateBrOrIsoToMs(b.vencimento) }))
    .filter((b) => Number.isFinite(b._vencMs));

  if (!listDated.length) {
    return { boleto: list[0] || null, overdueCount: 0, openCount: list.length };
  }

  const nMs = nowMs();
  const overdue = listDated.filter((b) => b._vencMs < nMs);
  const future = listDated.filter((b) => b._vencMs >= nMs);

  // 1) vencido mais antigo
  if (overdue.length) {
    overdue.sort((a, b) => a._vencMs - b._vencMs);
    return { boleto: overdue[0], overdueCount: overdue.length, openCount: listDated.length };
  }

  // 2) vigente do mês
  const now = new Date(nMs);
  const m0 = now.getUTCMonth();
  const y0 = now.getUTCFullYear();

  const currentMonth = future.filter((b) => {
    const d = new Date(b._vencMs);
    return d.getUTCMonth() === m0 && d.getUTCFullYear() === y0;
  });

  if (currentMonth.length) {
    currentMonth.sort((a, b) => a._vencMs - b._vencMs);
    return { boleto: currentMonth[0], overdueCount: 0, openCount: listDated.length };
  }

  // 3) fallback: próximo a vencer
  future.sort((a, b) => a._vencMs - b._vencMs);
  return { boleto: future[0] || null, overdueCount: 0, openCount: listDated.length };
}

// Compatibilidade com seu server.js antigo
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
