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

function mapBoletoFields(raw) {
  const r = raw && typeof raw === "object" ? raw : {};

  const vencimento =
    r.vencimento ||
    r.data_vencimento ||
    r.dt_vencimento ||
    r.vcto ||
    r.due_date ||
    "";

  const valor = r.valor ?? r.valor_boleto ?? r.vlr ?? r.total ?? r.amount ?? "";

  const link = r.link || r.url || r.boleto_link || r.link_boleto || r.url_boleto || "";
  const qrcode_pix = r.qrcode_pix || r.pix || r.pix_copia_cola || r.copia_cola || r.qr_pix || "";
  const barras = r.barras || r.codigo_barras || r.linha_digitavel || r.linha || "";
  const pdf = r.pdf || r.pdf_url || r.url_pdf || r.boleto_pdf || "";

  // ✅ status/situação (pra filtrar baixado/pago)
  const statusRaw =
    r.status ||
    r.situacao ||
    r.sit ||
    r.estado ||
    r.state ||
    r.pagamento_status ||
    "";

  return { vencimento, valor, link, qrcode_pix, barras, pdf, status: statusRaw };
}

function isPaidOrClosedStatus(statusRaw) {
  const s = normStr(statusRaw);
  if (!s) return false;

  // cobre "Baixado", "Pago", "Liquidado", "Cancelado"
  if (s.includes("baix")) return true;
  if (s.includes("pag")) return true;
  if (s.includes("liquid")) return true;
  if (s.includes("cancel")) return true;
  if (s.includes("estornado")) return true;

  return false;
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
 * Regra correta p/ seu caso:
 * - considerar SOMENTE boletos pendentes (exclui baixado/pago/cancelado)
 * - se existir pendente vencido: pega o MAIS ANTIGO (menor vencimento)
 * - senão: pega o pendente futuro MAIS PRÓXIMO (menor vencimento futuro)
 */
export function pickBestOverdueBoleto(debitos) {
  if (!Array.isArray(debitos) || !debitos.length) return { boleto: null, overdueCount: 0 };

  const all = [];

  for (const d of debitos) {
    // ReceitaNet costuma colocar boletos em d.boletos
    const lista = normalizeBoletoCollection(d?.boletos);

    for (const b of lista) {
      const mapped = mapBoletoFields(b);
      all.push({
        ...mapped,
        debito_id: d?.id || d?.idDebito || "",
        nome: d?.nome || d?.descricao || "",
      });
    }

    // ✅ fallback: às vezes o "debito" já vem com cara de boleto
    // (se não vier em d.boletos)
    if (!lista.length) {
      const mappedD = mapBoletoFields(d);
      const hasAny = mappedD.link || mappedD.qrcode_pix || mappedD.barras || mappedD.pdf || mappedD.vencimento;
      if (hasAny) {
        all.push({
          ...mappedD,
          debito_id: d?.id || d?.idDebito || "",
          nome: d?.nome || d?.descricao || "",
        });
      }
    }
  }

  if (!all.length) return { boleto: null, overdueCount: 0 };

  // ✅ filtra só pendentes (remove baixados/pagos)
  const pending = all.filter((b) => !isPaidOrClosedStatus(b.status));
  if (!pending.length) return { boleto: null, overdueCount: 0 };

  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));

  const withDates = pending
    .map((b) => {
      const dt = parseDateSafe(b.vencimento);
      return { ...b, _dt: dt };
    })
    .filter((b) => b._dt);

  // se não tiver datas parseáveis, tenta pelo que tiver conteúdo
  if (!withDates.length) {
    const withContent = pending.find((b) => b.link || b.qrcode_pix || b.barras || b.pdf);
    return { boleto: withContent || pending[0], overdueCount: 0 };
  }

  const overdue = withDates.filter((b) => b._dt < todayUTC);
  const overdueCount = overdue.length;

  if (overdueCount > 0) {
    overdue.sort((a, b) => a._dt - b._dt); // mais antigo primeiro
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
