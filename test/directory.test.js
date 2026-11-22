import assert from "node:assert/strict";
import test from "node:test";
import { InboxEuError } from "../src/client.js";
import { findMailboxId, listDomains, listMailboxPage } from "../src/directory.js";

const domainName = "example.org";

function response(rows, count) {
  return { status: 200, data: { type: "mail_users", data: { data: rows, count } } };
}

test("domain discovery returns only canonical names for accessible domain records", async () => {
  const signal = new AbortController().signal;
  const call = records => listDomains(async args => {
    assert.deepEqual(args, { method: "GET", path: "/api/v1/domains/", signal });
    return { status: 200, data: { data: records } };
  }, signal);
  assert.deepEqual(await call([
    { name: "EXAMPLE.ORG", apiKey: "private" }, { name: "Bücher.example.org.", id: 17 },
  ]), { domains: ["example.org", "xn--bcher-kva.example.org"] });
  assert.deepEqual(await call([]), { domains: [] });
  for (const invalid of [null, {}, [null], [{ hostName: "example.org" }], [{ name: "http://example.org" }],
    [{ name: "example.org." }, { name: "EXAMPLE.ORG" }]]) {
    await assert.rejects(call(invalid), /invalid domain list/);
  }
  await assert.rejects(listDomains(() => assert.fail("No request expected"), AbortSignal.abort()), /cancelled/);
});

test("a page uses the domain collection and exposes only verified mailbox fields", async () => {
  const signal = new AbortController().signal;
  const request = async args => {
    assert.deepEqual(args, {
      method: "GET", path: "/api/v1/domains/example.org/mail_users/", query: { limit: 2, offset: 3 }, signal,
    });
    return response([
      { id: 17, user: "Sales", status: "open", pop3_password: "private", date_created: "omitted" },
      { id: "0009", user: "office@EXAMPLE.ORG", prefs: { key: "private" } },
    ], 6);
  };
  assert.deepEqual(await listMailboxPage(request, { domainName: "EXAMPLE.org", limit: 2, offset: 3 }, signal), {
    data: [{ userId: "17", email: "Sales@example.org", status: "open" }, { userId: "0009", email: "office@example.org" }],
    total: 6, offset: 3, nextOffset: 5,
  });
});

test("lookup follows returned row counts, preserves case, and distinguishes a complete miss", async () => {
  const pages = [
    response([{ id: 1, user: "Info" }], 3),
    response([{ id: "002", user: "info" }, { id: 3, user: "sales" }], 3),
  ];
  for (const [address, expected] of [["info@EXAMPLE.org", "002"], ["missing@example.org", undefined]]) {
    const offsets = [];
    const request = async ({ query }) => {
      assert.equal(query.limit, 100);
      offsets.push(query.offset);
      return pages[offsets.length - 1];
    };
    assert.equal(await findMailboxId(request, address), expected);
    assert.deepEqual(offsets, [0, 1]);
  }
});

test("invalid records and ambiguous mailbox pages never produce an apparent absence", async () => {
  for (const page of [
    { data: { data: [] } }, response([], 1), response([], "0"), response([{ id: 1, user: "info" }], 0),
    ...[null, { id: 1, forename: "Info" }, { id: 0, user: "info" }, { id: "x/y", user: "info" },
      { id: "info@example.org", user: "info" }, { id: 1, user: "info@example.net" },
      { id: 1, user: "info", email: "sales@example.org" }, { id: 1, user: "info", domainName: "example.net" },
    ].map(row => response([row], 1)),
    response([{ id: 1, user: "info" }, { id: 2, user: "info" }], 2),
  ]) {
    await assert.rejects(findMailboxId(async () => page, "info@example.org"), InboxEuError);
  }
  const initial = response([{ id: 1, user: "info" }], 2);
  for (const final of [
    response([{ id: 1, user: "sales" }], 2), response([{ id: 2, user: "info" }], 2),
    response([{ id: 2, user: "sales" }], 3),
  ]) {
    await assert.rejects(findMailboxId(async ({ query }) => query.offset ? final : initial, "info@example.org"), /changed|duplicate/);
  }
});

test("page validation bounds requests and supports empty end pages", async () => {
  for (const invalid of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 1.2 }]) {
    await assert.rejects(listMailboxPage(() => assert.fail("No request expected"), { domainName, ...invalid }), /limit.*offset/);
  }
  const empty = await listMailboxPage(async () => response([], 0), { domainName, offset: 17 });
  assert.deepEqual(empty, { data: [], total: 0, offset: 17, nextOffset: null });
  let requests = 0;
  const last = await findMailboxId(async ({ query }) => {
    requests++;
    return response([{ id: query.offset + 1, user: "u" + query.offset }], 101);
  }, "u100@example.org");
  assert.equal(last, "101");
  assert.equal(requests, 101);
});

test("a denied or cancelled lookup cannot become a negative result", async () => {
  const failing = error => findMailboxId(async () => { throw error; }, "info@example.org");
  for (const status of [401, 403, 404]) {
    await assert.rejects(failing(new InboxEuError("Permission denied.", status)), /Cannot access the mailbox directory/);
  }
  const throttled = new InboxEuError("Try again later.", 429);
  await assert.rejects(failing(throttled), error => error === throttled);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(findMailboxId(async ({ signal }) => {
    assert.equal(signal, controller.signal);
    calls++;
    controller.abort();
    return response([{ id: 1, user: "info" }], 2);
  }, "info@example.org", controller.signal), /cancelled/);
  assert.equal(calls, 1);
});
