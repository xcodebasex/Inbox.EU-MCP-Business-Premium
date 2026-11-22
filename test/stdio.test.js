import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
const apiRoot = "https://api.inbox.eu/api/v1";
const fixtureKey = "stdio-test-key";
const readTools = [
  "inboxeu_check_admin_email", "inboxeu_check_auth", "inboxeu_check_domain",
  "inboxeu_get_2fa_status", "inboxeu_get_admin", "inboxeu_get_domain_admin",
  "inboxeu_get_mailbox", "inboxeu_get_profile", "inboxeu_list_domains", "inboxeu_list_invoices", "inboxeu_list_mailboxes",
];
const writeTools = [
  "inboxeu_create_admin", "inboxeu_invite_admin", "inboxeu_update_profile", "inboxeu_delete_profile",
  "inboxeu_enable_2fa", "inboxeu_disable_2fa", "inboxeu_update_mailbox", "inboxeu_delete_mailbox",
  "inboxeu_create_mailboxes", "inboxeu_send_mailbox_details", "inboxeu_update_mailbox_filters",
  "inboxeu_create_impersonation_token", "inboxeu_validate_impersonation_token", "inboxeu_remove_domain_admin",
];

// The preload runs inside the real server process. Every HTTP attempt is captured
// before a queued reply is returned, including unexpected calls and retries.
function installFixture(replies, logPath, appendFileSync) {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.text();
    appendFileSync(logPath, JSON.stringify({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      body: body ? JSON.parse(body) : null,
    }) + "\n");
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected fixture request");
    return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
  };
}

async function connectFixture(t, replies, {
  apiKey = fixtureKey, accessMode, cliMode, mode = "legacy", defaults = {}, env = {},
  onElicit, capabilities = onElicit ? { elicitation: { form: {} } } : {},
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "inboxeu-mcp-"));
  const log = path.join(dir, "requests.jsonl");
  const envFile = path.join(dir, ".env");
  const settings = [];
  if (apiKey !== null) settings.push("INBOXEU_API_KEY=" + apiKey);
  if (accessMode) settings.push("INBOXEU_MODE=" + accessMode);
  for (const [key, value] of Object.entries(defaults)) settings.push(key + "=" + value);
  await writeFile(envFile, settings.join("\n"));
  await writeFile(log, "");
  const preload = `import { appendFileSync } from "node:fs";
    (${installFixture})(${JSON.stringify(replies)}, ${JSON.stringify(log)}, appendFileSync);`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "data:text/javascript;base64," + Buffer.from(preload).toString("base64"),
      entry, "--env-file", envFile, ...(cliMode ? ["--mode", cliMode] : [])],
    cwd: dir,
    env,
  });
  const client = new Client({ name: "inboxeu-test", version: "1.0.0" }, { capabilities, versionNegotiation: { mode } });
  if (onElicit) client.setRequestHandler("elicitation/create", request => onElicit(request.params));
  t.after(async () => {
    try {
      await client.close();
    } finally {
      await rm(log, { force: true });
      await rm(envFile, { force: true });
      await rmdir(dir);
    }
  });
  await client.connect(transport);
  return {
    client,
    envFile,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    requests: async () => {
      const raw = (await readFile(log, "utf8")).trimEnd();
      return raw ? raw.split("\n").map(line => JSON.parse(line)) : [];
    },
  };
}

function resultData(result) {
  assert.ok(!result.isError, JSON.stringify(result.content));
  const text = result.content.find(block => block.type === "text");
  assert.deepEqual(JSON.parse(text.text), result.structuredContent);
  return result.structuredContent;
}

function assertTargetForm(form, field) {
  assert.equal(form.mode ?? "form", "form");
  assert.match(form.message, field === "userId" ? /mailbox|user ID/i : /domain|host/i);
  assert.deepEqual(Object.keys(form.requestedSchema.properties), [field]);
  assert.deepEqual(form.requestedSchema.required, [field]);
  assert.equal(form.requestedSchema.properties[field].type, "string");
}

