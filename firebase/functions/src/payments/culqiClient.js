const CULQI_API_BASE = 'https://api.culqi.com/v2';

/**
 * Cliente mínimo para la API REST de Culqi — no tiene SDK oficial de Node,
 * así que se llama directo con fetch (disponible global en Node 20).
 */
async function culqiRequest(path, { method = 'GET', secretKey, body } = {}) {
  const res = await fetch(`${CULQI_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.user_message || data.merchant_message || 'Error de Culqi');
    err.culqiResponse = data;
    throw err;
  }
  return data;
}

module.exports = { culqiRequest };
