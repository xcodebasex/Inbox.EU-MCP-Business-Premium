import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { operations } from "../src/operations.js";

const spec = JSON.parse(readFileSync(new URL("../inboxeu-openapi.json", import.meta.url), "utf8"));
const byName = new Map(operations.map(op => [op.name, op]));

function sorted(values) {
  return [...values].sort();
}

function validate(op, input) {
  return fromJsonSchema(op.inputSchema)["~standard"].validate(input);
}

function resolveSchema(schema) {
  return schema.$ref ? spec.components.schemas[schema.$ref.split("/").at(-1)] : schema;
}

function compareForm(actual, reference) {
  const declared = resolveSchema(reference);
  assert.equal(actual.type, declared.type);
  if (declared.enum) assert.deepEqual(actual.enum, declared.enum);
  if (declared.items) compareForm(actual.items, declared.items);
  if (!declared.properties) {
    if (declared.type === "object") assert.equal(actual.additionalProperties, true);
    return;
  }
  assert.equal(actual.additionalProperties, false);
  assert.deepEqual(sorted(actual.required), sorted(declared.required ?? []));
  assert.deepEqual(sorted(Object.keys(actual.properties)), sorted(Object.keys(declared.properties)));
  for (const [key, child] of Object.entries(actual.properties)) {
    compareForm(child, declared.properties[key]);
  }
}

test("every described OpenAPI operation has one tool with the corresponding HTTP method, parameters and JSON body", () => {
  const documented = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).filter(([, endpoint]) => endpoint.summary)
      .map(([method]) => method.toUpperCase() + " " + path));
  assert.equal(byName.size, operations.length);
  // Both directory routes were verified against the live API but are absent from the bundled spec.
  const directoryPaths = {
    inboxeu_list_mailboxes: "/api/v1/domains/{domainName}/mail_users/",
    inboxeu_list_domains: "/api/v1/domains/",
  };
  for (const [name, path] of Object.entries(directoryPaths)) {
    assert.equal(byName.get(name).method, "GET");
    assert.equal(byName.get(name).path, path);
  }
  const published = operations.filter(op => !Object.hasOwn(directoryPaths, op.name));
  assert.deepEqual(sorted(published.map(op => op.method + " " + op.path)), sorted(documented));
  for (const op of published) {
    const endpoint = spec.paths[op.path][op.method.toLowerCase()];
    const params = endpoint.parameters ?? [];
    const body = endpoint.requestBody?.content["application/json"].schema;
    const schema = op.inputSchema;
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    if (body && resolveSchema(body).properties) {
      // The named administrator forms are the entire tool input.
      assert.equal(params.length, 0);
      compareForm(schema, body);
    } else {
      const keys = params.map(p => p.name);
      if (op.name === "inboxeu_get_mailbox") keys.push("mailboxEmail");
      const required = params.filter(p => p.required).map(p => p.name);
      if (body) {
        keys.push("body");
        if (endpoint.requestBody.required) required.push("body");
        compareForm(schema.properties.body, body);
      }
      assert.deepEqual(sorted(Object.keys(schema.properties)), sorted(keys), op.name);
      assert.deepEqual(sorted(schema.required), sorted(required), op.name);
      for (const p of params) assert.equal(schema.properties[p.name].type, p.schema.type);
    }
  }
});

