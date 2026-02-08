// -----------------------------
// SUPORTE — CPF recebido
// -----------------------------
if (state === "support_need_cpf") {
  const cpfDigits = onlyDigits(customerText);

  console.log("🧪 DEBUG CPF recebido:", cpfDigits);

  if (!(cpfDigits.length === 11 || cpfDigits.length === 14)) {
    await sendMessage({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      content: "Opa! Envie CPF (11) ou CNPJ (14) somente números.",
    });
    return;
  }

  await setCustomAttributesMerge({
    baseUrl: CHATWOOT_URL,
    accountId: CHATWOOT_ACCOUNT_ID,
    conversationId,
    headers: cwHeaders,
    attrs: {
      cpfcnpj: cpfDigits,
      bot_state: "support_check",
    },
  });

  await sendMessage({
    baseUrl: CHATWOOT_URL,
    accountId: CHATWOOT_ACCOUNT_ID,
    conversationId,
    headers: cwHeaders,
    content: "Perfeito — só um instante que vou verificar seu acesso no sistema. ✅",
  });

  console.log("🧪 DEBUG -> indo para support_check");

  return;
}

// -----------------------------
// SUPORTE — consulta ReceitaNet
// -----------------------------
if (state === "support_check") {
  const cpfUse = ca.cpfcnpj || onlyDigits(customerText);

  console.log("🧪 DEBUG support_check CPF:", cpfUse);

  if (!cpfUse) {
    console.log("❌ DEBUG: CPF vazio — abortando");
    return;
  }

  console.log("🧪 DEBUG: consultando ReceitaNet…");

  let debitos = [];

  try {
    debitos = await rnListDebitos({
      baseUrl: RECEITANET_BASE_URL,
      token: RECEITANET_TOKEN,
      app: RECEITANET_APP,
      cpfcnpj: cpfUse,
      status: 0,
    });

    console.log("🧪 DEBUG ReceitaNet resposta:", debitos);
  } catch (err) {
    console.log("❌ DEBUG ReceitaNet erro:", err);
  }

  const overdue = pickBestOverdueBoleto(debitos);

  console.log("🧪 DEBUG boleto encontrado:", overdue);

  if (overdue) {
    await sendMessage({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      content: "Identifiquei um boleto em aberto — vou te enviar para regularizar 👇",
    });

    await sendMessage({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      content: formatBoletoWhatsApp(overdue),
    });

    await sendMessage({
      baseUrl: CHATWOOT_URL,
      accountId: CHATWOOT_ACCOUNT_ID,
      conversationId,
      headers: cwHeaders,
      content:
        "Após pagar, me envie o comprovante (foto/PDF). Vou conferir se foi o mês correto e te aviso o prazo de compensação.",
    });

    return;
  }

  console.log("🧪 DEBUG: sem boletos vencidos");

  await sendMessage({
    baseUrl: CHATWOOT_URL,
    accountId: CHATWOOT_ACCOUNT_ID,
    conversationId,
    headers: cwHeaders,
    content:
      "Seu acesso está normal no sistema. Vamos testar:\n1) desligue o roteador por 2 minutos\n2) ligue novamente\n\nDepois me diga se voltou.",
  });

  await setCustomAttributesMerge({
    baseUrl: CHATWOOT_URL,
    accountId: CHATWOOT_ACCOUNT_ID,
    conversationId,
    headers: cwHeaders,
    attrs: { bot_state: "support_wait_feedback" },
  });

  return;
}
