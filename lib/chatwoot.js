/**
 * lib/chatwoot.js
 * Chatwoot Devise Token Auth (sign_in -> access-token/client/uid/token-type)
 * Helpers:
 * - chatwootSignInIfNeeded (cache em memória + renova se falhar)
 * - buildAuthHeaders
 * - getConversation
 * - sendMessage
 * - sendPrivateNote ✅ (nota interna p/ atendentes)
 * - addLabel / removeLabel / addLabels (merge)
 * - setCustomAttributesMerge (merge)
 * - downloadAttachmentAsDataUrl
 */

let AUTH_CACHE = {
  accessToken: "",
  client: "",
  tokenType: "Bearer",
  uid: "",
  ts: 0,
};

const AUTH_TTL_MS = Number(process.env.CW_AUTH_TTL_MS || 10 * 60 * 1000); // 10min

export function normalizeBaseUrl(url) {
  return (url || "").replace(/\/+$/, "");
}

export function buildHeaders({ accessToken, client, uid, tokenType }) {
  return {
    "Content-Type": "application/json",
    "access-token": accessToken || "",
    "client": client || "",
    "uid": uid || "",
    "token-type": tokenType || "Bearer",
  };
}

/**
 * Para usar no server.js
 */
export function buildAuthHeaders({ accessToken, client, uid, tokenType }) {
  return buildHeaders({ accessToken, client, uid, tokenType });
}

export async function signIn({ baseUrl, email, password }) {
  const url = `${normalizeBaseUrl(baseUrl)}/auth/sign_in`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

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
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    throw new Error(`Chatwoot API failed (${res.status}) ${url}: ${JSON.stringify(json || text)}`);
  }

  return json ?? { ok: true };
}

/**
 * Cache simples em memória para não fazer sign_in toda hora.
 * Se qualquer requisição der erro 401, chame novamente esta função para renovar.
 */
export async function chatwootSignInIfNeeded({ baseUrl, email, password, force = false }) {
  const now = Date.now();
  const fresh =
    AUTH_CACHE.accessToken &&
    AUTH_CACHE.client &&
    AUTH_CACHE.uid &&
    now - AUTH_CACHE.ts < AUTH_TTL_MS;

  if (!force && fresh) return { ...AUTH_CACHE };

  const auth = await signIn({ baseUrl, email, password });
  AUTH_CACHE = { ...auth, ts: now };
  console.log("🔄 Tokens Chatwoot renovados");
  return { ...AUTH_CACHE };
}

export async function getConversation({ baseUrl, accountId, conversationId, headers }) {
  return chatwootFetch({
    baseUrl,
    path: `/api/v1/accounts/${accountId}/conversations/${conversationId}`,
    method: "GET",
    headers,
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
    body: { content, message_type: "outgoing", private: false },
  });
}

/**
 * ✅ Nota privada (aparece só para atendentes no Chatwoot)
 */
export async function sendPrivateNote({ baseUrl, accountId, conversationId, headers, content }) {
  return chatwootFetch({
    baseUrl,
    path: `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
    method: "POST",
    headers,
    body: { content, message_type: "outgoing", private: true },
  });
}

/**
 * Adiciona 1 label sem apagar as outras.
 */
export async function addLabel({ baseUrl, accountId, conversationId, headers, label }) {
  try {
    return await chatwootFetch({
      baseUrl,
      path: `/api/v1/accounts/${accountId}/conversations/${conversationId}/labels`,
      method: "POST",
      headers,
      body: { labels: [label] },
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
      body: { labels: Array.from(labels) },
    });
  }
}

/**
 * Remove 1 label sem mexer nas outras.
 */
export async function removeLabel({ baseUrl, accountId, conversationId, headers, label }) {
  try {
    return await chatwootFetch({
      baseUrl,
      path: `/api/v1/accounts/${accountId}/conversations/${conversationId}/labels`,
      method: "DELETE",
      headers,
      body: { labels: [label] },
    });
  } catch {
    const convo = await getConversation({ baseUrl, accountId, conversationId, headers });
    const labels = new Set(extractLabels(convo));
    labels.delete(label);

    return chatwootFetch({
      baseUrl,
      path: `/api/v1/accounts/${accountId}/conversations/${conversationId}`,
      method: "PATCH",
      headers,
      body: { labels: Array.from(labels) },
    });
  }
}

/**
 * ✅ addLabels (MERGE): recebe uma lista e garante união com labels atuais.
 */
export async function addLabels({ baseUrl, accountId, conversationId, headers, labels = [] }) {
  const uniqAdd = Array.from(new Set((labels || []).filter(Boolean)));
  if (!uniqAdd.length) return { ok: true };

  const convo = await getConversation({ baseUrl, accountId, conversationId, headers });
  const current = extractLabels(convo);
  const merged = Array.from(new Set([...(current || []), ...uniqAdd]));

  try {
    return await chatwootFetch({
      baseUrl,
      path: `/api/v1/accounts/${accountId}/conversations/${conversationId}/labels`,
      method: "POST",
      headers,
      body: { labels: merged },
    });
  } catch {
    return chatwootFetch({
      baseUrl,
      path: `/api/v1/accounts/${accountId}/conversations/${conversationId}`,
      method: "PATCH",
      headers,
      body: { labels: merged },
    });
  }
}

export async function setCustomAttributesMerge({ baseUrl, accountId, conversationId, headers, attrs = {} }) {
  const safeAttrs = attrs && typeof attrs === "object" ? attrs : {};
  if (!Object.keys(safeAttrs).length) return { ok: true };

  const path1 = `/api/v1/accounts/${accountId}/conversations/${conversationId}/custom_attributes`;
  try {
    return await chatwootFetch({
      baseUrl,
      path: path1,
      method: "POST",
      headers,
      body: { custom_attributes: safeAttrs },
    });
  } catch {
    try {
      return await chatwootFetch({
        baseUrl,
        path: path1,
        method: "PATCH",
        headers,
        body: { custom_attributes: safeAttrs },
      });
    } catch {
      const convo = await getConversation({ baseUrl, accountId, conversationId, headers });
      const current = convo?.custom_attributes || {};
      const merged = { ...current, ...safeAttrs };

      return chatwootFetch({
        baseUrl,
        path: `/api/v1/accounts/${accountId}/conversations/${conversationId}`,
        method: "PATCH",
        headers,
        body: { custom_attributes: merged },
      });
    }
  }
}

export async function downloadAttachmentAsDataUrl({ baseUrl, headers, dataUrl }) {
  const res = await fetch(dataUrl, { headers });

  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      bytes: buf.length,
      contentType,
      dataUri: "",
      textPreview: buf.toString("utf8").slice(0, 300),
    };
  }

  const base64 = buf.toString("base64");
  const dataUri = `data:${contentType};base64,${base64}`;
  return { ok: true, status: res.status, bytes: buf.length, contentType, dataUri };
}
