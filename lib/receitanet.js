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

export async function rnFindClient({ baseUrl, token, app, cpfcnpj, phone, idCliente }) {
  const resp = await rnPost({
    baseUrl,
    path: "/clientes",
    queryParams: { token, app, cpfcnpj, phone, idCliente },
  });

  if (resp.status === 404) return { found: false, status: 404, body: resp.json || resp.text };
  if (!resp.ok) throw new Error(`ReceitaNet /clientes falhou (${resp.status}): ${resp.text}`);

  const data = Array.isArray(resp.json) ? resp.json[0] : resp.json;
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
  const resp = await rnPost({
    baseUrl,
    path: "/notificacao-pagamento",
    queryParams: { token, app, idCliente, contato },
  });

  if (resp.status === 404) return { ok: false, status: 404, body: resp.json || resp.text, url: resp.url };
  if (!resp.ok) return { ok: false, status: resp.status, body: resp.json || resp.text, url: resp.url };

  return { ok: true, status: resp.status, data: resp.json, url: resp.url };
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
  const qrcode_pix = r.qrcode_pix || r.qrcodePix || r.pix || r.pix_copia_cola || r.copia_cola || r.qr_pix || "";
  const barras = r.barras || r.codigo_barras || r.linha_digitavel || r.linha || "";

  // Alguns ambientes retornam status/situação dentro do boleto (ou texto em campos extras)
  const statusText = String(
    r.status || r.situacao || r.situacao_boleto || r.estado || r.msg || ""
  ).toLowerCase();

  return { vencimento, valor, link, qrcode_pix, barras, _statusText: statusText };
}

function parseDateLoose(s) {
  const str = String(s || "").trim();
  if (!str) return null;

  const m1 = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m1) return new Date(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]), 12, 0, 0, 0);

  const m2 = str.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m2) return new Date(Number(m2[3]), Number(m2[2]) - 1, Number(m2[1]), 12, 0, 0, 0);

  return null;
}

function isBadBoletoStatus(statusText) {
  const t = String(statusText || "").toLowerCase();
  if (!t) return false;
  // Filtra baixado/pago/cancelado/excluído
  return (
    t.includes("baixad") ||
    t.includes("pago") ||
    t.includes("cancel") ||
    t.includes("exclu") ||
    t.includes("estorn") ||
    t.includes("inativ")
  );
}

/**
 * ✅ REGRA:
 * - Considera APENAS boletos com conteúdo (barras/PIX/link)
 * - Descarta boletos com status tipo baixado/cancelado/excluído (quando vier no payload)
 * - Escolhe o boleto com vencimento MAIS RECENTE
 */
export function pickBestOverdueBoleto(debitos) {
  if (!Array.isArray(debitos) || !debitos.length) return null;

  const all = [];

  for (const d of debitos) {
    const lista = normalizeBoletoCollection(d?.boletos);
    for (const b of lista) {
      const mapped = mapBoletoFields(b);
      if (isBadBoletoStatus(mapped._statusText)) continue;

      // precisa ter algo útil
      if (!mapped.link && !mapped.qrcode_pix && !mapped.barras) continue;

      const dt = parseDateLoose(mapped.vencimento);
      all.push({
        ...mapped,
        _venc_dt: dt ? dt.getTime() : 0,
        debito_id: d?.id || "",
      });
    }
  }

  if (!all.length) return null;

  // vencimento mais recente primeiro
  all.sort((a, b) => (b._venc_dt || 0) - (a._venc_dt || 0));

  // preferir quem tem barras (melhor pra conferir comprovante)
  const withBarras = all.find((x) => String(x.barras || "").trim().length >= 40);
  return withBarras || all[0];
}
