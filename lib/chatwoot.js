// biblioteca/chatwoot.js
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

export async function chatwootFetch({ baseUrl, path, method = "GET", headers, body }) {
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
    const err = new Error(`Chatwoot API failed (${res.status}) ${url}: ${JSON.stringify(json || text)}`);
    err.status = res.status;
    err.url = url;
    err.body = json || text;
    throw err;
  }

  return json ?? { ok: true };
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
  const labels = convoJson?.labels || convoJson?.data?.labels || [];
  return Array.isArray(labels) ? labels : [];
}

export async function sendMessage({ baseUrl, accountId, conversationId, headers, content }) {
  return chatwootFetch({
    baseUrl,
    path: `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
    method: "POST",
    headers,
    body: { content, message_type: "outgoing" }
  });
}

export async function addLabel({ baseUrl, accountId, conversationId, headers, label }) {
  try {
    return await chatwootFetch({
      baseUrl,
      path: `/api/v1/accounts/${accountId}/conversations/${conversationId}/labels`,
      method: "POST",
      headers,
      body: { labels: [label] }
    });
  } catch {
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

export async function setCustomAttributes({ baseUrl, accountId, conversationId, headers, attrs }) {
  // endpoint comum
  const path = `/api/v1/accounts/${accountId}/conversations/${conversationId}/custom_attributes`;
  try {
    return await chatwootFetch({ baseUrl, path, method: "POST", headers, body: { custom_attributes: attrs } });
  } catch (e) {
    // fallback
    try {
      return await chatwootFetch({ baseUrl, path, method: "PATCH", headers, body: { custom_attributes: attrs } });
    } catch {
      const err = new Error("Não consegui salvar custom_attributes (endpoint pode variar).");
      err.cause = e;
      throw err;
    }
  }
}

export async function downloadAttachment({ baseUrl, headers, dataUrl }) {
  const url = dataUrl; // já vem completo (rails blob redirect)
  const res = await fetch(url, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const base64 = buf.toString("base64");
  const dataUri = `data:${contentType};base64,${base64}`;
  return { ok: res.ok, status: res.status, bytes: buf.length, contentType, dataUri };
}
