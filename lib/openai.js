// lib/openai.js
export async function oaiAnalyzePaymentProof({ apiKey, model, noteText, imageDataUrl, personaName }) {
  const system = `
Você é ${personaName}, atendente da i9NET (financeiro).
Tarefa: analisar o comprovante/imagem enviada e extrair o máximo possível:
- tipo (PIX / boleto / débito em conta / transferência)
- valor
- data/horário
- favorecido/beneficiário
- se houver: linha digitável / código de barras / identificação do pagamento
Responda em 2-4 frases objetivas.
Se faltar um dado essencial, faça apenas 1 pergunta.
`.trim();

  const input = [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "input_text", text: noteText || "Analise o comprovante." },
        { type: "input_image", image_url: imageDataUrl }
      ]
    }
  ];

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, input, max_output_tokens: 240 })
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const err = new Error(`OpenAI error ${res.status}: ${JSON.stringify(json || text)}`);
    err.status = res.status;
    err.body = json || text;
    throw err;
  }

  const out =
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    json?.choices?.[0]?.message?.content ||
    null;

  return (out || "Recebi o comprovante. Você pode confirmar o valor pago?").trim();
}

// usado só quando cair no fallback (mensagem muito fora do fluxo)
export async function oaiFallbackReply({ apiKey, model, personaName, personaRole, contextText }) {
  const system = `
Você é ${personaName}, atendente virtual da i9NET.
Perfil: ${personaRole}

Regras:
- Seja direto (WhatsApp).
- Não ofereça menu numérico.
- Não repita perguntas já respondidas no contexto.
- Se o cliente disse "sem internet", encaminhe para suporte e cheque inadimplência.
- Se o tema for boleto/2ª via ou pagamento, aja como financeiro.
`.trim();

  const input = [
    { role: "system", content: system },
    { role: "user", content: contextText }
  ];

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, input, max_output_tokens: 220 })
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const err = new Error(`OpenAI error ${res.status}: ${JSON.stringify(json || text)}`);
    err.status = res.status;
    err.body = json || text;
    throw err;
  }

  const out =
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    json?.choices?.[0]?.message?.content ||
    null;

  return (out || "Certo! Me diga com poucas palavras o que você precisa (suporte ou financeiro).").trim();
}