for (const [era, mode] of [["legacy", "legacy"], ["modern", { pin: "2026-07-28" }]]) {
  test(`${era} asks for the domain, then only asks for a mailbox when the selected domain needs one`, async t => {
    const domains = { "team.example": ["007", "008"], "solo.example": ["009"] };
    const answers = [
      { domainName: "team.example" }, { userId: "007" },
      { domainName: "solo.example" }, { domainName: "team.example" },
    ];
    const forms = [];
    const { client, call, requests } = await connectFixture(t, [
      { body: { data: { id: "007" } } }, { body: { data: { id: "009" } } }, { body: { data: { id: "008" } } },
    ], {
      accessMode: "full", mode, defaults: { INBOXEU_DOMAINS: JSON.stringify(domains) },
      onElicit: async form => {
        forms.push({ form, dispatchCount: (await requests()).length });
        return { action: "accept", content: answers.shift() };
      },
    });
    assert.equal(client.getProtocolEra(), era);
    const body = { surname: "Original", password: "fixture-body-password" };
    assert.deepEqual(resultData(await call("inboxeu_update_mailbox", { body })), { success: true });
    assert.deepEqual(resultData(await call("inboxeu_get_mailbox")), { data: { id: "009" } });
    assert.deepEqual(resultData(await call("inboxeu_get_mailbox", { userId: "008" })), { data: { id: "008" } });
    assert.deepEqual(forms.map(entry => entry.dispatchCount), [0, 0, 1, 2]);
    ["domainName", "userId", "domainName", "domainName"].forEach((field, i) => assertTargetForm(forms[i].form, field));
    for (const secret of [fixtureKey, body.password]) assert.ok(!JSON.stringify(forms).includes(secret));
    assert.deepEqual((await requests()).map(req => [req.method, req.url, req.body]), [
      ["PUT", apiRoot + "/domains/team.example/mail_users/007", body],
      ["GET", apiRoot + "/domains/solo.example/mail_users/009", null],
      ["GET", apiRoot + "/domains/team.example/mail_users/008", null],
    ]);
  });

  test(`${era} supports both hostname spellings and preserves supplied invitation fields`, async t => {
    const forms = [];
    const answers = [{ hostName: "BÜCHER.example" }, { hostname: "BÜCHER.example" }];
    const { client, call, requests } = await connectFixture(t, [
      { status: 404, body: { data: [] } }, { body: { data: [] } },
    ], {
      mode, accessMode: "full", onElicit: form => {
        forms.push(form);
        return { action: "accept", content: answers.shift() };
      },
    });
    const { tools } = await client.listTools();
    const required = name => tools.find(tool => tool.name === name).inputSchema.required ?? [];
    assert.deepEqual(required("inboxeu_check_domain"), []);
    assert.deepEqual(required("inboxeu_get_mailbox"), []);
    assert.deepEqual(required("inboxeu_invite_admin").sort(), ["email", "user"]);
    const invite = { email: "owner@example.org", user: "fixture" };
    assert.deepEqual(resultData(await call("inboxeu_check_domain")), { available: true });
    assert.deepEqual(resultData(await call("inboxeu_invite_admin", invite)), { success: true });
    assert.equal(forms.length, 2);
    assertTargetForm(forms[0], "hostName");
    assertTargetForm(forms[1], "hostname");
    assert.deepEqual((await requests()).map(req => [req.method, req.url, req.body]), [
      ["GET", apiRoot + "/domain_find/xn--bcher-kva.example", null],
      ["POST", apiRoot + "/invite/", { ...invite, hostname: "xn--bcher-kva.example" }],
    ]);
  });

  test(`${era} stops a write on declined, cancelled, invalid or unsolicited form content`, async t => {
    let answer;
    const forms = [];
    const { call, requests } = await connectFixture(t, [], {
      accessMode: "full", mode, onElicit: form => {
        forms.push(form);
        return answer;
      },
    });
    const domainName = "supplied.example";
    for (const response of [
      { action: "decline" }, { action: "cancel" }, { action: "accept", content: {} },
      { action: "accept", content: { userId: 42 } }, { action: "accept", content: { userId: "invalid/id" } },
      { action: "accept", content: { userId: "007", domainName: "other.example" } },
    ]) {
      answer = response;
      const result = await call("inboxeu_delete_mailbox", { domainName });
      assert.equal(result.isError, true);
      assert.equal(forms.length, 1);
      assertTargetForm(forms.pop(), "userId");
    }
    answer = { action: "accept", content: { domainName: "https://invalid.example" } };
    assert.equal((await call("inboxeu_delete_mailbox", { userId: "007" })).isError, true);
    assert.equal(forms.length, 1);
    assertTargetForm(forms.pop(), "domainName");
    for (const [name, args] of [
      ["inboxeu_update_mailbox", { domainName, userId: "007" }],
      ["inboxeu_validate_impersonation_token", { domainName, userId: "007", body: {} }],
      ["inboxeu_create_admin", { language: "en" }],
      ["inboxeu_remove_domain_admin", { domainName }],
    ]) {
      assert.equal((await call(name, args)).isError, true);
    }
    assert.deepEqual(forms, []);
    assert.deepEqual(await requests(), []);
  });

  test(`${era} gives a client without form support a question and the argument for retrying`, async t => {
    const { call, requests } = await connectFixture(t, [], {
      accessMode: "full", mode, capabilities: { elicitation: { url: {} } },
    });
    for (const [args, field] of [[{}, "domainName"], [{ domainName: "team.example" }, "userId"]]) {
      const result = await call("inboxeu_delete_mailbox", args);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /\?/);
      assert.ok(result.content[0].text.includes(field));
      assert.match(result.content[0].text, /retry|again/i);
    }
    assert.deepEqual(await requests(), []);
  });
}

test("the default stdio catalog exposes read operations and rejects invalid calls before HTTP", async t => {
  const { client, call, requests } = await connectFixture(t, []);
  assert.equal(client.getProtocolEra(), "legacy");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), readTools);
  assert.ok(tools.every(tool => tool.annotations?.readOnlyHint));
  for (const [name, args] of [
    ["inboxeu_check_auth", { extra: true }],
    ["inboxeu_get_domain_admin", { domainName: "example.org" }],
    ["inboxeu_list_invoices", { domainName: "example.org", limit: "20" }],
  ]) {
    const result = await call(name, args);
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Check the tool arguments.");
  }
  for (const name of writeTools) await assert.rejects(call(name, {}));
  assert.deepEqual(await requests(), []);
});

test("a connected client can discover tools and picks up a saved, rotated or removed API key", async t => {
  const authenticated = { body: { data: { authenticated: true } } };
  const { client, call, requests, envFile } = await connectFixture(t, [authenticated, authenticated], { apiKey: null });
  assert.equal((await client.listTools()).tools.length, readTools.length);
  const checkMissingKey = async () => {
    const result = await call("inboxeu_check_auth");
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /INBOXEU_API_KEY/);
  };
  await checkMissingKey();
  assert.deepEqual(await requests(), []);
  const keys = [fixtureKey, "rotated-stdio-test-key"];
  for (const key of keys) {
    await writeFile(envFile, "INBOXEU_API_KEY=" + key + "\n");
    assert.deepEqual(resultData(await call("inboxeu_check_auth")), { authenticated: true });
  }
  await writeFile(envFile, "");
  await checkMissingKey();
  assert.deepEqual(await requests(), keys.map(key => ({
    method: "GET", url: apiRoot + "/security/check", authorization: "Bearer " + key, body: null,
  })));
});

