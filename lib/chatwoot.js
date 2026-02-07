/**
 * Salva custom_attributes na conversa (estado, cpfcnpj, whatsapp_phone, cache etc.)
 * Tenta endpoint dedicado e faz fallback via PATCH conversation.
 */
export async function setConversationCustomAttributes({
  baseUrl,
  accountId,
  conversationId,
  headers,
  attrs
}) {
  const path = `/api/v1/accounts/${accountId}/conversations/${conversationId}/custom_attributes`;

  // 1) tenta endpoint específico
  try {
    return await chatwootFetch({
      baseUrl,
      path,
      method: "POST",
      headers,
      body: { custom_attributes: attrs }
    });
  } catch (e) {
    // 2) fallback PATCH
    try {
      return await chatwootFetch({
        baseUrl,
        path,
        method: "PATCH",
        headers,
        body: { custom_attributes: attrs }
      });
    } catch {
      // 3) fallback final: PATCH conversation (algumas versões aceitam custom_attributes no conversation)
      return chatwootFetch({
        baseUrl,
        path: `/api/v1/accounts/${accountId}/conversations/${conversationId}`,
        method: "PATCH",
        headers,
        body: { custom_attributes: attrs }
      });
    }
  }
}

/**
 * Baixa anexo via data_url e retorna DataURL base64 (para enviar ao OpenAI Vision)
 */
export async function downloadAttachmentAsDataUrl({
  dataUrl,
  headers
}) {
  const res = await fetch(dataUrl, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const base64 = buf.toString("base64");
  const dataUri = `data:${contentType};base64,${base64}`;
  return { ok: res.ok, status: res.status, bytes: buf.length, contentType, dataUri };
}
