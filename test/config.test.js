import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { argumentEnvName, loadConfig } from "../src/config.js";
import { operations } from "../src/operations.js";

async function makeEnvFile(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "inboxeu-config-"));
  const file = path.join(dir, ".env");
  t.after(async () => { await rm(file, { force: true }); await rmdir(dir); });
  return file;
}

function setProcessSettings(t, settings) {
  for (const [key, value] of Object.entries(settings)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

test("the default .env follows the installed server, even when its client starts elsewhere", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "inboxeu-config-"));
  const module = path.join(dir, "src", "config.mjs");
  const operationsFile = path.join(dir, "src", "operations.js");
  const manifest = path.join(dir, "package.json");
  const file = path.join(dir, ".env");
  await mkdir(path.dirname(module));
  await copyFile(new URL("../src/config.js", import.meta.url), module);
  await copyFile(new URL("../src/operations.js", import.meta.url), operationsFile);
  await writeFile(manifest, '{"type":"module"}');
  t.after(async () => {
    await rm(file, { force: true });
    await rm(module);
    await rm(operationsFile);
    await rm(manifest);
    await rmdir(path.dirname(module));
    await rmdir(dir);
  });
  const { loadConfig: loadIsolatedConfig } = await import(pathToFileURL(module));
  setProcessSettings(t, {
    INBOXEU_API_KEY: "environment-key",
    INBOXEU_MODE: "full",
    INBOXEU_ENABLE_WRITES: "true",
    INBOXEU_DOMAIN_NAME: "env.example",
    INBOXEU_DOMAINS: '["env.example"]',
    INBOXEU_USER_ID: "0007",
    INBOXEU_DOMAIN_ADMIN: "test-admin",
    INBOXEU_LIST_INVOICES_OFFSET: "1",
    INBOXEU_UPDATE_MAILBOX_BODY: "invalid",
    INBOXEU_IMPERSONATION_TOKEN: "environment-token",
  });
  const { readApiKey, ...catalog } = loadIsolatedConfig([]);
  assert.deepEqual(catalog, {
    mode: "read-only", legacyWrites: false, domains: new Map(), toolDefaults: {},
  });
  assert.equal(readApiKey(), undefined);
  await writeFile(file, '\uFEFF# Test settings\r\nINBOXEU_API_KEY="fixture#123"\r\nINBOXEU_MODE=read-only\r\n');
  assert.equal(readApiKey(), "fixture#123");
  const full = loadIsolatedConfig(["--mode", "full"]);
  assert.equal(full.mode, "full");
  assert.deepEqual(full.toolDefaults, {});
  await writeFile(file, "INBOXEU_ENABLE_WRITES=true\n");
  assert.equal(loadIsolatedConfig([]).legacyWrites, true);
  assert.equal(loadIsolatedConfig(["--mode", "read-only"]).legacyWrites, false);
  await writeFile(file, "INBOXEU_MODE=sensitive-invalid-value\n");
  assert.throws(() => loadIsolatedConfig([]), err =>
    err.message.includes("INBOXEU_MODE") && !err.message.includes("sensitive-invalid-value"));
});

test("an explicit missing configuration file stops startup", () => {
  const missing = path.join(tmpdir(), "inboxeu-missing-" + randomUUID(), ".env");
  assert.throws(() => loadConfig(["--env-file", missing]), /read the .env file/);
});

test("live credential reads reject changed permissions and target defaults until restart", async t => {
  const file = await makeEnvFile(t);
  const base = "INBOXEU_MODE=full\nINBOXEU_DOMAINS='[\"one.example\"]'\nINBOXEU_USER_ID=001\n";
  await writeFile(file, base + "INBOXEU_API_KEY=first-fixture-key\n");
  const { readApiKey } = loadConfig(["--env-file", file]);
  for (const changed of [
    base.replace("full", "read-only"), base.replace("one.example", "two.example"), base.replace("001", "002"),
  ]) {
    await writeFile(file, changed + "INBOXEU_API_KEY=second-fixture-key\n");
    assert.throws(readApiKey, { message: "Inbox.eu settings changed. Restart the MCP server to load the new configuration." });
  }
  await rm(file);
  assert.throws(readApiKey, /read the .env file/);
  await writeFile(file, base + "INBOXEU_API_KEY=second-fixture-key\n");
  assert.equal(readApiKey(), "second-fixture-key");
});

test("the template lists every configurable argument without setting any target or payload", async () => {
  const settings = parseEnv(await readFile(new URL("../.env.example", import.meta.url), "utf8"));
  const variables = new Set(operations.flatMap(op =>
    Object.keys(op.inputSchema.properties).map(field => argumentEnvName(op, field))));
  for (const variable of variables) assert.equal(settings[variable], "", variable);
  assert.equal(settings.INBOXEU_DOMAINS, "");
  assert.deepEqual(Object.keys(settings).sort(), ["INBOXEU_API_KEY", "INBOXEU_MODE", "INBOXEU_DOMAINS", ...variables].sort());
});

