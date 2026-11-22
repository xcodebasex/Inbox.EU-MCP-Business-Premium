import { readFileSync } from "node:fs";
import { parseArgs, parseEnv } from "node:util";
import { dnsName, operations, validateIdentifier } from "./operations.js";

export function argumentEnvName(operation, field) {
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
  throw new Error(`Invalid ${variable}. Expected a JSON value of type ${type}.`);
}

function parseDomains(value) {
  const domains = new Map();
  if (!value?.trim()) return domains;
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object") throw new TypeError();
    const entries = Array.isArray(parsed)
      ? parsed.map(name => [name, []])
      : Object.entries(parsed);
    for (const [name, ids] of entries) {
      const domain = dnsName(name);
      if (domains.has(domain) || !Array.isArray(ids)) throw new TypeError();
      const mailboxIds = ids.map(id => validateIdentifier(id));
      if (new Set(mailboxIds).size !== mailboxIds.length) throw new TypeError();
      domains.set(domain, mailboxIds);
    }
  } catch {
    throw new Error("Invalid INBOXEU_DOMAINS. Expected unique domain names in a JSON array or an object mapping domains to arrays of unique mailbox ID strings.");
  }
  return domains;
}

function loadToolDefaults(settings, mode) {
  const defaults = {};
  for (const operation of operations) {
    if (mode === "read-only" && operation.method !== "GET") continue;
    const args = {};
    for (const [field, schema] of Object.entries(operation.inputSchema.properties)) {
      const variable = argumentEnvName(operation, field);
      const value = settings[variable];
      if (value !== undefined && value !== "") args[field] = parseArgument(value, schema.type, variable);
    }
    if (Object.keys(args).length) defaults[operation.name] = args;
  }
  return defaults;
}

export function loadConfig(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs({
      args: argv,
      options: { mode: { type: "string" }, "env-file": { type: "string" } },
    }).values;
  } catch {
    throw new Error("Invalid startup options. Use --mode read-only|full or --env-file <path>.");
  }

  const customFile = options["env-file"];
  const file = customFile ?? new URL("../.env", import.meta.url);
  let settings = {};
  try {
    settings = parseEnv(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (customFile !== undefined || error.code !== "ENOENT") {
      throw new Error("Could not read the .env file. Check its path, permissions, and format.");
    }
  }

  const selectedMode = options.mode ?? settings.INBOXEU_MODE;
  const mode = selectedMode ?? "read-only";
  if (mode !== "read-only" && mode !== "full") {
    throw new Error("Unknown mode. Set INBOXEU_MODE or --mode to read-only or full.");
  }
  const domains = parseDomains(settings.INBOXEU_DOMAINS);
  if (settings.INBOXEU_DOMAIN_NAME) {
    settings.INBOXEU_DOMAIN_NAME = dnsName(settings.INBOXEU_DOMAIN_NAME, "Invalid INBOXEU_DOMAIN_NAME. Enter a valid domain name.");
  } else if (domains.size === 1) {
    settings.INBOXEU_DOMAIN_NAME = domains.keys().next().value;
  }
  const ids = domains.get(settings.INBOXEU_DOMAIN_NAME);
  if (settings.INBOXEU_USER_ID && ids?.length && !ids.includes(settings.INBOXEU_USER_ID)) {
    throw new Error("Invalid INBOXEU_USER_ID. Choose a configured mailbox ID for the default domain.");
  }
  return {
    mode,
    apiKey: settings.INBOXEU_API_KEY,
    domains,
    toolDefaults: loadToolDefaults(settings, mode),
    legacyWrites: selectedMode === undefined && settings.INBOXEU_ENABLE_WRITES === "true",
  };
}