test("read tools accept configured arguments, list mailbox targets as optional and reject invalid overrides", async t => {
  const domain = "configured.example";
  const { client, call, requests } = await connectFixture(t, [
    { body: { data: { id: 17 } } }, { status: 404, body: { data: [] } },
    { status: 422, body: { error: "Email available" } }, { body: { data: [] } },
  ], { defaults: {
    INBOXEU_DOMAIN_NAME: domain,
    INBOXEU_DOMAIN_ADMIN: "admin-17",
    INBOXEU_USER_ID: "",
    INBOXEU_CHECK_ADMIN_EMAIL: "check+owner@example.org",
    INBOXEU_LIST_INVOICES_OFFSET: "0",
  } });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), readTools);
  const schema = name => tools.find(tool => tool.name === name).inputSchema;
  assert.deepEqual(schema("inboxeu_get_domain_admin").required ?? [], []);
  assert.deepEqual(schema("inboxeu_get_mailbox").required ?? [], []);
  assert.ok(!JSON.stringify(tools).includes(domain));
  for (const [name, args] of [
    ["inboxeu_get_mailbox", { userId: "invalid/id" }],
    ["inboxeu_get_domain_admin", { domain: "typo.example" }],
    ["inboxeu_list_invoices", { offset: "0" }],
  ]) {
    assert.equal((await call(name, args)).isError, true);
  }
  assert.deepEqual(await requests(), []);
  const admin = await client.callTool({ name: "inboxeu_get_domain_admin" });
  assert.deepEqual(resultData(admin), { data: { id: 17 } });
  assert.deepEqual(resultData(await call("inboxeu_check_domain")), { available: true });
  assert.deepEqual(resultData(await call("inboxeu_check_admin_email")), { available: true });
  assert.deepEqual(resultData(await call("inboxeu_list_invoices", { domainName: "override.example" })), { data: [] });
  assert.deepEqual((await requests()).map(req => req.url), [
    apiRoot + "/domains/configured.example/domain_admins/admin-17",
    apiRoot + "/domain_find/configured.example",
    apiRoot + "/emails/admin?email=check%2Bowner%40example.org",
    apiRoot + "/domains/override.example/transactions/?offset=0",
  ]);
});

test("read-only mailbox lookup takes both path parameters from the configured file", async t => {
  const { client, requests } = await connectFixture(t, [{ body: { data: { id: "00123", user: "office" } } }], {
    accessMode: "full", cliMode: "read-only", mode: { pin: "2026-07-28" },
    defaults: { INBOXEU_DOMAIN_NAME: "example.org", INBOXEU_USER_ID: "00123" },
    onElicit: () => ({ action: "cancel" }),
  });
  const result = await client.callTool({ name: "inboxeu_get_mailbox" });
  assert.deepEqual(resultData(result), { data: { id: "00123", user: "office" } });
  assert.deepEqual((await requests()).map(req => [req.method, req.url]), [
    ["GET", apiRoot + "/domains/example.org/mail_users/00123"],
  ]);
});

test("a single listed domain supplies the domain for a read without exposing its name in the catalog", async t => {
  const domain = "bücher.example";
  const { client, call, requests } = await connectFixture(t, [{ status: 404, body: { data: [] } }], {
    defaults: { INBOXEU_DOMAINS: JSON.stringify([domain]) },
    onElicit: () => ({ action: "cancel" }),
  });
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === "inboxeu_check_domain").inputSchema;
  assert.ok(!(schema.required ?? []).includes("hostName"));
  assert.doesNotMatch(JSON.stringify(tools), /bücher\.example|xn--bcher-kva\.example/i);
  assert.deepEqual(resultData(await call("inboxeu_check_domain")), { available: true });
  assert.deepEqual((await requests()).map(req => req.url), [apiRoot + "/domain_find/xn--bcher-kva.example"]);
});

test("address lookups select the named mailbox across domains and verify its returned identity", async t => {
  const target = { domainName: "xn--bcher-kva.example", id: "002", user: "Info" };
  const { client, call, requests } = await connectFixture(t, [
    { body: { data: target } }, { body: { data: [target] } },
    { body: { data: { id: "099", user: "new", domainName: "other.example" } } },
    { body: { data: { ...target, user: "estate" } } },
  ], { accessMode: "full", defaults: {
    INBOXEU_DOMAINS: JSON.stringify({ "other.example": ["001"], "Bücher.example": { Info: "002" } }),
    INBOXEU_DOMAIN_NAME: "other.example", INBOXEU_USER_ID: "001",
  } });
  const tool = "inboxeu_get_mailbox";
  const mailboxEmail = "Info@BÜCHER.example";
  const canonicalEmail = "Info@xn--bcher-kva.example";
  assert.ok(!JSON.stringify(await client.listTools()).includes(canonicalEmail));
  for (const args of [
    { mailboxEmail, userId: "001" }, { mailboxEmail, domainName: "other.example" },
    { mailboxEmail, userId: "another@other.example" },
  ]) assert.equal((await call(tool, args)).isError, true);
  assert.equal((await call("inboxeu_delete_mailbox", { domainName: "other.example", userId: mailboxEmail })).isError, true);
  assert.deepEqual(await requests(), []);

  const byAddress = resultData(await call(tool, { mailboxEmail }));
  assert.equal(byAddress.data.id, "002");
  assert.equal(byAddress.data.email, canonicalEmail);
  const byLegacyArgument = resultData(await call(tool, { userId: mailboxEmail }));
  assert.equal(byLegacyArgument.data[0].email, canonicalEmail);
  assert.equal(resultData(await call(tool, { mailboxEmail: "new@other.example", userId: "099" })).data.id, "099");
  const stale = await call(tool, { mailboxEmail });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /did not confirm the requested mailbox/);
  assert.ok(!JSON.stringify(stale).includes("estate"));
  const namedPath = apiRoot + "/domains/xn--bcher-kva.example/mail_users/002";
  assert.deepEqual((await requests()).map(req => req.url), [
    namedPath, namedPath, apiRoot + "/domains/other.example/mail_users/099", namedPath,
  ]);
});

