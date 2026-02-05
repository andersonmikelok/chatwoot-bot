import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.status(200).send("OK - webhook online");
});

// Endpoint que você vai colocar no Chatwoot
app.post("/chatwoot-webhook", (req, res) => {
  // Loga o evento para você ver no Render
  console.log("Webhook recebido:", JSON.stringify(req.body, null, 2));

  // IMPORTANTE: sempre responder rápido pro Chatwoot não reenviar
  return res.status(200).json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
