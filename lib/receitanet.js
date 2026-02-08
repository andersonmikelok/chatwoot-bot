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

export async function rnFindClient({ baseUrl, token, app, cpfcnpj, phone, idCliente }) {
  const resp = await rnPost({
    baseUrl,
    path: "/clientes",
    queryParams: { token, app, cpfcnpj, phone, idCliente },
  });

  if (resp.status === 404) return { found: false, status: 404, body: resp.json || resp.text };
  if (!resp.ok) throw new Error(`ReceitaNet /clientes falhou (${resp.status}): ${resp.text}`);

  // às vezes vem objeto, às vezes array (depende da implementação)
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

/**
 * Debitos vêm com boletos:
 * item.boletos = { vencimento, valor, link, qrcode_pix, barras }
 */
export function pickBestOverdueBoleto(debitos) {
  if (!Array.isArray(debitos) || !debitos.length) return null;

  // pega o primeiro que tiver boletos
  const withBoleto = debitos
    .map((d) => {
      const b = d?.boletos;
      if (!b) return null;
      return {
        vencimento: b.vencimento || "",
        valor: b.valor,
        link: b.link || "",
        qrcode_pix: b.qrcode_pix || "",
        barras: b.barras || "",
        nome: d?.nome || "",
        telefone1: d?.telefone1 || "",
      };
    })
    .filter(Boolean);

  if (!withBoleto.length) return null;

  // regra simples: retorna o primeiro
  return withBoleto[0];
}

export function formatBoletoWhatsApp(b) {
  const parts = [];
  parts.push("📄 *Boleto em aberto*");
  if (b.vencimento) parts.push(`🗓️ *Vencimento:* ${b.vencimento}`);
  if (typeof b.valor === "number") parts.push(`💰 *Valor:* R$ ${b.valor.toFixed(2)}`);
  if (b.link) parts.push(`🔗 *Link do boleto:* ${b.link}`);
  if (b.qrcode_pix) parts.push(`📌 *QR/PIX:* ${b.qrcode_pix}`);
  if (b.barras) parts.push(`🏷️ *Código de barras:* ${b.barras}`);
  return parts.join("\n");
}