test("an unmapped address resolves through the live directory in clients with the older userId argument", async t => {
  const { call, requests } = await connectFixture(t, [
    { body: { data: { data: [{ id: 9, user: "sales" }], count: 2, active_count: 2 } } },
    { body: { data: { data: [{ id: 17, user: "info" }], count: 2, active_count: 2 } } },
    { body: { data: { id: "17", email: "info@example.org" } } },
  ], { defaults: {
    INBOXEU_DOMAIN_NAME: "other.example", INBOXEU_USER_ID: "999",
    INBOXEU_LIST_MAILBOXES_LIMIT: "1", INBOXEU_LIST_MAILBOXES_OFFSET: "6",
  } });
  assert.equal(resultData(await call("inboxeu_get_mailbox", { userId: "info@example.org" })).data.id, "17");
  const directory = apiRoot + "/domains/example.org/mail_users/";
  assert.deepEqual((await requests()).map(req => [req.method, req.url]), [
    ["GET", directory + "?limit=100&offset=0"], ["GET", directory + "?limit=100&offset=1"], ["GET", directory + "17"],
  ]);
});

test("directory reads use the selected domain, expose only safe mailbox fields and return the next offset", async t => {
  const { call, requests } = await connectFixture(t, [
    { body: { data: { data: [{ id: 7, user: "sales", status: "open", pop3_password: "hidden" }], count: 2, active_count: 2 } } },
    { body: { data: { data: [{ id: "009", user: "info", status: "open" }], count: 2, active_count: 2 } } },
  ], { defaults: { INBOXEU_DOMAINS: '["one.example","two.example"]' } });
  const tool = "inboxeu_list_mailboxes";
  const clarify = await call(tool);
  assert.equal(clarify.isError, true);
  assert.match(clarify.content[0].text, /domain/i);
  assert.deepEqual(await requests(), []);
  const first = resultData(await call(tool, { domainName: "one.example", limit: 1 }));
  assert.deepEqual(first, {
    data: [{ userId: "7", email: "sales@one.example", status: "open" }], total: 2, offset: 0, nextOffset: 1,
  });
  assert.deepEqual(resultData(await call(tool, { domainName: "one.example", limit: 1, offset: first.nextOffset })), {
    data: [{ userId: "009", email: "info@one.example", status: "open" }], total: 2, offset: 1, nextOffset: null,
  });
  const directory = apiRoot + "/domains/one.example/mail_users/";
  assert.deepEqual((await requests()).map(req => req.url), [directory + "?limit=1&offset=0", directory + "?limit=1&offset=1"]);
});

test("a key with one domain and one mailbox can read its account without configured IDs", async t => {
  const domain = { name: "sole.example", validationToken: "private-token" };
  const mailbox = { id: 45, user: "office", status: "open" };
  const { call, requests } = await connectFixture(t, [
    { body: { data: [domain] } },
    { body: { data: [domain] } },
    { body: { data: { data: [mailbox], count: 1, active_count: 1 } } },
    { body: { data: mailbox } },
  ]);
  assert.deepEqual(resultData(await call("inboxeu_list_domains")), { domains: ["sole.example"] });
  const account = resultData(await call("inboxeu_get_mailbox"));
  assert.equal(account.data.id, 45);
  assert.equal(account.data.user, "office");
  assert.deepEqual((await requests()).map(req => [req.method, req.url]), [
    ["GET", apiRoot + "/domains/"], ["GET", apiRoot + "/domains/"],
    ["GET", apiRoot + "/domains/sole.example/mail_users/?limit=2&offset=0"],
    ["GET", apiRoot + "/domains/sole.example/mail_users/45"],
  ]);
});

test("unconfigured ambiguous targets ask which discovered domain or mailbox to use before reading a detail", async t => {
  const domains = [{ name: "first.example", validationToken: "private-token" }, { name: "second.example" }];
  const mailboxes = [{ id: 45, user: "info" }, { id: 46, user: "sales" }];
  const { call, requests } = await connectFixture(t, [
    { body: { data: domains } }, { body: { data: { data: mailboxes, count: 2, active_count: 2 } } },
  ]);
  const domain = await call("inboxeu_list_mailboxes");
  assert.equal(domain.isError, true);
  assert.match(domain.content[0].text, /first\.example/);
  assert.match(domain.content[0].text, /second\.example/);
  assert.doesNotMatch(JSON.stringify(domain), /private-token/);
  const mailbox = await call("inboxeu_get_mailbox", { domainName: "first.example" });
  assert.equal(mailbox.isError, true);
  assert.match(mailbox.content[0].text, /info@first\.example/);
  assert.match(mailbox.content[0].text, /sales@first\.example/);
  assert.match(mailbox.content[0].text, /45/);
  assert.match(mailbox.content[0].text, /46/);
  assert.deepEqual((await requests()).map(req => req.url), [
    apiRoot + "/domains/", apiRoot + "/domains/first.example/mail_users/?limit=2&offset=0",
  ]);
});

test("directory access failures leave omitted read targets available for manual selection", async t => {
  const { call, requests } = await connectFixture(t, [{ status: 403 }, { status: 403 }]);
  const domain = await call("inboxeu_list_invoices");
  assert.equal(domain.isError, true);
  assert.match(domain.content[0].text, /domainName/);
  const mailbox = await call("inboxeu_get_mailbox", { domainName: "example.org" });
  assert.equal(mailbox.isError, true);
  assert.match(mailbox.content[0].text, /userId/);
  assert.deepEqual((await requests()).map(req => req.url), [
    apiRoot + "/domains/", apiRoot + "/domains/example.org/mail_users/?limit=2&offset=0",
  ]);
});