test("wire requests retain documented paths, encoded IDs, queries and JSON bodies", async () => {
  const admin = "Admin+1@example.org";
  const email = "Sales+eu@bücher.example";
  const normalizedEmail = "Sales+eu@xn--bcher-kva.example";
  const query = { offset: 0, limit: 20, order_column: "start", order_direction: "asc", unexpired: "0" };
  const prefs = { itemsPerPage: 100, userSortField: "forename", userSortOrder: "asc" };
  const mailbox = { domainName: "example.org", userId: "abc+1" };
  const mailboxPath = "/api/v1/domains/example.org/mail_users/abc%2B1";
  const body = { providerField: { nested: ["value"] } };
  const cases = [
    ["inboxeu_check_auth", {}, { path: "/api/v1/security/check" }],
    ["inboxeu_get_profile", {}, { path: "/api/v1/me/" }],
    ["inboxeu_get_2fa_status", {}, { path: "/api/v1/me/two_factor/" }],
    ["inboxeu_get_admin", { domainAdmin: admin }, { path: "/api/v1/domain_admins/Admin%2B1%40example.org" }],
    ["inboxeu_get_domain_admin", { domainName: "BÜCHER.example", domainAdmin: admin },
      { path: "/api/v1/domains/xn--bcher-kva.example/domain_admins/Admin%2B1%40example.org" }],
    ["inboxeu_get_mailbox", { domainName: "EXAMPLE.org", userId: "12?name#x", mailboxEmail: "sales@example.org" },
      { path: "/api/v1/domains/example.org/mail_users/12%3Fname%23x" }],
    ["inboxeu_list_domains", {}, { path: "/api/v1/domains/" }],
    ["inboxeu_list_mailboxes", { domainName: "EXAMPLE.org", limit: 100, offset: 10 },
      { path: "/api/v1/domains/example.org/mail_users/", query: { limit: 100, offset: 10 } }],
    ["inboxeu_list_invoices", { domainName: "example.org", ...query },
      { path: "/api/v1/domains/example.org/transactions/", query }],
    ["inboxeu_check_domain", { hostName: "example.org." }, { path: "/api/v1/domain_find/example.org" }],
    ["inboxeu_check_admin_email", { email }, { path: "/api/v1/emails/admin", query: { email: normalizedEmail } }],
    ["inboxeu_create_admin", { email, language: "lv", password: "fixture", isEmailVerified: false,
      domainName: { name: "BÜCHER.example", mailboxUsernames: ["info"] } },
      { path: "/api/v1/domain_admins/", body: { email: normalizedEmail, language: "lv", password: "fixture", isEmailVerified: false,
        domainName: { name: "xn--bcher-kva.example", mailboxUsernames: ["info"] } } }],
    ["inboxeu_update_profile", { language: "fr", firstName: "", prefs, plainPassword: "fixture", tos: true },
      { path: "/api/v1/me/", body: { language: "fr", firstName: "", prefs, plainPassword: "fixture", tos: true } }],
    ["inboxeu_invite_admin", { email, hostname: "BÜCHER.example", user: "admin" },
      { path: "/api/v1/invite/", body: { email: normalizedEmail, hostname: "xn--bcher-kva.example", user: "admin" } }],
    ["inboxeu_delete_profile", {}, { path: "/api/v1/me/" }],
    ["inboxeu_enable_2fa", {}, { path: "/api/v1/me/two_factor/" }],
    ["inboxeu_disable_2fa", {}, { path: "/api/v1/me/two_factor/" }],
    ["inboxeu_update_mailbox", { ...mailbox, body }, { path: mailboxPath, body }],
    ["inboxeu_delete_mailbox", mailbox, { path: mailboxPath }],
    ["inboxeu_create_mailboxes", { domainName: "example.org", body: [body, {}] },
      { path: "/api/v1/domains/example.org/mail_users/multi", body: [body, {}] }],
    ["inboxeu_create_impersonation_token", { ...mailbox, body }, { path: mailboxPath + "/impersonation/impersonate", body }],
    ["inboxeu_validate_impersonation_token", { ...mailbox, body: {}, impersonationToken: "fake+/=" },
      { path: mailboxPath + "/impersonation/validate", body: {}, query: { impersonationToken: "fake+/=" } }],
    ["inboxeu_send_mailbox_details", { ...mailbox, body }, { path: mailboxPath + "/details", body }],
    ["inboxeu_update_mailbox_filters", mailbox, { path: mailboxPath + "/filters" }],
    ["inboxeu_remove_domain_admin", { domainName: "example.org", domainAdmin: admin },
      { path: "/api/v1/domains/example.org/domain_admins/Admin%2B1%40example.org" }],
  ];
  assert.deepEqual(sorted(cases.map(([name]) => name)), sorted(byName.keys()));
  for (const [name, input, expected] of cases) {
    const op = byName.get(name);
    assert.equal((await validate(op, input)).issues, undefined, name);
    assert.deepEqual(op.build(input), expected, name);
  }
  assert.deepEqual(byName.get("inboxeu_list_invoices").build({ domainName: "example.org" }),
    { path: "/api/v1/domains/example.org/transactions/" });
});

