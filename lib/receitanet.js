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
 * POST /clientes  (query: token, app, cpfcnpj, phone, idCliente)
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

function pickIdClienteFromPayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};

  // 1) no topo
  if (p.idCliente) return String(p.idCliente).trim();
  if (p.idcliente) return String(p.idcliente).trim();
  if (p.IdCliente) return String(p.IdCliente).trim();
  if (p.id) return String(p.id).trim();

  // 2) dentro de contratos
  const c0 = Array.isArray(p.contratos) ? p.contratos[0] : null;
  if (c0) {
    if (c0.idCliente) return String(c0.idCliente).trim();
    if (c0.idcliente) return String(c0.idcliente).trim();
    if (c0.IdCliente) return String(c0.IdCliente).trim();
    if (c0.id) return String(c0.id).trim();
    if (c0.cliente?.idCliente) return String(c0.cliente.idCliente).trim();
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
  const dataRaw = Array.isArray(resp.json) ? resp.json[0] : resp.json;

  const idCli = pickIdClienteFromPayload(dataRaw);
  const data = { ...(dataRaw || {}), idCliente: idCli || dataRaw?.idCliente || "" };

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

  // a doc mostra 200 mesmo em erro ("excedida"/"erro na liberação")
  if (!resp.ok) return { ok: false, status: resp.status, data: resp.json || null, text: resp.text };

  return { ok: true, status: resp.status, data: resp.json || null };
}

// ---------------------
// BOLETOS: normalização
// ---------------------

function isNumericKey(k) {
  return /^[0-9]+$/.test(String(k));
}

/**
 * Boletos podem vir como objeto com keys "0","1","2"... (ou pode vir array).
 * Converte para array ordenado por índice.
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

function parseDateAny(s) {
  const t = String(s || "").trim();
  if (!t) return null;

  // YYYY-MM-DD
  const m1 = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m1) {
    const d = new Date(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/YYYY
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

/**
 * Mapeia campos padrão da doc do ReceitaNet
 * (e mantém fallbacks)
 */
function mapBoletoFields(raw) {
  const r = raw && typeof raw === "object" ? raw : {};

  const vencimento = r.vencimento || r.data_vencimento || r.dt_vencimento || r.vcto || "";
  const emissao = r.emissao || r.data_emissao || r.dt_emissao || r.emitted_at || "";

  const valor = r.valor ?? r.valor_boleto ?? r.vlr ?? r.total ?? "";
  const link = r.link || r.url || r.boleto_link || r.link_boleto || r.url_boleto || "";
  const qrcode_pix = r.qrcode_pix || r.qrcodePix || r.pix || r.pix_copia_cola || r.copia_cola || r.qr_pix || "";
  const barras = r.barras || r.codigo_barras || r.linha_digitavel || r.linha || "";
  const pdf = r.pdf || r.pdf_url || r.url_pdf || r.boleto_pdf || "";

  const status = (r.status || r.situacao || r.state || "").toString();

  return { vencimento, emissao, valor, link, qrcode_pix, barras, pdf, status };
}

/**
 * ✅ REGRA FINAL (do jeito que você pediu):
 * 1) Trabalhar apenas no "lote atual" -> lote = maior data de emissão (com janela pequena).
 * 2) Dentro do lote:
 *    - se existir vencido -> pega o VENCIDO MAIS ANTIGO
 *    - se não existir vencido -> pega o VIGENTE mais próximo
 * 3) Retorna também overdueCount para mensagem do Portal.
 */
export function pickBestOverdueBoleto(debitos) {
  if (!Array.isArray(debitos) || !debitos.length) return { boleto: null, overdueCount: 0 };

  // Flatten boletos
  const all = [];
  for (const d of debitos) {
    const lista = normalizeBoletoCollection(d?.boletos);
    for (const b of lista) {
      const m = mapBoletoFields(b);
      all.push({
        ...m,
        debito_id: d?.id || "",
        _vdate: parseDateAny(m.vencimento),
        _edate: parseDateAny(m.emissao),
      });
    }
  }

  if (!all.length) return { boleto: null, overdueCount: 0 };

  // Remove "baixado/pago/cancel" se vier marcado
  const cleaned = all.filter((x) => {
    const st = (x.status || "").toLowerCase();
    if (!st) return true;
    if (st.includes("baix")) return false;
    if (st.includes("pago")) return false;
    if (st.includes("cancel")) return false;
    return true;
  });

  const list = cleaned.length ? cleaned : all;

  // Define lote atual pelo MAIOR emissao (janela 10 dias)
  const withEmissao = list.filter((x) => x._edate instanceof Date && !Number.isNaN(x._edate.getTime()));
  let scoped = list;

  if (withEmissao.length) {
    const maxEmissao = withEmissao.reduce((acc, x) => (x._edate > acc ? x._edate : acc), withEmissao[0]._edate);
    const windowDays = 10;
    const minEmissao = new Date(maxEmissao.getTime() - windowDays * 24 * 60 * 60 * 1000);

    scoped = list.filter((x) => x._edate && x._edate >= minEmissao && x._edate <= maxEmissao);
    if (!scoped.length) scoped = list;
  }

  const today = startOfToday();

  // vencidos dentro do lote -> MAIS ANTIGO
  const overdue = scoped
    .filter((x) => x._vdate && x._vdate < today)
    .sort((a, b) => a._vdate - b._vdate);

  // vigentes dentro do lote -> mais próximo
  const upcoming = scoped
    .filter((x) => x._vdate && x._vdate >= today)
    .sort((a, b) => a._vdate - b._vdate);

  const chosen = overdue.length ? overdue[0] : upcoming.length ? upcoming[0] : scoped[0];

  const { _vdate, _edate, ...boleto } = chosen;

  return { boleto, overdueCount: overdue.length };
}