import { isDeepStrictEqual } from 'node:util';

const ORIGIN = 'https://api.inbox.eu';
const MAX_BYTES = 1024 * 1024;
const DOMAIN_CHECK = /^\/api\/v1\/domain_find\/[^/]+$/;
const EMAIL_CHECK = '/api/v1/emails/admin';
const AVAILABLE_ADMIN_EMAIL = {
  error: 'RestValidationException',
  errorMessages: ['Email not found and is available for registration.'],
};
const CREATE_IMPERSONATION = /^\/api\/v1\/domains\/[^/]+\/mail_users\/[^/]+\/impersonation\/impersonate$/;
const UNCERTAIN = ' The change may have been applied. Check Inbox.eu before retrying.';

export class InboxEuError extends Error {
  constructor(message, httpStatus) {
    super(message);
    this.name = 'InboxEuError';
    Object.defineProperty(this, 'httpStatus', { value: httpStatus });
  }
}

function apiError(message, uncertain = false, httpStatus) {
  return new InboxEuError(message + (uncertain ? UNCERTAIN : ''), httpStatus);
}

function requestUrl(path, query) {
  // Reject dot segments and encoded separators before either URL parser can normalize them.
  if (typeof path !== 'string' || !path.startsWith('/api/v1/') ||
      /[\\?#\s\x00-\x1f\x7f]|%(?:25)*(?:2f|5c|00|0a|0d)/i.test(path) ||
      path.split('/').some(segment => /^(?:\.|%(?:25)*2e){1,2}$/i.test(segment))) {
    throw apiError('Invalid Inbox.eu API path.');
  }
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN || url.pathname !== path) {
    throw apiError('Invalid Inbox.eu API path.');
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

function cancelBody(response) {
  response.body?.cancel().catch(() => {});
}

function abortMessage(signal) {
  return signal.reason?.name === 'TimeoutError' ? 'The request timed out.' : 'The request was cancelled.';
}

async function readEnvelope(response, signal, apiKey) {
  const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!(mediaType === 'application/json' || mediaType?.endsWith('+json')) || !response.body) {
    cancelBody(response);
    throw new Error('json');
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    cancelBody(response);
    throw new Error('limit');
  }
  const reader = response.body.getReader();
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        cancel();
        throw new Error('limit');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
  return JSON.parse(json, (_key, value) => {
    if (typeof value === 'string') return value.replaceAll(apiKey, () => '[redacted]');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const name of Object.keys(value)) {
        if (name.includes(apiKey)) delete value[name];
      }
    }
    return value;
  });
}

function statusMessage(status, method, path) {
  switch (status) {
    case 400:
    case 422:
      if (method === 'GET' && /^\/api\/v1\/domains\/[^/]+\/mail_users\/[^/]+$/.test(path)) {
        return 'Could not read the mailbox. Check the domain and mailbox ID.';
      }
      return 'Inbox.eu rejected the request. Check the supplied values.';
    case 401:
      if (method === 'GET' && /^\/api\/v1\/domain_admins\/[^/]+$/.test(path)) {
        return 'Administrator lookup was denied. Try the domain administrator lookup.';
      }
      return 'Inbox.eu did not accept the API key for this operation.';
    case 403: return 'You do not have permission for this operation.';
    case 404:
      if (method === 'GET' && path === EMAIL_CHECK) return 'Could not verify the administrator email address. Check the spelling.';
      return 'The requested item could not be found or accessed.';
    case 408: return 'Inbox.eu did not respond in time.';
    case 409: return 'The request conflicts with the current state of this item.';
    case 429: return 'Too many requests. Try again later.';
    default:
      if (status >= 500) return 'Inbox.eu encountered a server error.';
      if (status >= 300 && status < 400) return 'Inbox.eu requested a redirect. The request was stopped.';
      return 'Inbox.eu returned an unexpected response.';
  }
}

function expectedEnvelope(method, path, status) {
  if (method === 'GET' && DOMAIN_CHECK.test(path)) {
    if (status === 404) return 'array';
    if (status === 409) return 'error';
    return null;
  }
  if (method === 'GET' && path === EMAIL_CHECK) {
    if (status === 200) return 'array';
    if (status === 404) return 'availableAdminEmail';
    if (status === 422) return 'error';
    return null;
  }
  const created = method === 'POST' && (path === '/api/v1/domain_admins/' ||
    path === '/api/v1/me/two_factor/' || CREATE_IMPERSONATION.test(path));
  const success = created ? 201 : 200;
  return status === success ? 'data' : null;
}

function matchesEnvelope(value, kind) {
  if (kind === 'availableAdminEmail') return isDeepStrictEqual(value, AVAILABLE_ADMIN_EMAIL);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (kind === 'error') {
    return typeof value.error === 'string' ||
      (Array.isArray(value.errorMessages) && value.errorMessages.every(item => typeof item === 'string'));
  }
  if (Object.hasOwn(value, 'error') || Object.hasOwn(value, 'errorMessages')) return false;
  if (kind === 'array') return Array.isArray(value.data);
  return Object.hasOwn(value, 'data');
}

export function createClient({ apiKey, fetchImpl = fetch, timeoutMs = 15000 }) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw apiError('Remove NODE_TLS_REJECT_UNAUTHORIZED=0 to enable TLS verification, then restart the server.');
  }
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw apiError('Set INBOXEU_API_KEY to a key with no spaces or line breaks.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw apiError('Invalid request timeout.');
  }
  return async function request({ method = 'GET', path, query, body, signal }) {
    const url = requestUrl(path, query);
    const mutation = method !== 'GET';
    const deadline = AbortSignal.timeout(timeoutMs);
    const active = signal ? AbortSignal.any([deadline, signal]) : deadline;
    if (active.aborted) throw apiError('The request was cancelled before it was sent.');
    const headers = { Accept: 'application/json', Authorization: `Bearer ${apiKey}` };
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetchImpl(url, { method, headers, body: payload, signal: active, redirect: 'manual' });
    } catch {
      const message = active.aborted ? abortMessage(active) : 'Could not connect to Inbox.eu.';
      throw apiError(message, mutation);
    }
    const { status } = response;
    const kind = expectedEnvelope(method, path, status);
    if (!kind) {
      cancelBody(response);
      const uncertain = mutation && (status >= 500 || status === 408 || (status >= 200 && status < 400));
      throw apiError(statusMessage(status, method, path), uncertain, status);
    }
    // The provider also uses a generic not-found response for invalid email checks.
    const emailCheckError = kind === 'availableAdminEmail' ? statusMessage(status, method, path) : null;
    let data;
    try {
      data = await readEnvelope(response, active, apiKey);
    } catch (error) {
      let message = emailCheckError ?? 'Could not read the response from Inbox.eu.';
      if (error?.message === 'limit') message = 'The response exceeds 1 MiB. Request a smaller page if available.';
      if (active.aborted) message = abortMessage(active);
      throw apiError(message, mutation);
    }
    if (!matchesEnvelope(data, kind)) {
      throw apiError(emailCheckError ?? 'Inbox.eu returned an unrecognized response.', mutation);
    }
    return { status, data };
  };
}