test("answering a mailbox prompt keeps the sole domain that supplied its choices", async t => {
  const rows = [{ id: 45, user: "info" }, { id: 46, user: "sales" }];
  const { call, requests } = await connectFixture(t, [
    { body: { data: [{ name: "team.example" }] } },
    { body: { data: { data: rows, count: 2, active_count: 2 } } },
    { body: { data: rows[1] } },
  ], {
    mode: { pin: "2026-07-28" },
    onElicit: form => {
      assertTargetForm(form, "userId");
      return { action: "accept", content: { userId: "46" } };
    },
  });
  assert.equal(resultData(await call("inboxeu_get_mailbox")).data.user, "sales");
  assert.deepEqual((await requests()).map(req => req.url), [
    apiRoot + "/domains/", apiRoot + "/domains/team.example/mail_users/?limit=2&offset=0",
    apiRoot + "/domains/team.example/mail_users/46",
  ]);
});

test("modern forms accept a full mailbox address and keep the configured domain on retry", async t => {
  const rows = [{ id: 45, user: "info" }, { id: 46, user: "sales" }];
  const page = { body: { data: { data: rows, count: 2, active_count: 2 } } };
  const replies = ["sales@team.example", "sales@other.example"];
  const { call, requests } = await connectFixture(t, [page, page, { body: { data: rows[1] } }, page], {
    mode: { pin: "2026-07-28" },
    defaults: { INBOXEU_DOMAIN_NAME: "team.example" },
    onElicit: form => {
      assertTargetForm(form, "userId");
      assert.match(form.message, /sales@team\.example/);
      return { action: "accept", content: { userId: replies.shift() } };
    },
  });
  const account = resultData(await call("inboxeu_get_mailbox"));
  assert.equal(account.data.email, "sales@team.example");
  assert.equal(account.data.id, 46);
  const wrongDomain = await call("inboxeu_get_mailbox");
  assert.equal(wrongDomain.isError, true);
  assert.match(wrongDomain.content[0].text, /address and domain must match/i);
  assert.deepEqual(replies, []);
  const directory = apiRoot + "/domains/team.example/mail_users/";
  assert.deepEqual((await requests()).map(req => req.url), [
    directory + "?limit=2&offset=0", directory + "?limit=100&offset=0", directory + "46",
    directory + "?limit=2&offset=0",
  ]);
});

test("a completed directory miss and a denied lookup both stop before fetching mailbox details", async t => {
  const { call, requests } = await connectFixture(t, [
    { body: { data: { data: [{ id: "001", user: "sales" }], count: 1, active_count: 1 } } },
    { status: 403, body: { error: "Access denied" } },
  ], { defaults: { INBOXEU_DOMAIN_NAME: "example.org", INBOXEU_USER_ID: "001" } });
  const args = { mailboxEmail: "absent@example.org" };
  const missing = await call("inboxeu_get_mailbox", args);
  assert.equal(missing.isError, true);
  assert.equal(missing.content[0].text, "The address was not found in the mailbox directory for this domain.");
  const denied = await call("inboxeu_get_mailbox", args);
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /permission|access|API key/i);
  assert.doesNotMatch(denied.content[0].text, /address was not found|\b403\b/i);
  const directory = apiRoot + "/domains/example.org/mail_users/?limit=100&offset=0";
  assert.deepEqual((await requests()).map(req => req.url), [directory, directory]);
});

test("mailbox reads resolve within the selected domain and report ambiguous choices locally", async t => {
  const domains = { "a.example": ["42117", "42118"], "bücher.example": ["003"] };
  const { client, call, requests } = await connectFixture(t, [
    { body: { data: { id: "003" } } }, { body: { data: { id: "42118" } } }, { body: { data: { id: "007" } } },
  ], { defaults: { INBOXEU_DOMAINS: JSON.stringify(domains) } });
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === "inboxeu_get_mailbox").inputSchema;
  assert.ok(!(schema.required ?? []).includes("userId"));
  const catalog = JSON.stringify(tools);
  for (const value of [...Object.keys(domains), ...Object.values(domains).flat(), "xn--bcher-kva.example"]) {
    assert.ok(!catalog.includes(value));
  }
  for (const [args, choice] of [[{}, /domain/i], [{ domainName: "a.example" }, /mailbox|userId/i]]) {
    const result = await call("inboxeu_get_mailbox", args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, choice);
  }
  assert.deepEqual(await requests(), []);
  assert.deepEqual(resultData(await call("inboxeu_get_mailbox", { domainName: "XN--BCHER-KVA.EXAMPLE" })), {
    data: { id: "003" },
  });
  assert.deepEqual(resultData(await call("inboxeu_get_mailbox", { domainName: "a.example", userId: "42118" })), {
    data: { id: "42118" },
  });
  assert.deepEqual(resultData(await call("inboxeu_get_mailbox", { domainName: "bücher.example", userId: "007" })), {
    data: { id: "007" },
  });
  assert.deepEqual((await requests()).map(req => req.url), [
    apiRoot + "/domains/xn--bcher-kva.example/mail_users/003",
    apiRoot + "/domains/a.example/mail_users/42118",
    apiRoot + "/domains/xn--bcher-kva.example/mail_users/007",
  ]);
});

