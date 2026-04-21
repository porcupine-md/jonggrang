import { ref } from 'vue';

function buildRequestError(response, payload) {
  const message = payload?.error || payload?.message || `Request failed (${response.status})`;
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
