// biblioteca/utils.js
export function normalizeText(s) {
  return (s || "").toString().trim();
}

export function onlyDigits(s) {
  return (s || "").toString().replace(/\D+/g, "");
}

export function looksLikeCPFOrCNPJ(text) {
  const d = onlyDigits(text);
  return d.length === 11 || d.length === 14;
}

export function normalizePhoneForReceita(raw) {
  let digits = onlyDigits(raw);
  if (!digits) return "";
  // remove DDI 55 se vier
  if (digits.startsWith("55") && digits.length >= 12) digits = digits.slice(2);
  return digits;
}

export function isYes(text) {
  const t = normalizeText(text).toLowerCase();
  return ["sim", "s", "claro", "isso", "sou", "confirmo", "ok"].includes(t);
}

export function isNo(text) {
  const t = normalizeText(text).toLowerCase();
  return ["nao", "não", "n", "negativo"].includes(t);
}

// Se o usuário mandar "1/2/3" no WhatsApp, interpretamos como intenção.
export function mapNumericMenu(text) {
  const t = normalizeText(text);
  if (t === "1") return "suporte";
  if (t === "2") return "financeiro";
  if (t === "3") return "vendas";
  return "";
}

export function isConnectivityIssue(text) {
  const t = normalizeText(text).toLowerCase();
  return (
    t.includes("sem internet") ||
    t.includes("sem sinal") ||
    t.includes("sem conexão") ||
    t.includes("sem conexao") ||
    t.includes("caiu") ||
    t.includes("queda") ||
    t.includes("lento") ||
    t.includes("lentidão") ||
    t.includes("lentidao")
  );
}

export function parseProofOrBoleto(text) {
  const t = normalizeText(text).toLowerCase();
  const mentionsBoleto =
    t.includes("boleto") || t.includes("2ª via") || t.includes("2a via") || t.includes("fatura") || t.includes("vencido");
  const mentionsProof = t.includes("comprov") || t.includes("paguei") || t.includes("pagamento") || t.includes("pago");

  const mentionsBarcode = t.includes("código de barras") || t.includes("codigo de barras") || t.includes("barras");
  const mentionsPix = t.includes("pix") || t.includes("qr") || t.includes("qrcode") || t.includes("qr code");

  return { mentionsBoleto, mentionsProof, mentionsBarcode, mentionsPix };
}