test("a stored impersonation token is sent only for the selected default mailbox", async t => {
  const domains = { "a.example": ["003"], "b.example": ["003", "004"] };
  const forms = [];
  const { client, call, requests } = await connectFixture(t, [
    { body: { data: [true] } }, { body: { data: [true] } },
  ], {
    accessMode: "full", defaults: {
      INBOXEU_DOMAINS: JSON.stringify(domains), INBOXEU_DOMAIN_NAME: "a.example",
      INBOXEU_IMPERSONATION_TOKEN: "fixture-token-a",
    },
    onElicit: form => {
      forms.push(form);
      return { action: "accept", content: { userId: "003" } };
    },
  });
  const validate = args => call("inboxeu_validate_impersonation_token", { body: {}, ...args });
  assert.doesNotMatch(JSON.stringify(await client.listTools()), /fixture-token-a/);
  for (const args of [{ domainName: "b.example" }, { userId: "004" }]) {
    const result = await validate(args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /token/i);
  }
  assert.deepEqual(await requests(), []);
  const earlierForms = forms.length;
  assert.deepEqual(resultData(await validate({})), { valid: true });
  assert.equal(forms.length, earlierForms);
  assert.deepEqual(resultData(await validate({ domainName: "b.example", impersonationToken: "fixture-token-b" })), {
    valid: true,
  });
  assert.equal(forms.length, earlierForms + 1);
  for (const form of forms) assertTargetForm(form, "userId");
  assert.doesNotMatch(JSON.stringify(forms), /fixture-token|stdio-test-key/);
  assert.deepEqual((await requests()).map(req => req.url), [
    apiRoot + "/domains/a.example/mail_users/003/impersonation/validate?impersonationToken=fixture-token-a",
    apiRoot + "/domains/b.example/mail_users/003/impersonation/validate?impersonationToken=fixture-token-b",
  ]);
});

test("changing domains scopes mailbox and administrator defaults for full-mode writes", async t => {
  const domains = { "a.example": ["11", "12"], "b.example": ["21", "22"], "c.example": ["003"] };
  const { call, requests } = await connectFixture(t, [
    { body: { data: { id: "11" } } }, { body: { data: { id: "003" } } }, { body: { data: true } },
    { body: { data: [] } },
  ], { cliMode: "full", defaults: {
    INBOXEU_DOMAINS: JSON.stringify(domains), INBOXEU_DOMAIN_NAME: "a.example",
    INBOXEU_USER_ID: "11", INBOXEU_DOMAIN_ADMIN: "admin-a",
  } });
  for (const [name, choice] of [
    ["inboxeu_delete_mailbox", /mailbox|userId/i], ["inboxeu_remove_domain_admin", /admin/i],
  ]) {
    const result = await call(name, { domainName: "b.example" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, choice);
  }
  assert.deepEqual(await requests(), []);
  assert.deepEqual(resultData(await call("inboxeu_get_mailbox")), { data: { id: "11" } });
  const body = { surname: "Fixture" };
  assert.deepEqual(resultData(await call("inboxeu_update_mailbox", { domainName: "c.example", body })), { success: true });
  assert.deepEqual(resultData(await call("inboxeu_delete_mailbox", { domainName: "b.example", userId: "22" })), { success: true });
  assert.deepEqual(resultData(await call("inboxeu_remove_domain_admin", {
    domainName: "b.example", domainAdmin: "admin-b",
  })), { success: true });
  assert.deepEqual((await requests()).map(req => [req.method, req.url, req.body]), [
    ["GET", apiRoot + "/domains/a.example/mail_users/11", null],
    ["PUT", apiRoot + "/domains/c.example/mail_users/003", body],
    ["DELETE", apiRoot + "/domains/b.example/mail_users/22", null],
    ["DELETE", apiRoot + "/domains/b.example/domain_admins/admin-b", null],
  ]);
});

test("full mode applies typed form and mailbox defaults and lets callers replace individual fields", async t => {
  const secret = "fixture-only-password";
  const adminDomain = { name: "new.example", mailboxUsernames: ["owner"] };
  const mailboxBody = { forename: "Fixture", quota: 2 };
  const batch = [{ user: "first" }, { user: "second" }];
  const prefs = { itemsPerPage: 50 };
  const { client, call, requests } = await connectFixture(t, [
    { status: 201, body: { data: [] } }, { body: { data: {} } }, { body: { data: { id: 42 } } },
    { body: { data: { id: 43 } } },
    { body: { data: [{ user: "first", success: true }, { user: "second", success: true }] } },
    { body: { data: [] } },
  ], { accessMode: "full", defaults: {
    INBOXEU_DOMAIN_NAME: "path.example",
    INBOXEU_USER_ID: "42",
    INBOXEU_CREATE_ADMIN_EMAIL: "new@example.org",
    INBOXEU_CREATE_ADMIN_LANGUAGE: "en",
    INBOXEU_CREATE_ADMIN_DOMAIN_NAME: JSON.stringify(adminDomain),
    INBOXEU_CREATE_ADMIN_IS_EMAIL_VERIFIED: "false",
    INBOXEU_CREATE_ADMIN_PASSWORD: secret,
    INBOXEU_UPDATE_PROFILE_PREFS: JSON.stringify(prefs),
    INBOXEU_UPDATE_MAILBOX_BODY: JSON.stringify(mailboxBody),
    INBOXEU_CREATE_MAILBOXES_BODY: JSON.stringify(batch),
  } });
  const { tools } = await client.listTools();
  assert.ok(!JSON.stringify(tools).includes(secret));
  const profileSchema = tools.find(tool => tool.name === "inboxeu_update_profile").inputSchema;
  assert.equal(profileSchema.minProperties ?? 0, 0);
  assert.equal(profileSchema.properties.prefs.minProperties, 1);
  for (const [name, args] of [
    ["inboxeu_create_admin", { isEmailVerified: "false" }],
    ["inboxeu_update_profile", { prefs: {} }],
  ]) {
    assert.equal((await call(name, args)).isError, true);
  }
  assert.deepEqual(await requests(), []);
  assert.deepEqual(resultData(await call("inboxeu_create_admin")), { success: true });
  assert.deepEqual(resultData(await call("inboxeu_update_profile")), { success: true });
  assert.deepEqual(resultData(await call("inboxeu_update_mailbox")), { success: true });
  const override = { userId: "43", body: { surname: "Replacement" } };
  assert.deepEqual(resultData(await call("inboxeu_update_mailbox", override)), { success: true });
  assert.equal(resultData(await call("inboxeu_create_mailboxes")).summary.requested, 2);
  const invite = { email: "invite@example.org", user: "fixture" };
  assert.deepEqual(resultData(await call("inboxeu_invite_admin", invite)), { success: true });
  assert.deepEqual((await requests()).map(({ url, body }) => ({ url, body })), [
    { url: apiRoot + "/domain_admins/", body: {
      email: "new@example.org", language: "en", domainName: adminDomain, isEmailVerified: false, password: secret,
    } },
    { url: apiRoot + "/me/", body: { prefs } },
    { url: apiRoot + "/domains/path.example/mail_users/42", body: mailboxBody },
    { url: apiRoot + "/domains/path.example/mail_users/43", body: override.body },
    { url: apiRoot + "/domains/path.example/mail_users/multi", body: batch },
    { url: apiRoot + "/invite/", body: { ...invite, hostname: "path.example" } },
  ]);
});

test("authenticated reads expose profile and 2FA status while filtering credential fields", async t => {
  const privateValue = "should-never-appear-in-mcp-results";
  const { call, requests } = await connectFixture(t, [
    { body: { data: { authenticated: true } } },
    { body: { data: { id: 73, email: "admin@example.org", apiKey: privateValue, password: privateValue } } },
    { body: { data: { isEnabled: true, secret: privateValue, qrCodeImage: privateValue } } },
  ]);
  assert.deepEqual(resultData(await call("inboxeu_check_auth")), { authenticated: true });
  const profile = await call("inboxeu_get_profile");
  const { data } = resultData(profile);
  assert.equal(data.id, 73);
  assert.equal(data.email, "admin@example.org");
  assert.ok(!JSON.stringify(profile).includes(privateValue));
  assert.deepEqual(resultData(await call("inboxeu_get_2fa_status")), { data: { isEnabled: true } });
  const captured = await requests();
  assert.deepEqual(captured.map(req => req.url), [
    apiRoot + "/security/check", apiRoot + "/me/", apiRoot + "/me/two_factor/",
  ]);
  assert.ok(captured.every(req => req.method === "GET" && req.authorization === "Bearer " + fixtureKey));
});

test("lookup tools interpret domain and admin-email status codes separately", async t => {
  const { call, requests } = await connectFixture(t, [
    { status: 404, body: { data: [] } },
    { status: 409, body: { error: "Domain already used" } },
    { status: 200, body: { data: [] } },
    { status: 422, body: { error: "Email available" } },
    { status: 404, body: { error: "Validation error" } },
  ]);
  const host = { hostName: "example.org" };
  const email = { email: "owner+admin@example.org" };
  assert.deepEqual(resultData(await call("inboxeu_check_domain", host)), { available: true });
  assert.deepEqual(resultData(await call("inboxeu_check_domain", host)), { available: false });
  assert.deepEqual(resultData(await call("inboxeu_check_admin_email", email)), { available: false });
  assert.deepEqual(resultData(await call("inboxeu_check_admin_email", email)), { available: true });
  const failed = await call("inboxeu_check_admin_email", email);
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0].text, "Could not verify the administrator email address. Check the spelling.");
  const captured = await requests();
  assert.equal(captured.length, 5);
  assert.equal(captured[0].url, apiRoot + "/domain_find/example.org");
  assert.equal(new URL(captured[2].url).searchParams.get("email"), email.email);
});

