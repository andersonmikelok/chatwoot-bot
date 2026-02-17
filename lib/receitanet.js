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

function normStr(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function toBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (v === 1 || v === 0) return v === 1;
  const s = normStr(v);
  if (!s) return false;
  if (["1", "true", "t", "yes", "y", "sim", "s"].includes(s)) return true;
  if (["0", "false", "f", "no", "n", "nao", "não"].includes(s)) return false;
  return false;
}

// 🔥 tokens que indicam boleto NÃO pendente
const PAID_TOKENS = ["baixad", "pago", "quitad", "liquidad", "compensad"];
const CANCEL_TOKENS = ["cancel", "estorn", "inativ"];

// varre texto em campos comuns + deep scan leve
function deepHasTokens(obj, tokens, maxDepth = 5) {
  const seen = new Set();

  function walk(x, depth) {
    if (depth > maxDepth) return false;
    if (x === null || x === undefined) return false;

    const t = typeof x;
    if (t === "string" || t === "number" || t === "boolean") {
      const s = normStr(x);
      if (!s) return false;

      // cuidado com negações tipo "nao baixado"
      if (s.includes("nao baixad") || s.includes("não baixad")) return false;
      if (s.includes("nao pago") || s.includes("não pago")) return false;

      return tokens.some((tok) => s.includes(tok));
    }

    if (t !== "object") return false;
    if (seen.has(x)) return false;
    seen.add(x);

    if (Array.isArray(x)) {
      for (const it of x) if (walk(it, depth + 1)) return true;
      return false;
    }

    for (const [k, v] of Object.entries(x)) {
      if (walk(k, depth + 1)) return true;
      if (walk(v, depth + 1)) return true;
    }
    return false;
  }

  return walk(obj, 0);
}

function isBoletoNonPending(raw) {
  const r = raw && typeof raw === "object" ? raw : {};

  const statusText =
    r.status_text ||
    r.statusText ||
    r.status ||
    r.situacao ||
    r.sit ||
    r.estado ||
    r.mensagem ||
    r.message ||
    "";

  // flags comuns
  const baixadoFlag = toBool(r.baixado) || toBool(r.pago) || toBool(r.quitado) || toBool(r.liquidado);
  if (baixadoFlag) return true;

  // status numérico (algumas APIs: 1=baixado, 0=pendente)
  if (typeof r.status === "number" && r.status !== 0) return true;
  if (typeof r.status === "string") {
    const s = normStr(r.status);
    if (s && s !== "0" && s !== "pendente" && s !== "aberto" && s !== "em aberto") {
      // se vier "baixado"/"pago"/etc
      if (PAID_TOKENS.some((t) => s.includes(t)) || CANCEL_TOKENS.some((t) => s.includes(t))) return true;
    }
  }

  const st = normStr(statusText);
  if (PAID_TOKENS.some((t) => st.includes(t))) return true;
  if (CANCEL_TOKENS.some((t) => st.includes(t))) return true;

  // deep scan (pega campos escondidos tipo "situacao: Baixado")
  if (deepHasTokens(r, PAID_TOKENS)) return true;
  if (deepHasTokens(r, CANCEL_TOKENS)) return true;

  return false;
}

function mapBoletoFields(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const vencimento = r.vencimento || r.data_vencimento || r.dt_vencimento || r.vcto || "";
  const valor = r.valor ?? r.valor_boleto ?? r.vlr ?? r.total ?? "";
  const link = r.link || r.url || r.boleto_link || r.link_boleto || r.url_boleto || "";
  const qrcode_pix = r.qrcode_pix || r.pix || r.pix_copia_cola || r.copia_cola || r.qr_pix || "";
  const barras = r.barras || r.codigo_barras || r.linha_digitavel || r.linha || "";
  const pdf = r.pdf || r.pdf_url || r.url_pdf || r.boleto_pdf || "";

  const statusText =
    r.status_text ||
    r.statusText ||
    r.status ||
    r.situacao ||
    r.sit ||
    r.estado ||
    "";

  return { vencimento, valor, link, qrcode_pix, barras, pdf, statusText, _raw: r };
}

function parseDateSafe(s) {
  const t = String(s || "").trim();

  // YYYY-MM-DD
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
  }

  // DD/MM/YYYY
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
  }

  return null;
}

/**
 * ✅ Regra corrigida:
 * 1) Considera SOMENTE boletos "pendentes" (filtra Baixado/Pago/Quitado/Liquidado/Cancelado)
 * 2) Se houver vencidos: pega o VENCIDO MAIS ANTIGO (menor vencimento) entre pendentes
 * 3) Se não houver vencidos: pega o mais próximo futuro (menor vencimento) entre pendentes
 * 4) Se não der pra parsear data: pega primeiro com conteúdo (link/pix/barras/pdf)
 */
export function pickBestOverdueBoleto(debitos) {
  if (!Array.isArray(debitos) || !debitos.length) return { boleto: null, overdueCount: 0 };

  const all = [];
  for (const d of debitos) {
    const lista = normalizeBoletoCollection(d?.boletos);
    for (const b of lista) {
      const mapped = mapBoletoFields(b);

      // ✅ FILTRO: ignora boletos baixados/pagos/cancelados
      if (isBoletoNonPending(mapped._raw)) continue;

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
      const dt = parseDateSafe(b.vencimento);
      return { ...b, _dt: dt };
    })
    .filter((b) => b._dt);

  if (!withDates.length) {
    const withContent = all.find((b) => b.link || b.qrcode_pix || b.barras || b.pdf);
    return { boleto: withContent || all[0], overdueCount: 0 };
  }

  const overdue = withDates.filter((b) => b._dt < todayUTC);
  const overdueCount = overdue.length;

  if (overdueCount > 0) {
    overdue.sort((a, b) => a._dt - b._dt); // vencido mais antigo
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