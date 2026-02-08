// lib/openai.js

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
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_output_tokens: maxTokens,
    }),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    throw new Error(`OpenAI chat error (${res.status}): ${text}`);
  }

  const out =
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    json?.choices?.[0]?.message?.content ||
    "";

  return String(out || "").trim();
}

/**
 * Analisa imagem (comprovante) e retorna objeto:
 * { method, amount, date, payer_doc, beneficiary, barcode_present, notes, summaryText }
 */
export async function openaiAnalyzeImage({ apiKey, model, imageDataUrl }) {
  const system = `
Você é um analista de comprovantes da i9NET (financeiro).
Extraia do comprovante (se existir) e responda em JSON:
{
  "method": "pix|barcode|debit|unknown",
  "amount": "string",
  "date": "string",
  "payer_doc": "string",
  "beneficiary": "string",
  "barcode_present": true|false,
  "notes": "string",
  "summaryText": "string curta para WhatsApp"
}
Não invente: se não achar, use "" ou "unknown".
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
            { type: "input_text", text: "Analise o comprovante e devolva o JSON pedido." },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ],
      max_output_tokens: 320,
    }),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    throw new Error(`OpenAI image error (${res.status}): ${text}`);
  }

  const out =
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    "";

  const cleaned = String(out || "").trim().replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      method: "unknown",
      amount: "",
      date: "",
      payer_doc: "",
      beneficiary: "",
      barcode_present: false,
      notes: cleaned.slice(0, 500),
      summaryText: cleaned.slice(0, 240),
    };
  }
}
