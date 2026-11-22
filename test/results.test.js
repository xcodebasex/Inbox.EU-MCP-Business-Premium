import assert from "node:assert/strict";
import test from "node:test";
import { projectResult } from "../src/results.js";

function project(tool, data) {
  return projectResult(tool, { status: 200, data: { data } });
}

test("mailbox output accepts individual and tabular records and discards unknown fields", () => {
  const account = { id: 8, email: "mail@example.org", recoveryCodes: ["private"], quota: { token: "private" } };
  const visible = { id: 8, email: "mail@example.org" };
  assert.deepEqual(project("inboxeu_get_mailbox", account), { data: visible });
  assert.deepEqual(project("inboxeu_get_mailbox", [account]), { data: [visible] });
  assert.deepEqual(project("inboxeu_get_mailbox", []), { data: [] });
  assert.throws(() => project("inboxeu_get_mailbox", { recoveryCodes: ["private"] }));
});

test("address lookups confirm the returned mailbox and expose only public metadata", () => {
  const target = { domainName: "example.org", userId: "123", mailboxEmail: "info@example.org" };
  const row = { id: 123, user: "info", is_premium: true, pop3_password: "private", prefs: { password: "private" } };
  const lookup = data => projectResult("inboxeu_get_mailbox", { status: 200, data: { data } }, target);
  const verified = { id: 123, user: "info", email: "info@example.org", is_premium: true };
  assert.deepEqual(lookup(row), { data: verified });
  assert.deepEqual(lookup([row]), { data: [verified] });
  for (const bad of [[], [row, row], { id: 123 }, { ...row, id: 234 }, { ...row, user: "other" },
    { ...row, email: "other@example.org" }, { ...row, domainName: "other.example" }]) {
    assert.throws(() => lookup(bad), /did not confirm the requested mailbox/);
  }
});

test("only public profile preferences are returned and malformed 2FA state is never reported as disabled", () => {
  const profile = { id: 1, domainSuperpass: { admin: "secret" }, prefs: { itemsPerPage: 20, session: "secret" } };
  assert.deepEqual(project("inboxeu_get_profile", profile), { data: { id: 1, prefs: { itemsPerPage: 20 } } });
  assert.throws(() => project("inboxeu_get_2fa_status", { secret: "secret" }));
  assert.deepEqual(project("inboxeu_get_2fa_status", { isEnabled: false }), { data: { isEnabled: false } });
});

test("authentication preserves the explicit boolean and accepts the documented array response", () => {
  assert.deepEqual(project("inboxeu_check_auth", { authenticated: true, token: "private" }), { authenticated: true });
  assert.deepEqual(project("inboxeu_check_auth", { authenticated: false, token: "private" }),
    { authenticated: false, message: "Check your Inbox.eu API key." });
  assert.deepEqual(project("inboxeu_check_auth", []), { authenticated: true });
  for (const data of [null, true, false, {}, { authenticated: "false" }, { authenticated: 1 }]) {
    assert.throws(() => project("inboxeu_check_auth", data), /unexpected response/);
  }
});

test("unexpected success payloads do not confirm writes", () => {
  assert.throws(() => project("inboxeu_update_profile", null), /before retrying/);
  assert.throws(() => project("inboxeu_create_admin", false), /before retrying/);
  assert.deepEqual(project("inboxeu_create_admin", [{ password: "private" }]), { success: true });
});

test("only explicit 2FA setup returns enrollment material, with a single usable representation", () => {
  const fields = { isEnabled: false, secret: "SETUP-KEY", qrCodeImage: "QR", recoveryCodes: ["private"] };
  assert.deepEqual(project("inboxeu_enable_2fa", fields), { data: { isEnabled: false, secret: "SETUP-KEY" } });
  assert.deepEqual(project("inboxeu_enable_2fa", { ...fields, secret: null }),
    { data: { isEnabled: false, qrCodeImage: "QR" } });
  assert.deepEqual(project("inboxeu_get_2fa_status", fields), { data: { isEnabled: false } });
  assert.throws(() => project("inboxeu_enable_2fa", { setup: "private" }), /before retrying/);
});

test("impersonation operations return only an unambiguous issued token or a reported validity", () => {
  const issued = "issued-for-mailbox";
  for (const data of [[issued], [{ token: issued, apiKey: "private" }], [{ impersonationToken: issued }]]) {
    assert.deepEqual(project("inboxeu_create_impersonation_token", data), { impersonationToken: issued });
  }
  for (const data of [[], ["token1", "token2"], [{ token: "one", impersonationToken: "two" }], [{ apiKey: "private" }]]) {
    assert.throws(() => project("inboxeu_create_impersonation_token", data), /before retrying/);
  }
  for (const value of [true, false]) {
    assert.deepEqual(project("inboxeu_validate_impersonation_token", [{ valid: value, token: issued }]), { valid: value });
    assert.deepEqual(project("inboxeu_validate_impersonation_token", [value]), { valid: value });
  }
  for (const data of [[], [{ secret: "private" }], [{ valid: false, isValid: true }]]) {
    assert.deepEqual(project("inboxeu_validate_impersonation_token", data),
      { valid: null, message: "Inbox.eu did not report whether the token is valid." });
  }
});

