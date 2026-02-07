/**
 * lib/chatwoot.js
 * Chatwoot Devise Token Auth (sign_in -> access-token/client/uid/token-type)
 * + helpers:
 * - getConversation
 * - sendMessage
 * - addLabel / removeLabel (tenta endpoints mais comuns; fallback via PATCH labels)
 */

export function normalizeBaseUrl(url) {
  return (url || "").replace(/\/+$/, "");
}

export function buildHeaders({ accessToken, client, uid, tokenType }) {
  return {
    "Content-Type": "application/json",
    "access-token": accessToken || "",
    "client": client || "",
    "uid": uid || "",
    "token-type": tokenType || "Bearer"
  };
}

export async function signIn({ baseUrl, email, password }) {
  const url = `${normalizeBaseUrl(baseUrl)}/auth/sign_in`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    throw new Error(`Chatwoot sign_in failed (${res.status}): ${JSON.stringify(json || text)}`);
  }

  const accessToken = res.headers.get("access-token") || "";
  const client = res.headers.get("client") || "";
  const tokenType = res.headers.get("token-type") || "Bearer";
  const uid = res.headers.get("uid") || email || "";

  if (!accessToken || !client) {
    throw new Error("Chatwoot sign_in OK, mas não retornou access-token/client.");
  }

  return { accessToken, client, tokenType, uid };
}

export async function chatwootFetch({
  baseUrl,
  path,
  method = "GET",
  headers,
  body
}) {
  const url = `${normalizeBaseUrl(baseUrl)}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    throw new Error(`Chatwoot API failed (${res.status}) ${url}: ${JSON.stringify(json || text)}`);
  }

  return json ?? { ok: true };
}

export async function getProfile({ baseUrl, headers }) {
  return chatwootFetch({ baseUrl, path: "/api/v1/profile", method: "GET", headers });
}

export async function getConversation({ baseUrl, accountId, conversationId, headers }) {
  return chatwootFetch({
    baseUrl,
    path: `/api/v1/accounts/${accountId}/conversations/${conversationId}`,
    method: "GET",
    headers
  });
}

export function extractLabels(convoJson) {
  // Chatwoot geralmente retorna `labels: []`
  const labels = convoJson?.labels || convoJson?.data?.labels || [];
  return Array.isArray(labels) ? labels : [];
}

export async function sendMessage({
  baseUrl,
  accountId,
  conversationId,
  headers,
  content
}) {
  return chatwootFetch({
    baseUrl,
    path: `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
    method: "POST",
    headers,
    body: { content, message_type: "outgoing" }
  });
}

/**
 * Tenta adicionar/remover label na conversa.
 * - Primeiro tenta endpoint /labels (que existe em muitas versões)
 * - Se falhar, faz fallback: PATCH conversation com labels
 */
export async function addLabel({
  baseUrl,
  accountId,
  conversationId,
  headers,
  label
}) {
  // 1) Tenta endpoint labels
  try {
    return await chatwootFetch({
      baseUrl,
      path: `/api/v1/accounts/${accountId}/conversations/${conversationId}/labels`,
      method: "POST",
      headers,
      body: { labels: [label] }
    });
  } catch (e) {
    // 2) Fallback PATCH labels
    const convo = await getConversation({ baseUrl, accountId, conversationId, headers });
    const labels = new Set(extractLabels(convo));
    labels.add(label);

    return chatwootFetch({
      baseUrl,
      path: `/api/v1/accounts/${accountId}/conversations/${conversationId}`,
      method: "PATCH",
      headers,
      body: { labels: Array.from(labels) }
    });
  }
}

export async function removeLabel({
  baseUrl,
  accountId,
  conversationId,
  headers,
  label
}) {
  // 1) Tenta endpoint labels (algumas versões aceitam DELETE)
  try {
    return await chatwootFetch({
      baseUrl,
      path: `/api/v1/accounts/${accountId}/conversations/${conversationId}/labels`,
      method: "DELETE",
      headers,
      body: { labels: [label] }
    });
  } catch (e) {
    // 2) Fallback PATCH labels
    const convo = await getConversation({ baseUrl, accountId, conversationId, headers });
    const labels = new Set(extractLabels(convo));
    labels.delete(label);

    return chatwootFetch({
      baseUrl,
      path: `/api/v1/accounts/${accountId}/conversations/${conversationId}`,
      method: "PATCH",
      headers,
      body: { labels: Array.from(labels) }
    });
  }
}
