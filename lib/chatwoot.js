export function normalizeBaseUrl(url) {
  return (url || "").replace(/\/+$/, "");
}

export function buildAuthHeaders({ accessToken, client, uid, tokenType }) {
  return {
    "Content-Type": "application/json",
    "access-token": accessToken || "",
    client: client || "",
    uid: uid || "",
    "token-type": tokenType || "Bearer",
  };
}

// cache simples do token na memória
let authCache = {
  accessToken: "",
  client: "",
  tokenType: "Bearer",
  uid: "",
  ts: 0,
};

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

export async function chatwootSignInIfNeeded({ baseUrl, email, password }) {
  // renova a cada ~45 min por segurança
  const now = Date.now();
  const isFresh = authCache.accessToken && now - authCache.ts < 45 * 60 * 1000;
  if (isFresh) return authCache;

  const auth = await signIn({ baseUrl, email, password });
  authCache = { ...auth, ts: now };
  console.log("🔄 Chatwoot tokens renovados");
  return authCache;
}

async function chatwootFetch({ baseUrl, path, method = "GET", headers, body, email, password }) {
  const url = `${normalizeBaseUrl(baseUrl)}${path}`;

  const doReq = async (hdrs) => {
    const res = await fetch(url, {
      method,
      headers: hdrs,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { res, json, text };
  };

  let { res, json, text } = await doReq(headers);

  // se 401, tenta renovar cache e repetir
  if (res.status === 401 && email && password) {
    const auth = await chatwootSignInIfNeeded({ baseUrl, email, password });
    const newHeaders = buildAuthHeaders(auth);
    ({ res, json, text } = await doReq(newHeaders));
  }

  if (!res.ok) {
    throw new Error(`Chatwoot API failed (${res.status}) ${url}: ${JSON.stringify(json || text)}`);
  }

  return json ?? { ok: true };
}

export async function getConversation({ baseUrl, accountId, conversationId, headers }) {
  return chatwootFetch({
    baseUrl,
    path: `/api/v1/accounts/${accountId}/conversations/${conversationId}`,
    method: "GET",
    headers,
  });
}

export async function sendMessage({ baseUrl, accountId, conversationId, headers, content }) {
  return chatwootFetch({
    baseUrl,
    path: `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
    method: "POST",
    headers,
    body: { content, message_type: "outgoing" },
  });
}

export async function addLabels({ baseUrl, accountId, conversationId, headers, labels = [] }) {
  const uniq = [...new Set(labels.filter(Boolean))];
  if (!uniq.length) return { ok: true };

  // endpoint mais comum
  try {
    return await chatwootFetch({
      baseUrl,
      path: `/api/v1/accounts/${accountId}/conversations/${conversationId}/labels`,
      method: "POST",
      headers,
      body: { labels: uniq },
    });
  } catch (e) {
    // fallback patch conversation
    const conv = await getConversation({ baseUrl, accountId, conversationId, headers });
    const current = (conv?.labels || []).map((x) => (typeof x === "string" ? x : x?.title)).filter(Boolean);
    const set = new Set(current);
    uniq.forEach((l) => set.add(l));

    return chatwootFetch({
      baseUrl,
      path: `/api/v1/accounts/${accountId}/conversations/${conversationId}`,
      method: "PATCH",
      headers,
      body: { labels: Array.from(set) },
    });
  }
}

/**
 * Salva custom_attributes MESCLANDO com o que já existe
 * (evita apagar estado sem querer)
 */
export async function setCustomAttributesMerge({ baseUrl, accountId, conversationId, headers, attrs = {} }) {
  // busca atuais
  const conv = await getConversation({ baseUrl, accountId, conversationId, headers });
  const current = conv?.custom_attributes || {};
  const merged = { ...current, ...attrs };

  // endpoint mais comum nas versões
  const path = `/api/v1/accounts/${accountId}/conversations/${conversationId}/custom_attributes`;

  // tenta PATCH
  try {
    return await chatwootFetch({
      baseUrl,
      path,
      method: "PATCH",
      headers,
      body: { custom_attributes: merged },
    });
  } catch (e) {
    // fallback POST
    return chatwootFetch({
      baseUrl,
      path,
      method: "POST",
      headers,
      body: { custom_attributes: merged },
    });
  }
}

/**
 * Baixa anexo do Chatwoot e retorna dataUri (base64)
 */
export async function downloadAttachmentAsDataUrl({ baseUrl, headers, dataUrl }) {
  const url = dataUrl; // já é absolute
  const res = await fetch(url, { headers });

  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const base64 = buf.toString("base64");
  const dataUri = `data:${contentType};base64,${base64}`;

  return { ok: res.ok, status: res.status, bytes: buf.length, contentType, dataUri };
}