test("tool defaults come from the file, and invalid JSON identifies only the variable", async t => {
  const file = await makeEnvFile(t);
  const argv = ["--env-file", file];
  setProcessSettings(t, { INBOXEU_DOMAIN_NAME: "env.example", INBOXEU_USER_ID: "42", INBOXEU_LIST_INVOICES_LIMIT: "9" });
  await writeFile(file, "INBOXEU_DOMAIN_NAME=file.example\nINBOXEU_USER_ID=\nINBOXEU_LIST_INVOICES_OFFSET=0\n");
  const { toolDefaults } = loadConfig(argv);
  assert.deepEqual(toolDefaults.inboxeu_get_mailbox, { domainName: "file.example" });
  assert.deepEqual(toolDefaults.inboxeu_list_invoices, { domainName: "file.example", offset: 0 });
  for (const body of ["private-invalid-json", "null", "[]"]) {
    await writeFile(file, `INBOXEU_UPDATE_MAILBOX_BODY=${body}\n`);
    assert.doesNotThrow(() => loadConfig(argv));
    assert.throws(() => loadConfig([...argv, "--mode", "full"]), {
      message: "Invalid INBOXEU_UPDATE_MAILBOX_BODY. Expected a JSON value of type object.",
    });
  }
});

test("domain lists normalize names and supply shared defaults only for a single configured domain", async t => {
  const file = await makeEnvFile(t);
  const argv = ["--env-file", file, "--mode", "full"];
  for (const value of ["", "  ", "[]", "{}"]) {
    await writeFile(file, `INBOXEU_DOMAINS='${value}'\n`);
    assert.deepEqual(loadConfig(argv).domains, new Map());
    assert.deepEqual(loadConfig(argv).toolDefaults, {});
  }
  await writeFile(file, `INBOXEU_DOMAINS='["Bücher.Example.","SECOND.example"]'\n`);
  const multiple = loadConfig(argv);
  assert.deepEqual(multiple.domains, new Map([["xn--bcher-kva.example", []], ["second.example", []]]));
  assert.deepEqual(multiple.toolDefaults, {});

  await writeFile(file, `INBOXEU_DOMAINS='["Bücher.Example."]'\nINBOXEU_DOMAIN_NAME=\n`);
  const { toolDefaults } = loadConfig(argv);
  assert.deepEqual(toolDefaults.inboxeu_get_mailbox, { domainName: "xn--bcher-kva.example" });
  assert.deepEqual(toolDefaults.inboxeu_check_domain, { hostName: "xn--bcher-kva.example" });
  assert.deepEqual(toolDefaults.inboxeu_invite_admin, { hostname: "xn--bcher-kva.example" });
  assert.equal(toolDefaults.inboxeu_create_admin, undefined);

  await writeFile(file, `INBOXEU_DOMAINS='["single.example"]'\nINBOXEU_DOMAIN_NAME=OTHER.example.\n`);
  assert.deepEqual(loadConfig(argv).toolDefaults.inboxeu_get_mailbox, { domainName: "other.example" });
});

test("domain mappings preserve per-domain mailbox IDs and validate a selected default", async t => {
  const file = await makeEnvFile(t);
  const argv = ["--env-file", file];
  const mapping = `INBOXEU_DOMAINS='{"ONE.example.":["001","1","abc+2"],"two.example":["001"]}'\n`;
  await writeFile(file, mapping + "INBOXEU_DOMAIN_NAME=One.Example\nINBOXEU_USER_ID=001\n");
  const config = loadConfig(argv);
  assert.deepEqual(config.domains, new Map([["one.example", ["001", "1", "abc+2"]], ["two.example", ["001"]]]));
  assert.deepEqual(config.toolDefaults.inboxeu_get_mailbox, { domainName: "one.example", userId: "001" });
  await writeFile(file, mapping + "INBOXEU_USER_ID=outside\n");
  assert.deepEqual(loadConfig(argv).toolDefaults.inboxeu_get_mailbox, { userId: "outside" });
  for (const settings of [
    mapping + "INBOXEU_DOMAIN_NAME=TWO.example.\nINBOXEU_USER_ID=abc+2",
    `INBOXEU_DOMAINS='{"single.example":["001"]}'\nINBOXEU_USER_ID=1`,
  ]) {
    await writeFile(file, settings);
    assert.throws(() => loadConfig(argv), {
      message: "Invalid INBOXEU_USER_ID. Choose a configured mailbox ID for the default domain.",
    });
  }
});

test("malformed domain settings report the variable without exposing its contents", async t => {
  const file = await makeEnvFile(t);
  const argv = ["--env-file", file];
  const invalid = [
    "private-invalid", "1", "false", "null", '"private.example"', '[null]', '[{}]',
    '["bad/name"]', '["Bücher.example.", "xn--bcher-kva.example"]',
    '{"ONE.example":[],"one.example.":[]}', '{"one.example":"001"}', '{"one.example":null}',
    '{"one.example":[1]}', '{"one.example":["abc/123"]}', '{"one.example":[""]}',
    '{"one.example":["001","001"]}',
  ];
  for (const value of invalid) {
    await writeFile(file, `INBOXEU_DOMAINS='${value}'\n`);
    assert.throws(() => loadConfig(argv), {
      message: "Invalid INBOXEU_DOMAINS. Expected unique domain names in a JSON array or an object mapping domains to arrays of unique mailbox ID strings.",
    });
  }
  await writeFile(file, "INBOXEU_DOMAIN_NAME=private/invalid\n");
  assert.throws(() => loadConfig(argv), { message: "Invalid INBOXEU_DOMAIN_NAME. Enter a valid domain name." });
});
