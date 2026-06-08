import { ref } from 'vue';

function buildRequestError(response, payload) {
  // Server errors use the shape { error: { code, message } }; older/simple ones
  // use { error: "string" } or { message: "string" }. Extract a real string so
  // the UI never shows "[object Object]".
  const raw = payload?.error;
  const message =
    (raw && typeof raw === 'object' ? (raw.message || raw.code) : raw) ||
    payload?.message ||
    `Request failed (${response.status})`;
  const error = new Error(message);
  error.status = response.status;
  error.payload = payload;
  return error;
}

async function parseResponse(response) {
  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson
    ? await response.json()
    : (() => {
        throw new Error(`Expected JSON response but received "${contentType || 'unknown'}"`);
      })();

  if (!response.ok) {
    throw buildRequestError(response, payload);
  }

  return payload;
}

export function useJonggrangApi() {
  const requestError = ref('');

  function clearRequestError() {
    requestError.value = '';
  }

  function setRequestError(error, fallbackMessage) {
    requestError.value = error instanceof Error
      ? (error.message || fallbackMessage)
      : fallbackMessage;
  }

  async function requestJson(url, options = {}) {
    const { method = 'GET', body } = options;
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });

    return parseResponse(response);
  }

  return {
    requestError,
    clearRequestError,
    setRequestError,
    requestJson,
  };
}
