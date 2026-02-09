// lib/receitanet.js
// ✅ PRONTO para copiar e colar
// - rnFindClient agora encontra idCliente OU cai para idContrato (quando idCliente vem vazio)
// - contratos pode vir como array OU objeto { "0": {...}, "1": {...} }
// - pickBestOverdueBoleto pega o boleto mais recente e ignora pago/excluído quando identificar
// - rnNotificacaoPagamento incluído

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

// ---------------------
// Helpers: normalização id (cliente/contrato)
// ---------------------
function toId(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  if (!s) return "";
  if (s === "0") return "";
  if (s.toLowerCase() === "null" || s.toLowerCase() === "undefined") return "";
  return s;
}

function isNumericKey(k) {
  return /^[0-9]+$/.test(String(k));
}

function normalizeCollection(maybeArrayOrObj) {
  if (!maybeArrayOrObj) return [];
  if (Array.isArray(maybeArrayOrObj)) return maybeArrayOrObj.filter(Boolean);

  if (typeof maybeArrayOrObj === "object") {
    // caso { "0": {...}, "1": {...} }
    const keys = Object.keys(maybeArrayOrObj)
      .filter(isNumericKey)
      .sort((a, b) => Number(a) - Number(b));
    if (keys.length) return keys.map((k) => maybeArrayOrObj[k]).filter(Boolean);

    // fallback: valores
    return Object.values(maybeArrayOrObj).filter(Boolean);
  }
  return [];
}

function findAnyIdShallow(obj) {
  const o = obj && typeof obj === "object" ? obj : {};

  // ✅ primeiro: idCliente (quando vier válido)
  const idCliente =
    toId(o.idCliente) ||
    toId(o.idcliente) ||
    toId(o.IdCliente) ||
    toId(o.cliente_id) ||
    toId(o.clienteId) ||
    toId(o.codCliente) ||
    toId(o.codcliente) ||
    toId(o.codigo_cliente) ||
    "";

  if (idCliente) return idCliente;

  // ✅ fallback MUITO comum no ReceitaNet: ID DO CONTRATO
  const idContrato =
    toId(o.idContrato) ||
    toId(o.idcontrato) ||
    toId(o.IdContrato) ||
    toId(o.id_contrato) ||
    toId(o.contrato_id) ||
    toId(o.contratoId) ||
    toId(o.codContrato) ||
    toId(o.codigo_contrato) ||
    "";

  if (idContrato) return idContrato;

  // outros possíveis
  return (
    toId(o.id) ||
    toId(o.customer_id) ||
    toId(o.customerId) ||
    toId(o.assinante_id) ||
    toId(o.idAssinante) ||
    toId(o.id_assinante) ||
    toId(o.pessoa_id) ||
    toId(o.idPessoa) ||
    toId(o.idpessoa) ||
    ""
  );
}

function findAnyId(obj) {
  const direct = findAnyIdShallow(obj);
  if (direct) return direct;

  const o = obj && typeof obj === "object" ? obj : {};
  // 1 nível de aninhamento comum
  const nested = [o.cliente, o.assinante, o.pessoa, o.titular, o.contrato];
  for (const n of nested) {
    const nid = findAnyIdShallow(n);
    if (nid) return nid;
  }
  return "";
}

function pickIdFromContratos(root) {
  const contratos =
    root?.contratos ||
    root?.data?.contratos ||
    root?.cliente?.contratos ||
    root?.result?.contratos ||
    root?.payload?.contratos ||
    null;

  const list = normalizeCollection(contratos);
  if (!list.length) return "";

  for (const c of list) {
    const id = findAnyId(c);
    if (id) return id;
  }
  return "";
}

function normalizeClientData(respJson) {
  const raw = Array.isArray(respJson) ? respJson[0] : respJson;
  const r = raw && typeof raw === "object" ? raw : {};

  // tenta idCliente direto
  let idCliente =
    toId(r.idCliente) ||
    toId(r.idcliente) ||
    toId(r.IdCliente) ||
    toId(r.cliente_id) ||
    toId(r.clienteId) ||
    toId(r?.cliente?.idCliente) ||
    "";

  // se vier vazio/null/"0", pega do primeiro contrato (idCliente ou idContrato)
  if (!idCliente) {
    idCliente = pickIdFromContratos(r);
  }

  return { ...r, idCliente };
}

// ---------------------
// API: clientes / débitos / acesso / notificação
// ---------------------
export async function rnFindClient({ baseUrl, token, app, cpfcnpj, phone, idCliente }) {
  const resp = await rnPost({
    baseUrl,
    path: "/clientes",
    queryParams: { token, app, cpfcnpj, phone, idCliente },
  });

  if (resp.status === 404) return { found: false, status: 404, body: resp.json || resp.text };
  if (!resp.ok) throw new Error(`ReceitaNet /clientes falhou (${resp.status}): ${resp.text}`);

  const data = normalizeClientData(resp.json);

  // alguns retornos vêm com success=false
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
function normalizeBoletoCollection(boletos) {
  return normalizeCollection(boletos);
}

function mapBoletoFields(raw) {
  const r = raw && typeof raw === "object" ? raw : {};

  const vencimento = r.vencimento || r.data_vencimento || r.dt_vencimento || r.vcto || "";
  const valor = r.valor ?? r.valor_boleto ?? r.vlr ?? r.total ?? "";
  const link = r.link || r.url || r.boleto_link || r.link_boleto || r.url_boleto || "";
  const qrcode_pix = r.qrcode_pix || r.pix || r.pix_copia_cola || r.copia_cola || r.qr_pix || "";
  const barras = r.barras || r.codigo_barras || r.linha_digitavel || r.linha || "";
  const pdf = r.pdf || r.pdf_url || r.url_pdf || r.boleto_pdf || "";

  const status = r.status ?? r.situacao ?? r.sit ?? r.estado ?? "";
  const pago = r.pago ?? r.pagamento ?? r.is_pago ?? r.paid ?? false;
  const excluido = r.excluido ?? r.cancelado ?? r.deleted ?? r.removido ?? false;

  return { vencimento, valor, link, qrcode_pix, barras, pdf, status, pago, excluido };
}

function looksPaidOrDeleted(b) {
  const s = String(b?.status || "").toLowerCase();
  if (b?.pago === true) return true;
  if (b?.excluido === true) return true;
  if (s.includes("pago") || s.includes("baix") || s.includes("liquid")) return true;
  if (s.includes("exclu") || s.includes("cancel") || s.includes("remov")) return true;
  return false;
}

function parseDateMs(v) {
  const s = String(v || "").trim();
  if (!s) return 0;

  const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m1) return new Date(`${m1[1]}-${m1[2]}-${m1[3]}T00:00:00Z`).getTime();

  const m2 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m2) return new Date(`${m2[3]}-${m2[2]}-${m2[1]}T00:00:00Z`).getTime();

  return 0;
}

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

  const notPaid = all.filter((b) => !looksPaidOrDeleted(b));
  const pool = notPaid.length ? notPaid : all;

  const withContent = pool.filter((b) => b.link || b.qrcode_pix || b.barras || b.pdf);
  const base = withContent.length ? withContent : pool;

  const sorted = base.slice().sort((a, b) => parseDateMs(b.vencimento) - parseDateMs(a.vencimento));
  return sorted[0] || base[0] || null;
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
