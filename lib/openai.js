// lib/openai.js
// Named exports + default (compatível)

function buildHeaders(apiKey) {
  if (!apiKey) throw new Error("OPENAI_API_KEY ausente");
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function safeTextFromResponse(json) {
  if (typeof json?.output_text === "string" && json.output_text.trim()) {
    return json.output_text.trim();
  }

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

  const msg =
    json?.choices?.[0]?.message?.content ||
    json?.data?.[0]?.content ||
    json?.message ||
    "";

  return String(msg || "").trim();
}

/**
 * Chat (texto) - Responses API
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

  if (!res.ok) return { ok: false, status: res.status, body: json || text };

  return { ok: true, status: res.status, text: safeTextFromResponse(json), raw: json };
}

/**
 * Análise de imagem (comprovante)
 * Retorna:
 * { amount, date, barcode_or_line, payer_doc, status, beneficiary_name, beneficiary_key, summaryText }
 */
export async function openaiAnalyzeImage({ apiKey, model, imageDataUrl } = {}) {
  const url = "https://api.openai.com/v1/responses";

  const prompt =
    "Você é um extrator de dados de comprovantes bancários/pix. " +
    "Extraia APENAS se estiver claramente visível: " +
    "valor pago, data, identificador (PIX copia e cola OU linha digitável/código de barras), CPF/CNPJ do pagador (se houver), " +
    "status do pagamento (pago/concluído/efetivado/liquidado OU agendado/pendente/cancelado), " +
    "beneficiário (nome) e chave/conta do beneficiário (se houver). " +
    'Responda em JSON puro no formato: { "amount": "string|number|null", "date": "YYYY-MM-DD|null", "barcode_or_line": "string|null", "payer_doc": "string|null", "status": "string|null", "beneficiary_name": "string|null", "beneficiary_key": "string|null", "summaryText": "string" }.';

  const payload = {
    model: model || "gpt-5.2",
    max_output_tokens: 350,
    temperature: 0,
    input: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "input_image", image_url: imageDataUrl },
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
  const parsed = safeJsonParse(outText);

  if (parsed && typeof parsed === "object") {
    return {
      amount: parsed.amount ?? null,
      date: parsed.date ?? null,
      barcode_or_line: parsed.barcode_or_line ?? null,
      payer_doc: parsed.payer_doc ?? null,
      status: parsed.status ?? null,
      beneficiary_name: parsed.beneficiary_name ?? null,
      beneficiary_key: parsed.beneficiary_key ?? null,
      summaryText: parsed.summaryText || "Recebi o comprovante e identifiquei as principais informações.",
    };
  }

  return {
    amount: null,
    date: null,
    barcode_or_line: null,
    payer_doc: null,
    status: null,
    beneficiary_name: null,
    beneficiary_key: null,
    summaryText: outText || "Recebi o comprovante.",
  };
}

export default { openaiChat, openaiAnalyzeImage };
