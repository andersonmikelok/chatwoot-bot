// lib/receitanet.js
// ✅ PRONTO para copiar e colar
// - rnFindClient agora faz "deep scan" no root e em contratos (até 3 níveis)
// - contratos pode ser array OU objeto { "0": {...}, "1": {...} }
// - se ainda não achar ID, faz LOG SEGURO (somente KEYS) para você enxergar o campo real
// - pickBestOverdueBoleto prioriza o mais recente e tenta ignorar pago/excluído
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
  const sl = s.toLowerCase();
  if (sl === "null" || sl === "undefined") return "";
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

    return Object.values(maybeArrayOrObj).filter(Boolean);
  }
  return [];
}

// ----------
// Deep scan
// ----------
const ID_KEY_RE = /(idcliente|clienteid|cliente_id|id_cliente|idcontrato|contratoid|contrato_id|id_contrato|codcliente|codigo_cliente|codcontrato|codigo_contrato|assinante_id|id_assinante|idassinante|idpessoa|pessoa_id)/i;

// evita capturar cpf/cnpj/telefone por engano
const BLOCK_KEY_RE = /(cpf|cnpj|documento|doc|telefone|celular|whatsapp|fone|rg)/i;

function isPlainObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function deepFindId(obj, maxDepth = 3) {
  const visited = new Set();

  function walk(node, depth) {
    if (!node || typeof node !== "object") return "";
    if (visited.has(node)) return "";
    visited.add(node);

    // arrays
    if (Array.isArray(node)) {
      for (const it of node) {
        const got = walk(it, depth);
        if (got) return got;
      }
      return "";
    }

    // objetos
    const keys = Object.keys(node);

    // 1) preferência: chaves "conhecidas"
    for (const k of keys) {
      if (BLOCK_KEY_RE.test(k)) continue;
      if (!ID_KEY_RE.test(k)) continue;
      const v = toId(node[k]);
      if (v) return v;
    }

    // 2) fallback: qualquer chave que contenha "id" (mas não bloqueadas)
    for (const k of keys) {
      if (BLOCK_KEY_RE.test(k)) continue;
      if (!/id/i.test(k)) continue;
      const v = toId(node[k]);
      if (v) return v;
    }

    // 3) desce nível (até maxDepth)
    if (depth >= maxDepth) return "";

    for (const k of keys) {
      const v = node[k];
      if (!v || typeof v !== "object") continue;
      const got = walk(v, depth + 1);
      if (got) return got;
    }

    return "";
  }

  return walk(obj, 0);
}

// LOG SEGURO: só keys (sem valores)
function safeKeys(x) {
  if (!x || typeof x !== "object") return [];
  try {
    return Object.keys(x);
  } catch {
    return [];
  }
}

function safeNestedKeys(x) {
  const out = {};
  if (!isPlainObject(x)) return out;
  for (const k of Object.keys(x)) {
    const v = x[k];
    if (isPlainObject(v)) out[k] = safeKeys(v);
  }
  return out;
}

function debugKeysWhenMissing({ where, root }) {
  try {
    const contratos = root?.contratos || root?.data?.contratos || root?.cliente?.contratos || null;
    const list = normalizeCollection(contratos);
    const c0 = list?.[0];

    console.log(`🧾 [RN][MISSING_ID] ${where} root keys:`, safeKeys(root || {}));
    if (contratos) {
      console.log(
        `🧾 [RN][MISSING_ID] ${where} contratos type:`,
        Array.isArray(contratos) ? `array(len=${contratos.length})` : typeof contratos
      );
    } else {
      console.log(`🧾 [RN][MISSING_ID] ${where} contratos: [NONE]`);
    }

    if (c0) {
      console.log(`🧾 [RN][MISSING_ID] ${where} contratos[0] keys:`, safeKeys(c0));
      const nested = safeNestedKeys(c0);
      const nestedKeys = Object.keys(nested);
      if (nestedKeys.length) {
        console.log(`🧾 [RN][MISSING_ID] ${where} contratos[0] nested object keys:`, nested);
      }
    } else {
      console.log(`🧾 [RN][MISSING_ID] ${where} contratos[0]: [NONE]`);
    }
  } catch (e) {
    console.log("🧾 [RN][MISSING_ID] erro ao logar keys:", String(e?.message || e));
  }
}

function normalizeClientData(respJson) {
  const raw = Array.isArray(respJson) ? respJson[0] : respJson;
  const root = raw && typeof raw === "object" ? raw : {};

  // 1) tenta idCliente direto
  let idCliente = toId(root.idCliente) || toId(root.idcliente) || toId(root.IdCliente) || "";

  // 2) se vier vazio/null/"0", tenta deep-scan no root
  if (!idCliente) {
    idCliente = deepFindId(root, 3);
  }

  // 3) se ainda vazio, tenta deep-scan em contratos especificamente (pode estar em estruturas diferentes)
  if (!idCliente) {
    const contratos = root?.contratos || root?.data?.contratos || root?.cliente?.contratos || null;
    const list = normalizeCollection(contratos);
    idCliente = deepFindId(list, 3);
  }

  // 4) log seguro se mesmo assim não encontrou (pra você ver o campo real no Render sem expor dados)
  if (!idCliente) {
    debugKeysWhenMissing({ where: "normalizeClientData", root });
  }

  return { ...root, idCliente };
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

  if (data?.success === false) return { found: false, status: resp.status, body: data };

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
