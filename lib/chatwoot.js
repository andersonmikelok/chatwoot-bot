// lib/chatwoot.js
// (arquivo completo conforme seu repo)

export function buildAuthHeaders({ uid, accessToken, client, tokenType }) {
  const h = {};
  if (accessToken) h["access-token"] = accessToken;
  if (client) h["client"] = client;
  if (uid) h["uid"] = uid;
  if (tokenType) h["token-type"] = tokenType;
  return h;
}

export async function chatwootSignInIfNeeded({ baseUrl, email, password, force = false }) {
  // Mantém simples: sempre faz login quando chamado
  // (se você tiver cache, pode reintroduzir depois)
  const res = await fetch(`${baseUrl}/auth/sign_in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      body,
      accessToken: "",
      client: "",
      uid: "",
      tokenType: "",
    };
  }

  const accessToken = res.headers.get("access-token") || "";
  const client = res.headers.get("client") || "";
  const uid = res.headers.get("uid") || "";
  const tokenType = res.headers.get("token-type") || "";

  return { ok: true, status: res.status, body, accessToken, client, uid, tokenType };
}

export async function getConversation({ baseUrl, accountId, conversationId, headers }) {
  const res = await fetch(`${baseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}`, {
    headers,
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

export async function sendMessage({ baseUrl, accountId, conversationId, headers, content }) {
  const res = await fetch(`${baseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ content, message_type: "outgoing", private: false }),
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

export async function addLabels({ baseUrl, accountId, conversationId, headers, labels }) {
  const res = await fetch(`${baseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/labels`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ labels }),
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

export async function removeLabel({ baseUrl, accountId, conversationId, headers, label }) {
  const res = await fetch(`${baseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/labels/${label}`, {
    method: "DELETE",
    headers,
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

export async function setCustomAttributesMerge({ baseUrl, accountId, conversationId, headers, attrs }) {
  const res = await fetch(`${baseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/custom_attributes`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ custom_attributes: attrs }),
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

export async function downloadAttachmentAsDataUrl({ baseUrl, headers, dataUrl }) {
  // dataUrl normalmente é uma URL do próprio Chatwoot (com auth headers)
  const res = await fetch(dataUrl, { headers });
  const buf = await res.arrayBuffer();
  const bytes = buf.byteLength;
  const contentType = res.headers.get("content-type") || "";

  if (!res.ok) {
    return { ok: false, status: res.status, bytes, contentType, dataUri: "", url: dataUrl };
  }

  const b64 = Buffer.from(buf).toString("base64");
  const dataUri = `data:${contentType};base64,${b64}`;
  return { ok: true, status: res.status, bytes, contentType, dataUri, url: dataUrl };
}
