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
 * POST /clientes (query: token, app, cpfcnpj, phone, idCliente)
 * POST /debitos  (query: token, app, cpfcnpj, status, data_inicio, data_fim, page)
 * POST /verificar-acesso (query: token, app, idCliente, contato)
 * POST /notificacao-pagamento (form-data: token, app, idCliente, contato)
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

async function rnPostForm({ baseUrl, path, form }) {
  const url = `${baseUrl}${path}`;
  const fd = new FormData();
  for (const [k, v] of Object.entries(form || {})) {
    if (v === undefined || v === null || v === "") continue;
    fd.append(k, String(v));
  }
  const res = await fetch(url, { method: "POST", body: fd });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: res.ok, status: res.status, json, text, url };
}

function pickIdClienteFromClientData(data) {
  const d = data && typeof data === "object" ? data : {};

  const direct =
    d.idCliente ??
    d.idcliente ??
    d.IdCliente ??
    d.id ??
    d.cliente_id ??
    d.clienteId ??
    d?.cliente?.idCliente ??
    "";

  if (direct) return String(direct).trim();

  const contratos = Array.isArray(d.contratos) ? d.contratos : [];
  for (const c of contratos) {
    const id =
      c?.idCliente ??
      c?.idcliente ??
      c?.IdCliente ??
      c?.id ??
      c?.cliente_id ??
      c?.clienteId ??
      "";
    if (id) return String(id).trim();
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

  const raw = Array.isArray(resp.json) ? resp.json[0] : resp.json;
  const data = raw && typeof raw === "object" ? raw : {};

  const idC = pickIdClienteFromClientData(data);
  if (idC && !data.idCliente) data.idCliente = idC;

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
  const resp = await rnPostForm({
    baseUrl,
    path: "/notificacao-pagamento",
    form: { token, app, idCliente, contato },
  });

  if (!resp.ok) {
    return { ok: false, status: resp.status, data: resp.json, text: resp.text, url: resp.url };
  }
  return { ok: true, status: resp.status, data: resp.json };
}

// ---------------------
// BOLETOS: normalização + seleção correta
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

function normStr(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/**
 * Detecta evidência de pagamento/baixa mesmo se não existir status textual.
 * Ex.: na sua tela: "Pagamento: 06/12/2025" => isso precisa marcar como BAIXADO.
 */
function extractPaidAt(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  // campos comuns em ERPs
  return (
    r.pagamento ||
    r.data_pagamento ||
    r.dt_pagamento ||
    r.dataPagamento ||
    r.dtPagamento ||
    r.payment_date ||
    r.paid_at ||
    r.paidAt ||
    ""
  );
}

function looksLikeTrue(v) {
  if (v === true) return true;
  const s = normStr(v);
  return s === "1" || s === "true" || s === "sim" || s === "s" || s === "yes";
}

function isPaidOrClosed({ statusRaw, paidAt, flags = {} }) {
  // 1) se existe data/registro de pagamento => BAIXADO
  if (String(paidAt || "").trim()) return true;

  // 2) flags booleanas (muitos ERPs mandam isso)
  if (looksLikeTrue(flags.baixado)) return true;
  if (looksLikeTrue(flags.pago)) return true;
  if (looksLikeTrue(flags.liquidado)) return true;
  if (looksLikeTrue(flags.cancelado)) return true;

  // 3) status textual
  const s = normStr(statusRaw);
  if (!s) return false;

  if (s.includes("baix")) return true;
  if (s.includes("pag")) return true;
  if (s.includes("liquid")) return true;
  if (s.includes("cancel")) return true;
  if (s.includes("estornado")) return true;

  return false;
}

function mapBoletoFields(raw, parentDebito = null) {
  const r = raw && typeof raw === "object" ? raw : {};
  const p = parentDebito && typeof parentDebito === "object" ? parentDebito : {};

  const vencimento =
    r.vencimento ||
    r.data_vencimento ||
    r.dt_vencimento ||
    r.vcto ||
    r.due_date ||
    p.vencimento ||
    p.data_vencimento ||
    p.dt_vencimento ||
    p.vcto ||
    "";

  const valor = r.valor ?? r.valor_boleto ?? r.vlr ?? r.total ?? r.amount ?? p.valor ?? p.total ?? "";

  const link = r.link || r.url || r.boleto_link || r.link_boleto || r.url_boleto || p.link || p.url || "";
  const qrcode_pix = r.qrcode_pix || r.pix || r.pix_copia_cola || r.copia_cola || r.qr_pix || p.qrcode_pix || p.pix || "";
  const barras = r.barras || r.codigo_barras || r.linha_digitavel || r.linha || p.barras || p.codigo_barras || p.linha_digitavel || "";
  const pdf = r.pdf || r.pdf_url || r.url_pdf || r.boleto_pdf || p.pdf || p.pdf_url || p.url_pdf || "";

  // status pode estar no boleto OU no débito (ou em ambos)
  const statusRaw = r.status || r.situacao || r.sit || r.estado || r.state || p.status || p.situacao || p.sit || p.estado || p.state || "";

  const paidAt = extractPaidAt(r) || extractPaidAt(p);

  const flags = {
    baixado: r.baixado ?? p.baixado,
    pago: r.pago ?? p.pago,
    liquidado: r.liquidado ?? p.liquidado,
    cancelado: r.cancelado ?? p.cancelado,
  };

  return { vencimento, valor, link, qrcode_pix, barras, pdf, statusRaw, paidAt, flags };
}

/**
 * Suporta:
 * - YYYY-MM-DD
 * - DD/MM/YYYY
 */
function parseDateSafe(s) {
  const t = String(s || "").trim();
  if (!t) return null;

  // YYYY-MM-DD
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (y && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
    return null;
  }

  // DD/MM/YYYY
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (y && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
    return null;
  }

  return null;
}

/**
 * Regra:
 * - monta todos os boletos
 * - REMOVE qualquer boleto com evidência de BAIXA/PAGAMENTO
 * - se houver pendente vencido: pega o mais antigo
 * - senão: pega o pendente futuro mais próximo
 */
export function pickBestOverdueBoleto(debitos) {
  if (!Array.isArray(debitos) || !debitos.length) return { boleto: null, overdueCount: 0 };

  const all = [];

  for (const d of debitos) {
    const lista = normalizeBoletoCollection(d?.boletos);

    if (lista.length) {
      for (const b of lista) {
        const mapped = mapBoletoFields(b, d);
        all.push({ ...mapped, debito_id: d?.id || d?.idDebito || "", nome: d?.nome || d?.descricao || "" });
      }
    } else {
      // fallback: o "débito" já vem como um boleto
      const mappedD = mapBoletoFields(d, null);
      const hasAny = mappedD.link || mappedD.qrcode_pix || mappedD.barras || mappedD.pdf || mappedD.vencimento;
      if (hasAny) all.push({ ...mappedD, debito_id: d?.id || d?.idDebito || "", nome: d?.nome || d?.descricao || "" });
    }
  }

  if (!all.length) return { boleto: null, overdueCount: 0 };

  // ✅ remove baixados/pagos/cancelados por QUALQUER evidência
  const pending = all.filter((b) => !isPaidOrClosed({ statusRaw: b.statusRaw, paidAt: b.paidAt, flags: b.flags }));
  if (!pending.length) return { boleto: null, overdueCount: 0 };

  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));

  const withDates = pending
    .map((b) => ({ ...b, _dt: parseDateSafe(b.vencimento) }))
    .filter((b) => b._dt);

  // se não tiver datas parseáveis, pega o primeiro que tenha conteúdo de pagamento (link/pix/barras/pdf)
  if (!withDates.length) {
    const withContent = pending.find((b) => b.link || b.qrcode_pix || b.barras || b.pdf);
    return { boleto: withContent || pending[0], overdueCount: 0 };
  }

  const overdue = withDates.filter((b) => b._dt < todayUTC);
  const overdueCount = overdue.length;

  if (overdueCount > 0) {
    overdue.sort((a, b) => a._dt - b._dt);
    return { boleto: overdue[0], overdueCount };
  }

  const future = withDates.filter((b) => b._dt >= todayUTC);
  future.sort((a, b) => a._dt - b._dt);
  return { boleto: future[0] || withDates[0], overdueCount: 0 };
}

export function formatBoletoWhatsApp(b) {
  const parts = [];
  parts.push("📄 *Boleto em aberto*");
  if (b.vencimento) parts.push(`🗓️ *Vencimento:* ${b.vencimento}`);
  if (b.valor !== undefined && b.valor !== null && String(b.valor).trim() !== "") {
    parts.push(`💰 *Valor:* R$ ${String(b.valor).replace(".", ",")}`);
  }
  if (b.link) parts.push(`🔗 *Link do boleto:*\n${b.link}`);
  if (b.qrcode_pix) parts.push(`📌 *PIX copia e cola:*\n${b.qrcode_pix}`);
  if (b.barras) parts.push(`🏷️ *Código de barras:*\n${b.barras}`);
  if (b.pdf) parts.push(`📎 *PDF:*\n${b.pdf}`);
  return parts.join("\n");
}