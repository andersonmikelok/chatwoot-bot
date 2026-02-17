// =====================
// GPT classifier (só quando der dúvida)
// =====================
async function classifyIntentWithGPT({ apiKey, model, text }) {
  const reply = await openaiChat({
    apiKey,
    model,
    system:
      "Você é um classificador. Dada uma mensagem de cliente de um provedor de internet, responda SOMENTE com uma destas palavras:\n" +
      "support (sem internet, lento, instável, wi-fi, conexão)\n" +
      "finance (boleto, pagamento, fatura, pix, comprovante, desbloqueio)\n" +
      "sales (planos, contratar, preço, cobertura, instalação)\n\n" +
      "Regras: responda apenas uma palavra (support/finance/sales), minúscula, sem pontuação.",
    user: text,
    // ⚠️ seu wrapper exige mínimo 16
    maxTokens: 16,
  });

  const c = (reply || "").trim().toLowerCase();

  // tolera pequenas variações
  if (c.includes("support")) return "support";
  if (c.includes("finance")) return "finance";
  if (c.includes("sales")) return "sales";

  return null;
}
