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

async function rnPostForm({ baseUrl, path, formData }) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, { method: "POST", body: formData });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: res.ok, status: res.status, json, text, url };
}

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

  const qrcode_pix = r.qrcode_pix || r.qrcodePix || r.pix || r.pix_copia_cola || r.copia_cola || r.qr_pix || "";

  const barras = r.barras || r.codigo_barras || r.linha_digitavel || r.linha || "";

  const pdf = r.pdf || r.pdf_url || r.url_pdf || r.boleto_pdf || "";

  return { vencimento, valor, link, qrcode_pix, barras, pdf };
}

function parseDateAny(s) {
  const t = String(s || "").trim();
  if (!t) return null;

  // tenta YYYY-MM-DD
  const m1 = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m1) {
    const d = new Date(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // tenta DD/MM/YYYY
  const m2 = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m2) {
    const d = new Date(Number(m2[3]), Number(m2[2]) - 1, Number(m2[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function getIdClienteFromClientData(data) {
  const d = data && typeof data === "object" ? data : {};

  const direct =
    d.idCliente ??
    d.idcliente ??
    d.IdCliente ??
    d.id ??
    d.cliente_id ??
    d.clienteId ??
    d?.cliente?.idCliente ??
    null;

  if (direct !== null && direct !== undefined && String(direct).trim() !== "") return String(direct).trim();

  const c0 = Array.isArray(d.contratos) ? d.contratos[0] : null;
  const fromContrato =
    c0?.idCliente ??
    c0?.idcliente ??
    c0?.IdCliente ??
    c0?.cliente_id ??
    c0?.clienteId ??
    c0?.id ??
    null;

  if (fromContrato !== null && fromContrato !== undefined && String(fromContrato).trim() !== "")
    return String(fromContrato).trim();

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

  const data = Array.isArray(resp.json) ? resp.json[0] : resp.json;
  const idCli = getIdClienteFromClientData(data);

  // garante que o idCliente fique acessível no topo
  const normalized = { ...(data || {}) };
  if (idCli) normalized.idCliente = idCli;

  return { found: true, status: resp.status, data: normalized };
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
  const fd = new FormData();
  fd.append("token", String(token || ""));
  fd.append("app", String(app || "chatbot"));
  fd.append("idCliente", String(idCliente || ""));
  fd.append("contato", String(contato || ""));

  const resp = await rnPostForm({
    baseUrl,
    path: "/notificacao-pagamento",
    formData: fd,
  });

  if (resp.status === 404) return { ok: false, status: 404, body: resp.json || resp.text };
  if (!resp.ok) return { ok: false, status: resp.status, body: resp.json || resp.text, text: resp.text };

  return { ok: true, status: resp.status, data: resp.json };
}

/**
 * Regra do boleto:
 * - Se existir vencido: escolhe o vencido MAIS ANTIGO
 * - Se não existir vencido: escolhe o vigente MAIS PRÓXIMO (menor data >= hoje)
 * - Também retorna contagem de vencidos
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
        nome: d?.nome || "",
        debito_id: d?.id || "",
        _vdate: parseDateAny(mapped.vencimento),
      });
    }
  }

  if (!all.length) return { boleto: null, overdueCount: 0 };

  const today = startOfToday();

  const overdue = all
    .filter((x) => x._vdate && x._vdate < today)
    .sort((a, b) => a._vdate - b._vdate); // MAIS ANTIGO primeiro

  const upcoming = all
    .filter((x) => x._vdate && x._vdate >= today)
    .sort((a, b) => a._vdate - b._vdate); // mais próximo primeiro

  const chosen = overdue.length ? overdue[0] : upcoming.length ? upcoming[0] : all[0];

  // remove helper
  const { _vdate, ...boleto } = chosen;

  return { boleto, overdueCount: overdue.length };
}

export function formatBoletoWhatsApp(b) {
  const parts = [];
  parts.push("📄 *Boleto em aberto*");
  if (b.vencimento) parts.push(`🗓️ *Vencimento:* ${b.vencimento}`);
  if (b.valor !== undefined && b.valor !== null && String(b.valor).trim() !== "") {
    parts.push(`💰 *Valor:* R$ ${String(b.valor).replace(".", ",")}`);
  }
  if (b.link) parts.push(`🔗 *Link do boleto:*\n${b.link}`);
  if (b.barras) parts.push(`🏷️ *Código de barras:*\n${b.barras}`);
  if (b.qrcode_pix) parts.push(`📌 *PIX copia e cola:*\n${b.qrcode_pix}`);
  if (b.pdf) parts.push(`📎 *PDF:*\n${b.pdf}`);
  return parts.join("\n");
}