test("batch summary distinguishes reported successes, failures and unknown outcomes from unreported rows", () => {
  const data = [
    { userId: 3, username: "one", success: true, password: "generated-secret" },
    { username: "two", errorMessages: ["rejected generated-secret"], success: true },
    { username: "three", status: "active", apiKey: "secret" },
    null,
  ];
  const result = projectResult("inboxeu_create_mailboxes", { status: 200, data: { data } }, { requestedCount: 5 });
  assert.deepEqual(result, {
    data: [
      { userId: 3, username: "one", outcome: "succeeded" },
      { username: "two", outcome: "failed", message: "Mailbox creation failed." },
      { username: "three", outcome: "unknown", message: "Check whether the mailbox was created before retrying." },
      { outcome: "unknown", message: "Check whether the mailbox was created before retrying." },
    ],
    summary: { requested: 5, reported: 4, succeeded: 1, failed: 1, unknown: 2 },
  });
  assert.throws(() => project("inboxeu_create_mailboxes", {}), /before retrying/);
});

test("grouped mailbox results count partial failures and keep only safe row details", () => {
  const data = {
    isSuccessful: false,
    created: [
      { user: "one", userId: 1, password: "private" },
      { username: "two", success: false },
      { user: { username: "three", created: false } },
      { id: false, email: "provider message", apiKey: "private" },
      null,
    ],
    failed: [{ message: "quota reached", success: true, user: { user: "four", password: "private" } }],
  };
  assert.deepEqual(projectResult("inboxeu_create_mailboxes", { status: 200, data: { data } }, { requestedCount: 7 }), {
    data: [
      { user: "one", userId: 1, outcome: "succeeded" },
      { username: "two", outcome: "unknown", message: "Check whether the mailbox was created before retrying." },
      { username: "three", outcome: "unknown", message: "Check whether the mailbox was created before retrying." },
      { outcome: "unknown", message: "Check whether the mailbox was created before retrying." },
      { outcome: "unknown", message: "Check whether the mailbox was created before retrying." },
      { user: "four", outcome: "failed", message: "Mailbox creation failed." },
    ],
    summary: { requested: 7, reported: 6, succeeded: 1, failed: 1, unknown: 4 },
  });
  assert.deepEqual(project("inboxeu_create_mailboxes", { created: [], failed: [] }), {
    data: [], summary: { requested: null, reported: 0, succeeded: 0, failed: 0, unknown: 0 },
  });
});

test("the exact premium mailbox quota reason exposes just its numeric limit", () => {
  const reason = "Could not create user. Reason: You can make maximum 2 premium users";
  const grouped = message => project("inboxeu_create_mailboxes", {
    created: [], failed: [{ user: { username: "alex", password: "private" }, message }],
  }).data[0];
  assert.deepEqual(grouped(reason + "\n"), {
    username: "alex", outcome: "failed", message: "Premium mailbox limit reached (2).",
  });
  const flat = project("inboxeu_create_mailboxes", [{ errorMessages: [reason.replace("2", "13")] }]);
  assert.deepEqual(flat.data, [{ outcome: "failed", message: "Premium mailbox limit reached (13)." }]);
  for (const message of ["private " + reason, reason + "\nprivate", reason.replace("2", "2 private"), { reason }]) {
    assert.deepEqual(grouped(message), {
      username: "alex", outcome: "failed", message: "Mailbox creation failed.",
    });
  }
});

test("incomplete or contradictory grouped mailbox results leave the write outcome uncertain", () => {
  for (const data of [
    { created: [] }, { failed: [] }, { created: {}, failed: [] }, { created: [], failed: null },
    { isSuccessful: false, created: [{ user: "one" }], failed: [] },
    { isSuccessful: false, created: [], failed: [] },
  ]) {
    assert.throws(() => project("inboxeu_create_mailboxes", data), /before retrying/);
  }
});

test("a mailbox update object must unambiguously acknowledge the requested mailbox ID", () => {
  const update = (data, userId) => projectResult("inboxeu_update_mailbox", { status: 200, data: { data } }, { userId });
  for (const data of [{ id: 42 }, { id: "42" }]) assert.deepEqual(update(data, "42"), { success: true });
  assert.deepEqual(update({ id: "9007199254740993" }, "9007199254740993"), { success: true });
  for (const [data, userId] of [
    [{ id: "42" }, undefined], [{ id: "" }, ""], [{ id: 42 }, "042"], [{ id: 43 }, "42"], [{}, "42"],
    [{ id: null }, "null"], [{ id: true }, "true"], [{ id: [42] }, "42"], [{ id: 1.5 }, "1.5"],
    [{ id: -1 }, "-1"], [{ id: 2 ** 53 }, String(2 ** 53)], [{ id: 42, success: false }, "42"],
  ]) {
    assert.throws(() => update(data, userId), /The change may have been applied/);
  }
  assert.throws(() => project("inboxeu_update_mailbox_filters", { id: 42 }), /The change may have been applied/);
});

test("deletion reflects the returned boolean and array-based acknowledgements do not expose fields", () => {
  for (const [name, message] of [
    ["inboxeu_delete_mailbox", "Inbox.eu could not delete the mailbox."],
    ["inboxeu_delete_profile", "Inbox.eu could not delete the profile."],
  ]) {
    assert.deepEqual(project(name, false), { success: false, message });
    assert.deepEqual(project(name, true), { success: true });
    assert.throws(() => project(name, []), /before retrying/);
  }
  for (const name of ["inboxeu_disable_2fa", "inboxeu_update_mailbox", "inboxeu_send_mailbox_details",
    "inboxeu_update_mailbox_filters", "inboxeu_remove_domain_admin"]) {
    assert.deepEqual(project(name, [{ password: "private" }]), { success: true });
    assert.throws(() => project(name, false), /before retrying/);
    assert.throws(() => project(name, [{ errors: { password: "private" } }]), error => {
      assert.doesNotMatch(error.message, /private/);
      return /before retrying/.test(error.message);
    });
  }
});
