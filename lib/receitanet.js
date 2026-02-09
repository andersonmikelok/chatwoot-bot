// lib/receitanet.js

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
// Helpers: normalização de cliente/contrato
// ---------------------
function pickFirstContratoIdCliente(json) {
  // casos comuns: { contratos: [...] }
  const contratos =
    json?.contratos ||
    json?.data?.contratos ||
    json?.cliente?.contratos ||
    json?.result?.contratos ||
    null;

  const arr = Array.isArray(contratos) ? contratos : null;
  if (!arr || !arr.length) return "";

  const c0 = arr[0] || {};
  // tenta chaves mais comuns dentro do contrato
  const id =
    c0?.idCliente ??
    c0?.idcliente ??
    c0?.IdCliente ??
    c0?.id ??
    c0?.cliente_id ??
    c0?.clienteId ??
    c0?.id_contrato ?? // às vezes confundem
    "";

  return String(id || "").trim();
}

function normalizeClientData(respJson) {
  // alguns retornam array, outros objeto
  const raw = Array.isArray(respJson) ? respJson[0] : respJson;
  const r = raw && typeof raw === "object" ? raw : {};

  // se já tiver idCliente direto, mantém
  let idCliente =
    r?.idCliente ??
    r?.idcliente ??
    r?.IdCliente ??
    r?.id ??
    r?.cliente_id ??
    r?.clienteId ??
    r?.cliente?.idCliente ??
    "";

  idCliente = String(idCliente || "").trim();

  // se não tiver, tenta pegar de contratos
  if (!idCliente) {
    idCliente = pickFirstContratoIdCliente(r);
  }

  // retorna uma estrutura consistente
  return {
    ...r,
    idCliente,
  };
}

export async function rnFindClient({ baseUrl, token, app, cpfcnpj, phone, idCliente }) {
  const resp = await rnPost({
    baseUrl,
    path: "/clientes",
    queryParams: { token, app, cpfcnpj, phone, idCliente },
  });

  if (resp.status === 404) return { found: false, status: 404, body: resp.json || resp.text };
  if (!resp.ok) throw new Error(`ReceitaNet /clientes falhou (${resp.status}): ${resp.text}`);

  const data = normalizeClientData(resp.json);

  // fallback: se API respondeu success=false
  if (data?.success === false) {
    return { found: false, status: resp.status, body: data };
  }

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
  if (Array.isArray(data?.debitos)) return data.debitos;
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

// ✅ Notificação de pagamento (liberação provisória)
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

// ---------------------
// BOLETOS: normalização
// ---------------------
function isNumericKey(k) {
  return /^[0-9]+$/.test(String(k));
}

function normalizeBoletoCollection(boletos) {
  if (!boletos) return [];
  if (Array.isArray(boletos)) return boletos.filter(Boolean);

  if (typeof boletos === "object") {
    const keys = Object.keys(boletos)
      .filter(isNumericKey)
      .sort((a, b) => Number(a) - Number(b));
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

  // 👇 campos extras úteis pra filtrar pagos/excluídos (se vierem)
  const status = r.status ?? r.situacao ?? r.sit ?? "";
  const pago = r.pago ?? r.pagamento ?? r.is_pago ?? false;
  const excluido = r.excluido ?? r.cancelado ?? r.deleted ?? false;

  return { vencimento, valor, link, qrcode_pix, barras, pdf, status, pago, excluido };
}

function looksPaidOrDeleted(b) {
  const s = String(b?.status || "").toLowerCase();
  if (b?.pago === true) return true;
  if (b?.excluido === true) return true;
  if (s.includes("pago") || s.includes("baix") || s.includes("liquid")) return true;
  if (s.includes("exclu") || s.includes("cancel")) return true;
  return false;
}

// ✅ Regra: pega o boleto “mais recente em atraso” e ignora pago/excluído quando possível
export function pickBestOverdueBoleto(debitos) {
  if (!Array.isArray(debitos) || !debitos.length) return null;

  const all = [];
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
  if (!all.length) return null;

  // 1) elimina pagos/excluídos se for possível identificar
  const candidates = all.filter((b) => !looksPaidOrDeleted(b));
  const pool = candidates.length ? candidates : all;

  // 2) preferir com conteúdo
  const withContent = pool.filter((b) => b.link || b.qrcode_pix || b.barras || b.pdf);

  // 3) ordenar por vencimento DESC se formato permitir (DD/MM/YYYY ou YYYY-MM-DD)
  const parseDate = (v) => {
    const s = String(v || "").trim();
    if (!s) return 0;

    // YYYY-MM-DD
    const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m1) return new Date(`${m1[1]}-${m1[2]}-${m1[3]}T00:00:00Z`).getTime();

    // DD/MM/YYYY
    const m2 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (m2) return new Date(`${m2[3]}-${m2[2]}-${m2[1]}T00:00:00Z`).getTime();

    return 0;
  };

  const sorted = (withContent.length ? withContent : pool).slice().sort((a, b) => {
    return parseDate(b.vencimento) - parseDate(a.vencimento);
  });

  return sorted[0] || pool[0] || null;
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
