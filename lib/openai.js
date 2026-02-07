/**
 * lib/openai.js
 * Usa a OpenAI Responses API (igual seu código atual).
 */

export async function openaiReply({
  apiKey,
  model,
  customerText,
  context
}) {
  const system = `
Você é a atendente virtual da i9NET (provedor de internet).
Objetivo: entender mensagens livres (fora do menu) e ajudar rápido.

Regras:
- Responda em PT-BR, curto e objetivo.
- NÃO envie menu numérico.
- Se o cliente pedir BOLETO / 2ª via / fatura: peça CPF/CNPJ ou número do contrato.
- Se reclamar de internet lenta/sem sinal: oriente 3 passos básicos (desligar ONU/roteador 2 min, ligar, testar) e faça 1 pergunta de triagem.
- Se pedir "falar com atendente": confirme e diga que vai encaminhar.
`.trim();

  const input = [
    { role: "system", content: system },
    { role: "user", content: `Mensagem do cliente: "${customerText}"\nContexto: ${context}` }
  ];

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input,
      max_output_tokens: 220
    })
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    // Mantém erro legível (ex.: 429 insufficient_quota)
    throw new Error(`OpenAI API error (${res.status}): ${JSON.stringify(json || text)}`);
  }

  const out =
    json?.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    json?.choices?.[0]?.message?.content ||
    null;

  return (out || "Certo! Pode me explicar um pouco melhor o que você precisa?").trim();
}
