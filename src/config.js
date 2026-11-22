import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual, parseArgs, parseEnv } from "node:util";
import { dnsName, emailAddress, operations, validateIdentifier, validateMailboxId } from "./operations.js";

export class ConfigError extends Error {}

export function argumentEnvName(operation, field) {
  // The address-to-ID directory belongs in INBOXEU_DOMAINS. The requested address is per call.
  if (field === "mailboxEmail") return undefined;
  const type = operation.inputSchema.properties[field].type;
  if (type === "string" && ["domainName", "hostName", "hostname"].includes(field)) return "INBOXEU_DOMAIN_NAME";
  if (field === "userId") return "INBOXEU_USER_ID";
  if (field === "domainAdmin") return "INBOXEU_DOMAIN_ADMIN";
  if (field === "impersonationToken") return "INBOXEU_IMPERSONATION_TOKEN";
  if (operation.name === "inboxeu_check_admin_email" && field === "email") return "INBOXEU_CHECK_ADMIN_EMAIL";
  const suffix = field.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return `${operation.name}_${suffix}`.toUpperCase();
}

function parseArgument(value, type, variable) {
  if (type === "string") return value;
  try {
    const parsed = JSON.parse(value);
    if (type === "array" && Array.isArray(parsed)) return parsed;
    if (type === "object" && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    if (type === "integer" && Number.isSafeInteger(parsed)) return parsed;
    if (type === "boolean" && typeof parsed === "boolean") return parsed;
  } catch {
    // JSON parser errors can contain part of a password or request body.
  }
  throw new ConfigError(`Invalid ${variable}. Expected a JSON value of type ${type}.`);
}

function parseDomains(value) {
  const domains = new Map();
  const mailboxAddresses = new Map();
  if (!value?.trim()) return { domains, mailboxAddresses };
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object") throw new TypeError();
    const entries = Array.isArray(parsed)
      ? parsed.map(name => [name, []])
      : Object.entries(parsed);
    for (const [name, mailboxes] of entries) {
      const domain = dnsName(name);
      if (domains.has(domain) || !mailboxes || typeof mailboxes !== "object") throw new TypeError();
      let mailboxIds;
      if (Array.isArray(mailboxes)) {
        mailboxIds = mailboxes.map(validateIdentifier);
      } else {
        mailboxIds = Object.entries(mailboxes).map(([local, id]) => {
          const address = emailAddress(local + "@" + domain);
          mailboxAddresses.set(address, validateMailboxId(id));
          return id;
        });
      }
      if (new Set(mailboxIds).size !== mailboxIds.length) throw new TypeError();
      domains.set(domain, mailboxIds);
    }
  } catch {
    throw new ConfigError("Invalid INBOXEU_DOMAINS. Use a domain list, or map each domain to unique mailbox IDs or mailbox names and IDs.");
  }
  return { domains, mailboxAddresses };
}

function loadToolDefaults(settings, mode) {
  const defaults = {};
  for (const operation of operations) {
    if (mode === "read-only" && operation.method !== "GET") continue;
    const args = {};
    for (const [field, schema] of Object.entries(operation.inputSchema.properties)) {
      const variable = argumentEnvName(operation, field);
      if (!variable) continue;
      const value = settings[variable];
      if (value !== undefined && value !== "") args[field] = parseArgument(value, schema.type, variable);
    }
    if (Object.keys(args).length) defaults[operation.name] = args;
  }
  return defaults;
}

function serverSettings(settings, cliMode) {
  const selectedMode = cliMode ?? settings.INBOXEU_MODE;
  const mode = selectedMode ?? "read-only";
  if (mode !== "read-only" && mode !== "full") {
    throw new ConfigError("Unknown mode. Set INBOXEU_MODE or --mode to read-only or full.");
  }
  const { domains, mailboxAddresses } = parseDomains(settings.INBOXEU_DOMAINS);
  if (settings.INBOXEU_DOMAIN_NAME) {
    settings.INBOXEU_DOMAIN_NAME = dnsName(settings.INBOXEU_DOMAIN_NAME, "Invalid INBOXEU_DOMAIN_NAME. Enter a valid domain name.");
  } else if (domains.size === 1) {
    settings.INBOXEU_DOMAIN_NAME = domains.keys().next().value;
  }
  const ids = domains.get(settings.INBOXEU_DOMAIN_NAME);
  if (settings.INBOXEU_USER_ID && ids?.length && !ids.includes(settings.INBOXEU_USER_ID)) {
    throw new ConfigError("Invalid INBOXEU_USER_ID. Choose a configured mailbox ID for the default domain.");
  }
  return {
    mode,
    domains,
    ...(mailboxAddresses.size ? { mailboxAddresses } : {}),
    toolDefaults: loadToolDefaults(settings, mode),
    legacyWrites: selectedMode === undefined && settings.INBOXEU_ENABLE_WRITES === "true",
  };
}

export function loadConfig(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs({
      args: argv,
      options: { mode: { type: "string" }, "env-file": { type: "string" } },
    }).values;
  } catch {
    throw new ConfigError("Invalid startup options. Use --mode read-only|full or --env-file <path>.");
  }

  const customFile = options["env-file"];
  const file = customFile === undefined ? new URL("../.env", import.meta.url) : resolve(customFile);
  function readSettings() {
    try {
      return parseEnv(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
      if (customFile === undefined && error.code === "ENOENT") return {};
      throw new ConfigError("Could not read the .env file. Check its path, permissions, and format.");
    }
  }

  const config = serverSettings(readSettings(), options.mode);
  return {
    ...config,
    readApiKey() {
      const current = readSettings();
      // A new credential must never be paired with stale permissions or target defaults.
      if (!isDeepStrictEqual(serverSettings(current, options.mode), config)) {
        throw new ConfigError("Inbox.eu settings changed. Restart the MCP server to load the new configuration.");
      }
      return current.INBOXEU_API_KEY;
    },
  };
}
