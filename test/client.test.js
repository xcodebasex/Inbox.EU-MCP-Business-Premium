import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '../src/client.js';

const apiKey = 'inboxeu-test-credential';
const me = '/api/v1/me/';
const domain = '/api/v1/domain_find/example.com';
const email = '/api/v1/emails/admin';
const client = fetchImpl => createClient({ apiKey, fetchImpl });

test('requests only the Inbox.eu origin and sends query parameters and JSON in their proper places', async () => {
  const requests = [];
  const request = client(async (url, options) => {
    requests.push({ url, ...options });
    return Response.json({ data: [] });
  });
  await request({ path: email, query: { email: 'a+b@example.com', omitted: undefined } });
  await request({ method: 'PUT', path: me, body: { firstName: 'Anna' } });
  assert.equal(requests[0].url.href, 'https://api.inbox.eu/api/v1/emails/admin?email=a%2Bb%40example.com');
  assert.equal(requests[0].headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(requests[0].headers['Content-Type'], undefined);
  assert.equal(requests[0].redirect, 'manual');
  assert.equal(requests[1].headers['Content-Type'], 'application/json');
  assert.equal(requests[1].body, '{"firstName":"Anna"}');
});

test('rejects paths that resolve outside the route before calling fetch', async () => {
  let calls = 0;
  const request = client(() => { calls++; });
  for (const path of [
    'https://example.com/api/v1/me/', 'http://api.inbox.eu/api/v1/me/', '//example.com/api/v1/me/', '/api/v1/../admin',
    '/api/v1/%2e%2E/private', '/api/v1/%252e%252e/private', '/api/v1/user%252Fprivate',
    '/api/v1/a\\b', '/api/v1/me/?injected=true', '/api/v1/me/#other',
  ]) {
    await assert.rejects(request({ path }), /API path/);
  }
  assert.equal(calls, 0);
});

test('refuses insecure TLS configuration before dispatch and never follows a downgrade redirect', async () => {
  let calls = 0;
  const redirectsToHttp = (url, options) => {
    assert.equal(url.protocol, 'https:');
    assert.equal(options.redirect, 'manual');
    calls++;
    return Response.redirect('http://api.inbox.eu/api/v1/me/', 307);
  };
  const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    assert.throws(() => client(redirectsToHttp), /NODE_TLS_REJECT_UNAUTHORIZED=0/);
    assert.equal(calls, 0);
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await assert.rejects(client(redirectsToHttp)({ path: me }), { message: 'Inbox.eu requested a redirect. The request was stopped.' });
    assert.equal(calls, 1);
  } finally {
    if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved;
  }
});

test('returns the documented availability statuses only for their respective GET endpoints', async () => {
  const cases = [
    [domain, 404, { data: [] }],
    [domain, 409, { error: 'used' }],
    [email, 200, { data: [] }],
    [email, 422, { errorMessages: ['available'] }],
  ];
  for (const [path, status, data] of cases) {
    const request = client(async () => Response.json(data, { status }));
    assert.deepEqual(await request({ path }), { status, data });
  }
  for (const [path, status, data, message] of [
    [me, 404, { data: [] }, 'The requested item could not be found or accessed.'],
    [email, 404, { data: [] }, 'Could not verify the administrator email address. Check the spelling.'],
    [domain, 200, { data: [] }, 'Inbox.eu returned an unexpected response.'],
    [domain, 404, { error: 'route missing' }, 'Inbox.eu returned an unrecognized response.'],
    [email, 422, {}, 'Inbox.eu returned an unrecognized response.'],
    [me, 200, [], 'Inbox.eu returned an unrecognized response.'],
  ]) {
    const request = client(async () => Response.json(data, { status }));
    await assert.rejects(request({ path }), { message });
  }
  const html = client(async () => new Response('<html>404</html>', { status: 404 }));
  await assert.rejects(html({ path: domain }), { message: 'Could not read the response from Inbox.eu.' });
});

test('recognizes the observed administrator email availability response without treating other not-found errors as availability', async () => {
  const data = { error: 'RestValidationException', errorMessages: ['Email not found and is available for registration.'] };
  const query = { email: 'free@example.org' };
  const request = client(async () => Response.json(data, { status: 404 }));
  assert.deepEqual(await request({ path: email, query }), { status: 404, data });
  for (const response of [
    Response.json({ ...data, error: 'NotFoundException' }, { status: 404 }),
    Response.json({ ...data, errorMessages: [...data.errorMessages, 'Other validation error'] }, { status: 404 }),
    Response.json({ ...data, data: [] }, { status: 404 }),
    Response.json({ error: 'RestValidationException' }, { status: 404 }),
    new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } }),
  ]) {
    await assert.rejects(client(async () => response)({ path: email, query }),
      { message: 'Could not verify the administrator email address. Check the spelling.' });
  }
  await assert.rejects(request({ path: me }), { message: 'The requested item could not be found or accessed.' });
});

test('suggests a domain lookup only when global administrator lookup rejects authorization', async () => {
  const request = client(async () => new Response(null, { status: 401 }));
  await assert.rejects(request({ path: '/api/v1/domain_admins/7' }),
    { message: 'Administrator lookup was denied. Try the domain administrator lookup.' });
  await assert.rejects(request({ path: '/api/v1/domains/example.com/domain_admins/7' }),
    { message: 'Inbox.eu did not accept the API key for this operation.' });
});