test("tool schemas reject unknown fields, incorrect paging types and malformed request bodies", async () => {
  const cases = [
    ["inboxeu_check_auth", { token: "x" }],
    ["inboxeu_list_domains", { domainName: "other.example" }],
    ["inboxeu_list_mailboxes", { domainName: "example.org", limit: 0 }],
    ["inboxeu_list_mailboxes", { domainName: "example.org", limit: 101 }],
    ["inboxeu_list_mailboxes", { domainName: "example.org", offset: -1 }],
    ["inboxeu_list_mailboxes", { domainName: "example.org", offset: 0.5 }],
    ["inboxeu_list_invoices", { domainName: "example.org", limit: -1 }],
    ["inboxeu_list_invoices", { domainName: "example.org", offset: 0.5 }],
    ["inboxeu_list_invoices", { domainName: "example.org", unexpired: false }],
    ["inboxeu_create_admin", { email: "a@example.org", language: "en", password: false }],
    ["inboxeu_create_admin", { email: "a@example.org", language: "en", isEmailVerified: "true" }],
    ["inboxeu_create_admin", { email: "a@example.org", language: "en", domainName: { mailboxUsers: [] } }],
    ["inboxeu_create_admin", { language: "en" }],
    ["inboxeu_update_profile", {}],
    ["inboxeu_update_profile", { prefs: {} }],
    ["inboxeu_update_profile", { prefs: { itemsPerPage: 42 } }],
    ["inboxeu_update_profile", { prefs: { itemsPerPage: 50, role: "admin" } }],
    ["inboxeu_update_profile", { plainPassword: {} }],
    ["inboxeu_update_profile", { tos: false }],
    ["inboxeu_invite_admin", { email: "a@example.org", hostname: "example.org" }],
    ["inboxeu_create_mailboxes", { domainName: "example.org", body: {} }],
    ["inboxeu_create_mailboxes", { domainName: "example.org", body: [null] }],
    ["inboxeu_create_impersonation_token", { domainName: "example.org", userId: "id" }],
    ["inboxeu_validate_impersonation_token", { domainName: "example.org", userId: "id", body: {} }],
    ["inboxeu_update_mailbox_filters", { domainName: "example.org", userId: "id", body: {} }],
  ];
  for (const [name, args] of cases) {
    assert.ok((await validate(byName.get(name), args)).issues, name);
  }
});

test("numeric DNS labels retain their identity through IDNA conversion", () => {
  const op = byName.get("inboxeu_check_domain");
  for (const [hostName, expected] of [["123", "123"], ["127.1", "127.1"],
    ["0x7f.01", "0x7f.01"], ["１２３", "123"]]) {
    assert.deepEqual(op.build({ hostName }), { path: "/api/v1/domain_find/" + expected });
  }
});

test("identifiers and hostnames cannot change the request path or authority", () => {
  const op = byName.get("inboxeu_get_mailbox");
  for (const userId of [".", "..", "../admin", "a/b", "a\\b", "%2f", "%252e%252e", "x\n", "\ud800"]) {
    assert.throws(() => op.build({ domainName: "example.org", userId }),
      { message: "Enter a valid Inbox.eu identifier." });
  }
  for (const domainName of ["", ".", "..", "a..b", "x@y", "ok.org/evil", "ok.org:443", "-x.org",
    "ok.org?key=1", "a".repeat(64) + ".example", "ok.org\\evil", "%2e%2e", "x\u0000y.org"]) {
    assert.throws(() => op.build({ domainName, userId: "1" }), { message: "Enter a valid domain name." });
  }
});

test("email validation applies to lookups, creation and invitations", () => {
  const op = byName.get("inboxeu_check_admin_email");
  for (const email of ["x", "foo@@bar.org", ".bad@example.org", "x@bad..example", "a".repeat(65) + "@example.org"]) {
    assert.throws(() => op.build({ email }), { message: "Enter a valid email address." });
  }
  assert.throws(() => byName.get("inboxeu_create_admin").build({ email: "x", language: "en" }), TypeError);
  assert.throws(() => byName.get("inboxeu_invite_admin").build({ email: "x", user: "1", hostname: "example.org" }), TypeError);
});

test("address validation preserves a single mailbox and excludes extra recipients and header injection", () => {
  const check = byName.get("inboxeu_check_admin_email");
  assert.equal(check.build({ email: "a.b+send@bücher.example" }).query.email, "a.b+send@xn--bcher-kva.example");
  for (const value of ["user@example.org\r\nBcc: another@example.org", "a@example.org\n",
    "a\r\n@example.org", "user@example.org,other@example.org", "Name <user@example.org>"]) {
    assert.throws(() => check.build({ email: value }), TypeError);
  }
});
