// lib/receitanet.js

function q(params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    usp.set(k, String(v));
  }
  return usp.toString();
}

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

function normalizeArrayLike(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.filter(Boolean);
  if (typeof x === "object") {
    const keys = Object.keys(x).filter(isNumericKey).sort((a, b) => Number(a) - Number(b));
    if (keys.length) return keys.map((k) => x[k]).filter(Boolean);
    return Object.values(x).filter(Boolean);
  }
  return [];
}

function pickIdClienteFromObject(o) {
  if (!o || typeof o !== "object") return "";

  const candidates = [
    o.idCliente,
    o.idcliente,
    o.IdCliente,
    o.id_cliente,
    o.cliente_id,
    o.clienteId,
    o.id, // em alguns retornos vem "id"
  ];

  for (const c of candidates) {
    const s = String(c ?? "").trim();
    if (s && s !== "0" && s.toLowerCase() !== "null" && s.toLowerCase() !== "undefined") return s;
  }

  // Algumas estruturas colocam o id dentro de "cliente"
  const nested = [
    o?.cliente?.idCliente,
    o?.cliente?.idcliente,
    o?.cliente?.id_cliente,
    o?.cliente?.id,
  ];
  for (const c of nested) {
    const s = String(c ?? "").trim();
    if (s && s !== "0" && s.toLowerCase() !== "null" && s.toLowerCase() !== "undefined") return s;
  }

  return "";
}

function pickIdClienteFromPayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};

  // topo
  let id = pickIdClienteFromObject(p);
  if (id) return id;

  // contratos pode vir como array OU objeto numérico
  const contratos = normalizeArrayLike(p.contratos);
  for (const c of contratos) {
    id = pickIdClienteFromObject(c);
    if (id) return id;

    // às vezes o contrato guarda cliente dentro
    id = pickIdClienteFromObject(c?.cliente);
    if (id) return id;

    // variações mais comuns
    const more = [
      c?.idClienteContrato,
      c?.id_contrato_cliente,
      c?.contrato?.idCliente,
      c?.contrato?.idcliente,
      c?.contrato?.id_cliente,
      c?.contrato?.cliente_id,
      c?.contrato?.clienteId,
    ];
    for (const v of more) {
      const s = String(v ?? "").trim();
      if (s && s !== "0") return s;
    }
  }

  // algumas vezes vem dentro de "data"
  id = pickIdClienteFromObject(p.data);
  if (id) return id;

  return "";
}

function pickIdClienteFromDebitos(debitos) {
  if (!Array.isArray(debitos)) return "";
  for (const d of debitos) {
    if (!d || typeof d !== "object") continue;

    let id =
      pickIdClienteFromObject(d) ||
      pickIdClienteFromObject(d?.cliente) ||
      pickIdClienteFromObject(d?.contrato) ||
      pickIdClienteFromObject(d?.contratos);

    if (id) return id;

    // às vezes aparece como campos específicos no débito
    const more = [d?.idCliente, d?.idcliente, d?.cliente_id, d?.clienteId, d?.id_cliente];
    for (const v of more) {
      const s = String(v ?? "").trim();
      if (s && s !== "0") return s;
    }
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

  // pode vir objeto ou array
  const dataRaw = Array.isArray(resp.json) ? resp.json[0] : resp.json;

  // tenta extrair idCliente do payload de clientes
  let idCli = pickIdClienteFromPayload(dataRaw);

  // ✅ FALLBACK: se não veio idCliente, tenta extrair via /debitos
  if (!idCli && cpfcnpj) {
    try {
      const deb = await rnPost({
        baseUrl,
        path: "/debitos",
        queryParams: { token, app, cpfcnpj, status: 0 },
      });

      if (deb.ok) {
        const arr = Array.isArray(deb.json) ? deb.json : Array.isArray(deb.json?.data) ? deb.json.data : [];
        idCli = pickIdClienteFromDebitos(arr);
      }
    } catch {}
  }

  const data = { ...(dataRaw || {}), idCliente: idCli || "" };

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

  if (!resp.ok) return { ok: false, status: resp.status, data: resp.json || null, text: resp.text };
  return { ok: true, status: resp.status, data: resp.json || null };
}

// ---------------------
// BOLETOS
// ---------------------

function normalizeBoletoCollection(boletos) {
  return normalizeArrayLike(boletos);
}

function parseDateAny(s) {
  const t = String(s || "").trim();
  if (!t) return null;

  const m1 = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m1) {
    const d = new Date(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

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
 * Regra:
 * - Lote atual = maior emissão (janela 10 dias)
 * - Se existir vencido -> pega o vencido MAIS ANTIGO
 * - Se não existir vencido -> pega o vigente mais próximo
 */
export function pickBestOverdueBoleto(debitos) {
  if (!Array.isArray(debitos) || !debitos.length) return { boleto: null, overdueCount: 0 };

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

  const cleaned = all.filter((x) => {
    const st = (x.status || "").toLowerCase();
    if (!st) return true;
    if (st.includes("baix")) return false;
    if (st.includes("pago")) return false;
    if (st.includes("cancel")) return false;
    return true;
  });

  const list = cleaned.length ? cleaned : all;

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

  const overdue = scoped
    .filter((x) => x._vdate && x._vdate < today)
    .sort((a, b) => a._vdate - b._vdate);

  const upcoming = scoped
    .filter((x) => x._vdate && x._vdate >= today)
    .sort((a, b) => a._vdate - b._vdate);

  const chosen = overdue.length ? overdue[0] : upcoming.length ? upcoming[0] : scoped[0];

  const { _vdate, _edate, ...boleto } = chosen;

  return { boleto, overdueCount: overdue.length };
}