test('redacts the configured key in both string values and property names', async () => {
  const request = client(async () => Response.json({ data: [{ id: 1, name: 'demo',
    echoed: `Bearer ${apiKey} and ${apiKey}`, [`field-${apiKey}`]: 'hidden' }] }));
  const result = await request({ path: me });
  assert.equal(result.data.data[0].name, 'demo');
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test('treats only the documented success status as final and rejects contradictory envelopes', async () => {
  for (const [method, path, status] of [
    ['GET', me, 200], ['PUT', me, 200], ['POST', '/api/v1/domain_admins/', 201],
    ['POST', '/api/v1/invite/', 200], ['POST', '/api/v1/me/two_factor/', 201],
    ['GET', '/api/v1/me/two_factor/', 200], ['DELETE', '/api/v1/me/two_factor/', 200],
    ['POST', '/api/v1/domains/example.com/mail_users/7/impersonation/impersonate', 201],
    ['POST', '/api/v1/domains/example.com/mail_users/7/impersonation/validate', 200],
  ]) {
    const response = { data: [] };
    assert.equal((await client(async () => Response.json(response, { status }))({ method, path })).status, status);
    const otherStatus = status === 200 ? 202 : 200;
    const unexpected = client(async () => Response.json(response, { status: otherStatus }));
    await assert.rejects(unexpected({ method, path }), error => {
      assert.match(error.message, /Inbox.eu returned an unexpected response\./);
      assert.doesNotMatch(error.message, /\b\d{3}\b/);
      if (method !== 'GET') assert.match(error.message, /The change may have been applied/);
      return true;
    });
    for (const errorFields of [{ error: 'upstream problem' }, { errorMessages: ['upstream problem'] }]) {
      const conflict = client(async () => Response.json({ ...response, ...errorFields }, { status }));
      await assert.rejects(conflict({ method, path }), error => {
        assert.match(error.message, /an unrecognized response/);
        assert.doesNotMatch(error.message, /upstream problem/);
        if (method !== 'GET') assert.match(error.message, /The change may have been applied/);
        return true;
      });
    }
  }
});

test('limits streamed response bodies even when the size is not declared', async () => {
  const chunk = new Uint8Array(512 * 1024);
  let cancelled = false;
  const request = client(async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(request({ path: me }), /1 MiB/);
  assert.equal(cancelled, true);
});

test('hides upstream error data and redirect destinations and never retries a mutation', async () => {
  for (const [status, expected] of [
    [302, 'Inbox.eu requested a redirect. The request was stopped.'],
    [400, 'Inbox.eu rejected the request. Check the supplied values.'],
    [401, 'Inbox.eu did not accept the API key for this operation.'],
    [403, 'You do not have permission for this operation.'],
    [408, 'Inbox.eu did not respond in time.'],
    [409, 'The request conflicts with the current state of this item.'],
    [422, 'Inbox.eu rejected the request. Check the supplied values.'],
    [429, 'Too many requests. Try again later.'],
    [503, 'Inbox.eu encountered a server error.'],
  ]) {
    let calls = 0;
    const request = client(async () => {
      calls++;
      return new Response(`internal response: ${apiKey}`, {
        status, headers: { location: `https://example.com/?token=${apiKey}` },
      });
    });
    await assert.rejects(request({ method: 'POST', path: '/api/v1/invite/', body: {} }), error => {
      assert.ok(error.message.startsWith(expected));
      assert.doesNotMatch(error.message, /HTTP|\b\d{3}\b|inboxeu-test-credential|internal response|example\.com/);
      if ([302, 408, 503].includes(status)) assert.match(error.message, /The change may have been applied/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('reports uncertain write outcomes on connection loss, malformed success or unexpected envelope', async () => {
  for (const fetchImpl of [
    async () => { throw new Error(`failure with ${apiKey}`); },
    async () => new Response('wrong', { headers: { 'content-type': 'application/json' } }),
    async () => Response.json({ unrelated: true }),
  ]) {
    await assert.rejects(client(fetchImpl)({ path: me, method: 'PUT', body: {} }), error => {
      assert.doesNotMatch(error.message, /inboxeu-test-credential|wrong|unrelated/);
      return /The change may have been applied/.test(error.message);
    });
  }
});

test('cancellation before dispatch sends no request, and the deadline covers reading the body', async () => {
  let dispatched = false;
  const request = client(() => { dispatched = true; });
  await assert.rejects(request({ path: me, signal: AbortSignal.abort() }), /cancelled before it was sent/);
  assert.equal(dispatched, false);

  let closed = false;
  // A real network request keeps Node alive while waiting for the abort timer.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const timed = createClient({ apiKey, timeoutMs: 40,
      fetchImpl: async () => new Response(new ReadableStream({ cancel() { closed = true; } }),
        { headers: { 'content-type': 'application/json' } }),
    });
    await assert.rejects(timed({ path: me, method: 'PUT', body: {} }), /timed out.*The change may have been applied/);
    assert.equal(closed, true);
  } finally {
    clearInterval(keepAlive);
  }
});
