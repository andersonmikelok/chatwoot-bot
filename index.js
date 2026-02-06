app.post("/chatwoot-webhook", async (req, res) => {
  try {
    if (!assertEnv()) return res.status(500).send("Missing ENV");

    console.log("WEBHOOK RAW:", JSON.stringify(req.body));

    const event = req.body?.event;
    console.log("Webhook recebido:", event);

    res.status(200).send("ok");

    if (event !== "message_created") return;

    // 👉 AQUI entra a correção
    const messageType = req.body?.message_type;

    if (messageType !== 0) {
      console.log("Ignorando message_type:", messageType);
      return;
    }

    const conversationId = req.body?.conversation?.id;
    if (!conversationId) return;

    await sendMessageToConversation(
      conversationId,
      "🤖 Olá! Sou o bot automático. Como posso ajudar?"
    );

    console.log("Mensagem enviada:", conversationId);
  } catch (e) {
    console.error("Erro webhook:", e);
  }
});
