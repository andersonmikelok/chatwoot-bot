// lib/openai.js
// ✅ Exporta named exports E default export (compatível com qualquer import)

function buildHeaders(apiKey) {
  if (!apiKey) throw new Error("OPENAI_API_KEY ausente");
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function safeTextFromResponse(json) {
  // Responses API: output_text (quando disponível)
  if (typeof json?.output_text === "string" && json.output_text.trim()) {
    return json.output_text.trim();
  }

  // fallback: tenta varrer output[]
  const out = json?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === "string" && c.text.trim()) return c.text.trim();
        }
      }
    }
  }

  // fallback: formato antigo
  const msg =
    json?.choices?.[0]?.message?.content ||
    json?.data?.[0]?.content ||
    json?.message ||
    "";

  return String(msg || "").trim();
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Chat (texto)
 * Usa Responses API (recomendado).
 */
export async function openaiChat({
  apiKey,
  model,
  system,
  user,
  maxTokens = 220,
  temperature = 0.2,
} = {}) {
  const url = "https://api.openai.com/v1/responses";

  const payload = {
    model: model || "gpt-5.2",
    max_output_tokens: maxTokens,
    temperature,
    input: [
      ...(system
        ? [
            {
              role: "system",
              content: [{ type: "text", text: String(system) }],
            },
          ]
        : []),
      {
        role: "user",
        content: [{ type: "text", text: String(user || "") }],
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  const json = safeJsonParse(text);

  if (!res.ok) {
    return { ok: false, status: res.status, body: json || text };
  }

  const outText = safeTextFromResponse(json);
  return { ok: true, status: res.status, text: outText, raw: json };
}

/**
 * Análise de imagem (comprovante)
 * Retorna um objeto simples:
 * { amount, date, barcode_or_line, payer_doc, summaryText }
 */
export async function openaiAnalyzeImage({
  apiKey,
  model,
  imageDataUrl, // data:image/...;base64,...
} = {}) {
  const url = "https://api.openai.com/v1/responses";

  // prompt bem objetivo para extração
  const prompt =
    "Você é um extrator de dados de comprovantes. " +
    "Extraia APENAS se estiver claramente visível: valor pago, data, linha digitável/código de barras, CPF/CNPJ pagador (se houver). " +
    "Responda em JSON puro no formato: " +
    '{ "amount": "string|number|null", "date": "YYYY-MM-DD|null", "barcode_or_line": "string|null", "payer_doc": "string|null", "summaryText": "string" }';

  const payload = {
    model: model || "gpt-5.2",
    max_output_tokens: 350,
    temperature: 0,
    input: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "input_image",
            image_url: imageDataUrl,
          },
        ],
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  const json = safeJsonParse(text);

  if (!res.ok) return null;

  const outText = safeTextFromResponse(json);

  // tenta JSON direto
  const parsed = safeJsonParse(outText);

  if (parsed && typeof parsed === "object") {
    // normaliza campos essenciais
    return {
      amount: parsed.amount ?? null,
      date: parsed.date ?? null,
      barcode_or_line: parsed.barcode_or_line ?? null,
      payer_doc: parsed.payer_doc ?? null,
      summaryText:
        parsed.summaryText ||
        "Recebi o comprovante e identifiquei as principais informações.",
    };
  }

  // fallback: sem JSON
  return {
    amount: null,
    date: null,
    barcode_or_line: null,
    payer_doc: null,
    summaryText: outText || "Recebi o comprovante.",
  };
}

// ✅ também exporta default (compatível com import default)
export default {
  openaiChat,
  openaiAnalyzeImage,
};
