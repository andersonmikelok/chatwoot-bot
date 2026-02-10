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

// form-data (alguns endpoints usam form)
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

  // muitos retornos vêm em "contratos": [{ idCliente: ... }]
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

  // às vezes vem objeto, às vezes array
  const raw = Array.isArray(resp.json) ? resp.json[0] : resp.json;
  const data = raw && typeof raw === "object" ? raw : {};

  // garante idCliente preenchido quando possível
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

  // API pode retornar 200 com "success: 0/2" etc
  if (!resp.ok) {
    return { ok: false, status: resp.status, data: resp.json, text: resp.text, url: resp.url };
  }
  return { ok: true, status: resp.status, data: resp.json };
}

// ---------------------
// BOLETOS: normalização
// ---------------------

function isNumericKey(k) {
  return /^[0-9]+$/.test(String(k));
}

/**
 * Boletos podem vir como objeto { "0": {...}, "1": {...} } ou array.
 */
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
  return { vencimento, valor, link, qrcode_pix, barras, pdf };
}

function parseDateSafeYYYYMMDD(s) {
  const t = String(s || "").trim();
  // esperado: 2026-02-25
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Date UTC pra comparar
  return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
}

/**
 * Regra:
 * - Se existir vencido: pega o VENCIDO MAIS ANTIGO (menor vencimento)
 * - Se não existir vencido: pega o mais "próximo" / vigente (menor vencimento futuro)
 */
export function pickBestOverdueBoleto(debitos) {
  if (!Array.isArray(debitos) || !debitos.length) return { boleto: null, overdueCount: 0 };

  const all = [];
  for (const d of debitos) {
    const lista = normalizeBoletoCollection(d?.boletos);
    for (const b of lista) {
      const mapped = mapBoletoFields(b);
      all.push({
        ...mapped,
        debito_id: d?.id || "",
        nome: d?.nome || "",
      });
    }
  }

  if (!all.length) return { boleto: null, overdueCount: 0 };

  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));

  const withDates = all
    .map((b) => {
      const dt = parseDateSafeYYYYMMDD(b.vencimento);
      return { ...b, _dt: dt };
    })
    .filter((b) => b._dt);

  // se não tiver datas parseáveis, cai no primeiro com conteúdo
  if (!withDates.length) {
    const withContent = all.find((b) => b.link || b.qrcode_pix || b.barras || b.pdf);
    return { boleto: withContent || all[0], overdueCount: 0 };
  }

  const overdue = withDates.filter((b) => b._dt < todayUTC);
  const overdueCount = overdue.length;

  if (overdueCount > 0) {
    // vencido mais antigo = menor data
    overdue.sort((a, b) => a._dt - b._dt);
    return { boleto: overdue[0], overdueCount };
  }

  // sem vencidos -> pega vigente: menor data futura (mais próximo)
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
