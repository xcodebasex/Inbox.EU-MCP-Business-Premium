import assert from 'node:assert/strict';
import test from 'node:test';
import { readAdmin } from '../src/admin.js';
import { createClient } from '../src/client.js';

const globalPath = '/api/v1/domain_admins/42';
const domainPath = '/api/v1/domains/example.org/domain_admins/42';
const profilePath = '/api/v1/me/';
const admin = { id: 42, firstName: 'Ada' };

function fixture(...responses) {
  const paths = [];
  const request = createClient({
    apiKey: 'test-admin-fixture-key',
    async fetchImpl(url, { method }) {
      paths.push(url.pathname);
      assert.equal(method, 'GET');
      const [status, data] = responses.shift();
      return Response.json({ data }, { status });
    },
  });
  return { paths, request };
}

test('successful global lookups only fetch the global record', async () => {
  const { paths, request } = fixture([200, admin]);
  const result = await readAdmin(request, { domainAdmin: '42', domainName: 'example.org' });
  assert.deepEqual(result, { status: 200, data: { data: admin } });
  assert.deepEqual(paths, [globalPath]);
});

test('a denied global lookup can use one domain lookup or the current administrator profile', async () => {
  for (const [status, domainName, path, source, id] of [
    [401, 'example.org', domainPath, 'domain_admin', 42],
    [403, undefined, profilePath, 'current_profile', '42'],
  ]) {
    const data = { ...admin, id };
    const { paths, request } = fixture([status, null], [200, data]);
    const result = await readAdmin(request, { domainAdmin: '42', domainName });
    assert.deepEqual(result, { status: 200, data: { data }, source });
    assert.deepEqual(paths, [globalPath, path]);
  }
});

test('fallback never answers with an unverified or different administrator', async () => {
  for (const [domainName, id] of [[undefined, '0042'], [undefined, undefined], ['example.org', 43]]) {
    const { paths, request } = fixture([403, null], [200, { id, firstName: 'Private person' }]);
    await assert.rejects(readAdmin(request, { domainAdmin: '42', domainName }),
      { message: 'You do not have permission for this operation.' });
    assert.deepEqual(paths, [globalPath, domainName ? domainPath : profilePath]);
  }
});

test('other failures never initiate a fallback, and a failed fallback is final', async () => {
  for (const status of [400, 404, 429, 500]) {
    const { paths, request } = fixture([status, null]);
    await assert.rejects(readAdmin(request, { domainAdmin: '42' }), { httpStatus: status });
    assert.deepEqual(paths, [globalPath]);
  }
  const { paths, request } = fixture([401, null], [403, null]);
  await assert.rejects(readAdmin(request, { domainAdmin: '42', domainName: 'example.org' }),
    { message: 'You do not have permission for this operation.' });
  assert.deepEqual(paths, [globalPath, domainPath]);
});

test('cancellation between lookups prevents a second network request', async () => {
  const { paths, request } = fixture([401, null]);
  const controller = new AbortController();
  async function cancelOnDenial(params) {
    try {
      return await request(params);
    } catch (error) {
      controller.abort();
      throw error;
    }
  }
  await assert.rejects(readAdmin(cancelOnDenial, { domainAdmin: '42' }, controller.signal),
    { message: 'The request was cancelled before it was sent.' });
  assert.deepEqual(paths, [globalPath]);
});
