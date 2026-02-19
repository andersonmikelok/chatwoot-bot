// lib/openai.js
// BUILD_ID: fix3-2026-02-19T22:30Z
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
 * { amount, date, barcode_or_line, payer_doc, summaryText }
 */
export async function openaiAnalyzeImage({ apiKey, model, imageDataUrl } = {}) {
  const url = "https://api.openai.com/v1/responses";

  const prompt =
    "Você é um extrator de dados de comprovantes bancários/pix. " +
    "Extraia APENAS se estiver claramente visível: " +
    "valor pago, data, linha digitável/código de barras, CPF/CNPJ do pagador (se houver). " +
    'Responda em JSON puro no formato: { "amount": "string|number|null", "date": "YYYY-MM-DD|null", "barcode_or_line": "string|null", "payer_doc": "string|null", "summaryText": "string" }.';

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
      summaryText: parsed.summaryText || "Recebi o comprovante e identifiquei as principais informações.",
    };
  }

  return {
    amount: null,
    date: null,
    barcode_or_line: null,
    payer_doc: null,
    summaryText: outText || "Recebi o comprovante.",
  };
}

/**
 * Classificador de imagem (evita tratar foto de equipamento como comprovante)
 * Retorna: { type: "receipt"|"network_equipment"|"other", confidence: 0-1, summaryText }
 */
export async function openaiClassifyImage({ apiKey, model, imageDataUrl } = {}) {
  const url = "https://api.openai.com/v1/responses";

  const prompt =
    "Classifique a imagem em UMA categoria: " +
    "receipt (comprovante de pagamento / pix / boleto), " +
    "network_equipment (foto de modem/ONU/roteador com LEDs), " +
    "other (qualquer outra coisa). " +
    "Responda SOMENTE em JSON puro no formato: " +
    '{ "type": "receipt|network_equipment|other", "confidence": 0-1, "summaryText": "string" }.';

  const payload = {
    model: model || "gpt-5.2",
    max_output_tokens: 220,
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
    const type = String(parsed.type || "other").trim();
    const conf = Number(parsed.confidence);
    return {
      type: type === "receipt" || type === "network_equipment" || type === "other" ? type : "other",
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
      summaryText: String(parsed.summaryText || "Imagem classificada.").trim(),
    };
  }

  return { type: "other", confidence: 0, summaryText: outText || "Imagem classificada." };
}

/**
 * Análise de foto de equipamento (ONU/roteador) focada em LEDs e diagnóstico NOC.
 * Retorna JSON com leitura e orientação.
 */
export async function openaiAnalyzeNetworkEquipment({ apiKey, model, imageDataUrl } = {}) {
  const url = "https://api.openai.com/v1/responses";

  const prompt =
    "Você é um técnico NOC especialista em GPON/FTTH. " +
    "Analise a foto do equipamento (ONU/roteador) e descreva o estado dos LEDs, quando visível. " +
    "Se não der para ler, diga que não está nítido e peça nova foto. " +
    "Responda SOMENTE em JSON puro no formato: " +
    '{ "power": "on|off|unknown", "pon": "green|blinking|off|unknown", "los": "red|off|unknown", "lan": "on|off|blinking|unknown", "wifi": "on|off|unknown", "diagnosis": "string", "next_steps": ["string"], "need_human": true|false, "summaryText": "string" }.';

  const payload = {
    model: model || "gpt-5.2",
    max_output_tokens: 380,
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
      power: parsed.power ?? "unknown",
      pon: parsed.pon ?? "unknown",
      los: parsed.los ?? "unknown",
      lan: parsed.lan ?? "unknown",
      wifi: parsed.wifi ?? "unknown",
      diagnosis: String(parsed.diagnosis || "").trim(),
      next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps.map((x) => String(x || "").trim()).filter(Boolean) : [],
      need_human: Boolean(parsed.need_human),
      summaryText: String(parsed.summaryText || "Análise do equipamento concluída.").trim(),
    };
  }

  return {
    power: "unknown",
    pon: "unknown",
    los: "unknown",
    lan: "unknown",
    wifi: "unknown",
    diagnosis: "",
    next_steps: [],
    need_human: true,
    summaryText: outText || "Não consegui analisar com precisão.",
  };
}

export default { openaiChat, openaiAnalyzeImage, openaiClassifyImage, openaiAnalyzeNetworkEquipment };