test("invoice listing preserves pagination, order, and decimal amounts and omits the invoice API key", async t => {
  const invoice = {
    orderId: 53, payer: "Admin", payerDomain: "example.org", domainId: 6,
    created: "2026-01-01T00:00:00Z", start: "2026-01-01T00:00:00Z", finish: "2026-02-01T00:00:00Z",
    quota: 1, quotaTotal: 5, invoiceNumber: "INV-12", sum: "10.90", currency: "EUR",
    apiKey: "private-invoice-key", productName: "Business",
  };
  const { call, requests } = await connectFixture(t, [{ body: { data: [invoice] } }]);
  const result = await call("inboxeu_list_invoices", {
    domainName: "example.org", order_direction: "asc", limit: 20, offset: 0,
  });
  const { data } = resultData(result);
  assert.equal(data.length, 1);
  assert.equal(data[0].sum, "10.90");
  assert.equal(data[0].invoiceNumber, "INV-12");
  assert.ok(!JSON.stringify(result).includes(invoice.apiKey));
  const [request] = await requests();
  const url = new URL(request.url);
  assert.equal(url.pathname, "/api/v1/domains/example.org/transactions/");
  assert.equal(url.searchParams.get("order_direction"), "asc");
  assert.equal(url.searchParams.get("limit"), "20");
  assert.equal(url.searchParams.get("offset"), "0");
});

