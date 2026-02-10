// lib/openai.js
// Exports:
// - openaiChat({ apiKey, model, system, user, maxTokens })
// - openaiAnalyzeImage({ apiKey, model, imageDataUrl })

function pickOutputText(json) {
  return json?.output_text || json?.output?.[0]?.content?.[0]?.text || json?.choices?.[0]?.message?.content || "";
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function stripCodeFences(s) {
  return String(s || "").replace(/```json/gi, "").replace(/```/g, "").trim();
}

export async function openaiChat({ apiKey, model, system, user, maxTokens = 180 }) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
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
 *   payer_doc: "string",
 *   beneficiary: "string",
 *   barcode_present: boolean,
 *   barcode_or_line: "string",
 *   pix_key: "string",
 *   notes: "string",
 *   summaryText: "string curta para WhatsApp"
 * }
 */
export async function openaiAnalyzeImage({ apiKey, model, imageDataUrl }) {
  const system = `
Você é um analista de comprovantes da i9NET (financeiro).
Extraia do comprovante e responda APENAS em JSON válido, SEM texto fora do JSON.

Formato:
{
  "method": "pix|barcode|debit|transfer|unknown",
  "amount": "",
  "date": "",
  "payer_doc": "",
  "beneficiary": "",
  "barcode_present": false,
  "barcode_or_line": "",
  "pix_key": "",
  "notes": "",
  "summaryText": ""
}

Regras:
- Não invente. Se não achar, deixe "" ou "unknown".
- barcode_or_line: se houver "linha digitável" ou "código de barras", copie (com ou sem espaços).
- pix_key: se houver chave PIX / end-to-end / txid / identificador, copie.
- summaryText deve ser curto (WhatsApp), ex: "Identifiquei pagamento por boleto no valor X em DD/MM."
`.trim();

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Analise o comprovante e devolva o JSON pedido." },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ],
      max_output_tokens: 420,
    }),
  });

  const text = await res.text();
  const json = safeJsonParse(text);

  if (!res.ok) throw new Error(`OpenAI image error (${res.status}): ${text}`);

  const out = stripCodeFences(pickOutputText(json));
  const parsed = safeJsonParse(out);

  if (!parsed || typeof parsed !== "object") {
    return {
      method: "unknown",
      amount: "",
      date: "",
      payer_doc: "",
      beneficiary: "",
      barcode_present: false,
      barcode_or_line: "",
      pix_key: "",
      notes: out.slice(0, 800),
      summaryText: (out || "Recebi o comprovante, mas não consegui extrair os dados automaticamente.").slice(0, 240),
    };
  }

  return {
    method: parsed.method || "unknown",
    amount: parsed.amount || "",
    date: parsed.date || "",
    payer_doc: parsed.payer_doc || "",
    beneficiary: parsed.beneficiary || "",
    barcode_present: Boolean(parsed.barcode_present),
    barcode_or_line: parsed.barcode_or_line || "",
    pix_key: parsed.pix_key || "",
    notes: parsed.notes || "",
    summaryText: parsed.summaryText || "",
  };
}
