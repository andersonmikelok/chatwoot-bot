// lib/openai.js
// Exports:
// - openaiChat({ apiKey, model, system, user, maxTokens })
// - openaiAnalyzeImage({ apiKey, model, imageDataUrl })

function pickOutputText(json) {
  return (
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    json?.choices?.[0]?.message?.content ||
    ""
  );
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function stripCodeFences(s) {
  return String(s || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function onlyDigits(s) {
  return String(s || "").replace(/\D+/g, "");
}

function pickCpfCnpjDigitsFromText(text) {
  const d = onlyDigits(text);
  // tenta achar 14 ou 11 dentro do texto
  if (d.length === 11 || d.length === 14) return d;

  // se veio tudo colado com outros números, tenta “janela”
  // prioriza CNPJ (14), depois CPF (11)
  for (let i = 0; i <= d.length - 14; i++) {
    const chunk = d.slice(i, i + 14);
    if (chunk.length === 14) return chunk;
  }
  for (let i = 0; i <= d.length - 11; i++) {
    const chunk = d.slice(i, i + 11);
    if (chunk.length === 11) return chunk;
  }
  return "";
}

export async function openaiChat({ apiKey, model, system, user, maxTokens = 180 }) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: system || "" },
        { role: "user", content: user || "" },
      ],
      max_output_tokens: maxTokens,
    }),
  });

  const text = await res.text();
  const json = safeJsonParse(text);

  if (!res.ok) throw new Error(`OpenAI chat error (${res.status}): ${text}`);

  return stripCodeFences(pickOutputText(json));
}

/**
 * Analisa comprovante e retorna objeto padronizado:
 * {
 *   method: "pix|barcode|debit|transfer|unknown",
 *   amount: "string",
 *   date: "string",
 *   payer_doc: "string (SOMENTE NÚMEROS, 11 ou 14)",
 *   payer_name: "string",
 *   beneficiary: "string",
 *   beneficiary_doc: "string (SOMENTE NÚMEROS, 11 ou 14)",
 *   barcode_present: boolean,
 *   barcode_or_line: "string",
 *   pix_key: "string",
 *   e2e_id: "string",
 *   txid: "string",
 *   notes: "string",
 *   summaryText: "string curta para WhatsApp"
 * }
 */
export async function openaiAnalyzeImage({ apiKey, model, imageDataUrl }) {
  const system = `
Você é um analista de comprovantes do financeiro de um provedor (i9NET).

Tarefa:
- Ler o comprovante (PIX/transferência/boleto/cartão) e responder APENAS em JSON VÁLIDO.
- NUNCA coloque texto fora do JSON.

FORMATO EXATO:
{
  "method": "pix|barcode|debit|transfer|unknown",
  "amount": "",
  "date": "",
  "payer_doc": "",
  "payer_name": "",
  "beneficiary": "",
  "beneficiary_doc": "",
  "barcode_present": false,
  "barcode_or_line": "",
  "pix_key": "",
  "e2e_id": "",
  "txid": "",
  "notes": "",
  "summaryText": ""
}

REGRAS IMPORTANTES:
1) NÃO invente. Se não achar, deixe "" ou "unknown".
2) payer_doc e beneficiary_doc:
   - Se aparecer CPF/CNPJ (mesmo com pontuação), retorne SOMENTE NÚMEROS.
   - Aceite 11 dígitos (CPF) ou 14 dígitos (CNPJ).
   - Se estiver mascarado (ex: ***.***.***-**), deixe "".
3) barcode_or_line:
   - Se houver "linha digitável" ou "código de barras", copie exatamente como aparece (pode conter espaços).
4) PIX:
   - Se houver E2E ID (end-to-end) ou TXID, preencha e2e_id e txid.
   - Se houver chave PIX, preencha pix_key.
5) summaryText:
   - Curto estilo WhatsApp. Ex:
     "Identifiquei pagamento via PIX de R$ 64,99 em 15/02/2026."
     ou "Identifiquei boleto pago no valor R$ 219,00 em 15/02/2026."
`.trim();

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Analise o comprovante e devolva SOMENTE o JSON no formato pedido." },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ],
      max_output_tokens: 520,
    }),
  });

  const text = await res.text();
  const json = safeJsonParse(text);

  if (!res.ok) throw new Error(`OpenAI image error (${res.status}): ${text}`);

  const out = stripCodeFences(pickOutputText(json));
  const parsed = safeJsonParse(out);

  // fallback: se não veio JSON decente
  if (!parsed || typeof parsed !== "object") {
    const payerDocGuess = pickCpfCnpjDigitsFromText(out);
    return {
      method: "unknown",
      amount: "",
      date: "",
      payer_doc: payerDocGuess || "",
      payer_name: "",
      beneficiary: "",
      beneficiary_doc: "",
      barcode_present: false,
      barcode_or_line: "",
      pix_key: "",
      e2e_id: "",
      txid: "",
      notes: out.slice(0, 900),
      summaryText: (out || "Recebi o comprovante, mas não consegui extrair os dados automaticamente.").slice(0, 240),
    };
  }

  // pós-processamento (garante só números e tamanho correto)
  let payerDoc = pickCpfCnpjDigitsFromText(parsed.payer_doc || "");
  let benDoc = pickCpfCnpjDigitsFromText(parsed.beneficiary_doc || "");

  // se não veio doc nos campos, tenta caçar dentro de notes/summaryText/barcode
  if (!payerDoc) payerDoc = pickCpfCnpjDigitsFromText(parsed.notes || "") || pickCpfCnpjDigitsFromText(parsed.summaryText || "");
  if (!benDoc) benDoc = pickCpfCnpjDigitsFromText(parsed.beneficiary || "") || pickCpfCnpjDigitsFromText(parsed.notes || "");

  // nunca retorna doc inválido
  if (!(payerDoc.length === 11 || payerDoc.length === 14)) payerDoc = "";
  if (!(benDoc.length === 11 || benDoc.length === 14)) benDoc = "";

  return {
    method: parsed.method || "unknown",
    amount: parsed.amount || "",
    date: parsed.date || "",
    payer_doc: payerDoc,
    payer_name: parsed.payer_name || "",
    beneficiary: parsed.beneficiary || "",
    beneficiary_doc: benDoc,
    barcode_present: Boolean(parsed.barcode_present),
    barcode_or_line: parsed.barcode_or_line || "",
    pix_key: parsed.pix_key || "",
    e2e_id: parsed.e2e_id || "",
    txid: parsed.txid || "",
    notes: parsed.notes || "",
    summaryText: parsed.summaryText || "",
  };
}