test("full mode from .env exposes all described operations and never retries failed invitations", async t => {
  const { client, call, requests } = await connectFixture(t, [
    { body: { data: { token: "private-refresh-token" } } }, { status: 503 },
  ], { accessMode: "full", mode: { pin: "2026-07-28" } });
  assert.equal(client.getProtocolEra(), "modern");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...readTools, ...writeTools].sort());
  assert.ok(tools.filter(tool => writeTools.includes(tool.name)).every(tool => !tool.annotations?.readOnlyHint));
  for (const name of ["inboxeu_delete_mailbox", "inboxeu_delete_profile", "inboxeu_remove_domain_admin"]) {
    assert.equal(tools.find(tool => tool.name === name).annotations.destructiveHint, true);
  }
  assert.deepEqual(resultData(await call("inboxeu_update_profile", { language: "lv" })), { success: true });
  const invitation = { email: "invited@example.org", user: "admin", hostname: "example.org" };
  const failure = await call("inboxeu_invite_admin", invitation);
  assert.equal(failure.isError, true);
  assert.equal(failure.content[0].text, "Inbox.eu encountered a server error. The change may have been applied. Check Inbox.eu before retrying.");
  const captured = await requests();
  assert.deepEqual(captured.map(({ method, url, body }) => ({ method, url, body })), [
    { method: "PUT", url: apiRoot + "/me/", body: { language: "lv" } },
    { method: "POST", url: apiRoot + "/invite/", body: invitation },
  ]);
});

test("a read-only launch overrides a full .env and process settings cannot grant access", async t => {
  for (const opts of [
    { accessMode: "full", cliMode: "read-only" },
    { env: { INBOXEU_ENABLE_WRITES: "true" } },
    { env: { INBOXEU_MODE: "full", INBOXEU_API_KEY: "process-only-fixture-key" } },
  ]) {
    const { client, call, requests } = await connectFixture(t, [], { ...opts, apiKey: null });
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), readTools);
    await assert.rejects(call("inboxeu_delete_profile"));
    const auth = await call("inboxeu_check_auth");
    assert.equal(auth.isError, true);
    assert.match(auth.content[0].text, /INBOXEU_API_KEY/);
    assert.deepEqual(await requests(), []);
  }
});

test("full launch dispatches mailbox details and deletion to Inbox.eu over HTTPS", async t => {
  const { call, requests } = await connectFixture(t, [
    { body: { data: [] } }, { body: { data: true } },
  ], { accessMode: "read-only", cliMode: "full" });
  const mailbox = { domainName: "example.org", userId: "42" };
  // The provider's MailUserDetails schema is an open object.
  const body = { fixtureField: "value" };
  assert.deepEqual(resultData(await call("inboxeu_send_mailbox_details", { ...mailbox, body })), { success: true });
  assert.deepEqual(resultData(await call("inboxeu_delete_mailbox", mailbox)), { success: true });
  assert.deepEqual((await requests()).map(({ url, method, body }) => ({ url, method, body })), [
    { url: apiRoot + "/domains/example.org/mail_users/42/details", method: "POST", body },
    { url: apiRoot + "/domains/example.org/mail_users/42", method: "DELETE", body: null },
  ]);
});

test("mailbox creation reports a rejected row and withholds its password and provider message", async t => {
  const user = { user: "fixture-mail", password: "fixture-secret", forename: "First", surname: "Last" };
  const { call, requests } = await connectFixture(t, [{ body: { data: {
    isSuccessful: false, created: [], failed: [{ message: "Could not create user. Reason: You can make maximum 2 premium users\n", user }],
  } } }], { accessMode: "full" });
  const result = await call("inboxeu_create_mailboxes", { domainName: "example.org", body: [user] });
  const message = "Premium mailbox limit reached (2).";
  assert.equal(result.content[0].text, message);
  assert.deepEqual(result.structuredContent, {
    data: [{ user: "fixture-mail", outcome: "failed", message }],
    summary: { requested: 1, reported: 1, succeeded: 0, failed: 1, unknown: 0 },
  });
  assert.equal((await requests()).length, 1);
});

test("a mailbox update confirms only the ID from the requested path and never retries an uncertain write", async t => {
  const { call, requests } = await connectFixture(t, [
    { body: { data: { id: 42 } } },
    { body: { data: { id: 43 } } },
    { body: { data: { id: 42, error: "private provider message" } } },
  ], { accessMode: "full" });
  const args = { domainName: "example.org", userId: "42", body: { id: 43, forename: "Fixture" } };
  assert.deepEqual(resultData(await call("inboxeu_update_mailbox", args)), { success: true });
  for (const attempt of [2, 3]) {
    const result = await call("inboxeu_update_mailbox", args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /The change may have been applied/);
    assert.doesNotMatch(result.content[0].text, /private provider message/);
    assert.equal((await requests()).length, attempt);
  }
  for (const req of await requests()) {
    assert.equal(req.method, "PUT");
    assert.equal(req.url, apiRoot + "/domains/example.org/mail_users/42");
    assert.deepEqual(req.body, args.body);
  }
});

test("partial results and an inconclusive token check have readable text and structured details", async t => {
  const { call } = await connectFixture(t, [
    { body: { data: { created: [{ user: "fixture-one" }], failed: [{ message: "private provider detail" }] } } },
    { body: { data: [] } },
  ], { accessMode: "full" });
  const batch = await call("inboxeu_create_mailboxes", {
    domainName: "example.org", body: [{ user: "fixture-one" }, { user: "fixture-two" }, { user: "fixture-three" }],
  });
  assert.equal(batch.content[0].text, "1 created, 1 failed, 1 unconfirmed.");
  assert.equal(batch.structuredContent.data[1].message, "Mailbox creation failed.");
  assert.doesNotMatch(JSON.stringify(batch), /private provider detail/);
  const check = await call("inboxeu_validate_impersonation_token", {
    domainName: "example.org", userId: "42", impersonationToken: "fixture-token", body: {},
  });
  assert.equal(check.structuredContent.valid, null);
  assert.equal(check.content[0].text, "Inbox.eu did not report whether the token is valid.");
  assert.doesNotMatch(JSON.stringify(check), /httpStatus|\b200\b|fixture-token/);
});
