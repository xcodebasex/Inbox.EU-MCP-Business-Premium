import { domainToASCII } from "node:url";

export class InputError extends TypeError {}

function object(properties, required = [], extra = {}) {
  return { type: "object", properties, required, additionalProperties: false, ...extra };
}

const nonemptyText = { type: "string", minLength: 1, pattern: "^[^\\u0000-\\u001F\\u007F]+$" };
const nameText = { type: "string", pattern: "^[^\\u0000-\\u001F\\u007F]*$" };
const hostname = {
  type: "string",
  minLength: 1,
  pattern: "^[^\\s/\\\\?#%:@]+$",
  description: "DNS hostname in Unicode or ASCII form, without a URL scheme or port.",
};
const identifier = {
  type: "string",
  minLength: 1,
  pattern: "^(?!\\.{1,2}$)[^/\\\\%\\s\\u0000-\\u001F\\u007F]+$",
  description: "Inbox.eu identifier as a single, unescaped path segment.",
};
const email = {
  type: "string",
  minLength: 3,
  pattern: "^[^\\s@\\u0000-\\u001F\\u007F]+@[^\\s@/\\\\?#%:]+$",
  description: "Email address, for example admin@example.com.",
};
const pageNumber = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const password = { type: "string", format: "password", writeOnly: true };
const mailboxBody = {
  type: "object",
  additionalProperties: true,
  description: "Inbox.eu ApiMailUser object. The published schema does not enumerate its fields.",
};
const mailDetails = {
  type: "object",
  additionalProperties: true,
  description: "Inbox.eu MailUserDetails object. The published schema does not enumerate its fields.",
};
const language = {
  type: "string",
  enum: ["en", "lv", "ru", "bd", "pk", "id", "es", "lt", "ee", "fr", "de", "ar"],
};
const prefs = object({
  itemsPerPage: { type: "number", enum: [20, 50, 100, 200, 300] },
  userSortField: { type: "string", enum: ["user", "forename", "status"] },
  userSortOrder: { type: "string", enum: ["asc", "desc"] },
}, [], { minProperties: 1 });
const domainForm = object({
  name: hostname,
  mailboxUsernames: { type: "array", items: nonemptyText },
}, [], { minProperties: 1 });

export function dnsName(value, errorMessage = "Enter a valid domain name.") {
  // Check the source before URL's IDNA conversion, which also accepts URL delimiters.
  if (typeof value !== "string" || !/^[\p{L}\p{M}\p{N}.\-]+$/u.test(value)) {
    throw new InputError(errorMessage);
  }
  const input = value.endsWith(".") ? value.slice(0, -1) : value;
  // A DNS label can be numeric. A sentinel prevents WHATWG IPv4 parsing
  // (for instance "127.1" would otherwise become "127.0.0.1").
  const suffix = ".invalid";
  const converted = domainToASCII(input + suffix);
  const ascii = converted.endsWith(suffix) ? converted.slice(0, -suffix.length) : "";
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  if (!ascii || ascii.length > 253 || !ascii.split(".").every(part => label.test(part))) {
    throw new InputError(errorMessage);
  }
  return ascii;
}

export function emailAddress(value) {
  const errorMessage = "Enter a valid email address.";
  if (typeof value !== "string" || !new RegExp(email.pattern, "u").test(value)) {
    throw new InputError(errorMessage);
  }
  const [local, domain] = value.split("@");
  // The ordinary mailbox form supports plus-addressing and Unicode local parts.
  const atom = /^[\p{L}\p{M}\p{N}!#$%&'*+\-/=?^_`{|}~]+$/u;
  if (!local.split(".").every(part => atom.test(part)) || Buffer.byteLength(local) > 64) {
    throw new InputError(errorMessage);
  }
  const address = local + "@" + dnsName(domain, errorMessage);
  if (Buffer.byteLength(address) > 254) throw new InputError(errorMessage);
  return address;
}

export function validateIdentifier(value) {
  if (typeof value !== "string" || !new RegExp(identifier.pattern, "u").test(value) ||
      !value.isWellFormed()) {
    throw new InputError("Enter a valid Inbox.eu identifier.");
  }
  return value;
}

export function validateMailboxId(value) {
  if (typeof value === "string" && value.includes("@")) {
    throw new InputError("Use the internal mailbox ID from the Inbox.eu Business Users page.");
  }
  return validateIdentifier(value);
}

function route(name, description, method, path, segments = {},
  { query: queryFields = {}, requiredQuery = [], body, localFields = {} } = {}) {
  const properties = { ...segments, ...queryFields, ...localFields };
  const required = [...Object.keys(segments), ...requiredQuery];
  if (body) {
    properties.body = body;
    required.push("body");
  }
  return {
    name, description, method, path,
    inputSchema: object(properties, required),
    build(args = {}) {
      const resolved = path.replace(/\{(\w+)\}/g, (_, key) => {
        const validate = segments[key] === hostname ? dnsName : key === "userId" ? validateMailboxId : validateIdentifier;
        return encodeURIComponent(validate(args[key]));
      });
      const query = {};
      for (const [key, schema] of Object.entries(queryFields)) {
        if (Object.hasOwn(args, key)) query[key] = schema === email ? emailAddress(args[key]) : args[key];
      }
      const request = { path: resolved };
      if (Object.keys(query).length) request.query = query;
      if (body) request.body = args.body;
      return request;
    },
  };
}

function form(name, description, method, path, inputSchema, normalize) {
  return {
    name, description, method, path, inputSchema,
    build(args) {
      // Only schema-declared request fields can reach an administrative endpoint.
      const body = Object.fromEntries(Object.keys(inputSchema.properties)
        .filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]]));
      normalize?.(body);
      return { path, body };
    },
  };
}

const mailboxPath = "/api/v1/domains/{domainName}/mail_users/{userId}";
const mailboxParams = { domainName: hostname, userId: {
  ...identifier, description: "Internal mailbox ID from the Inbox.eu Business Users page (/users/<ID>/).",
} };
const adminPath = "/api/v1/domains/{domainName}/domain_admins/{domainAdmin}";
const adminParams = { domainName: hostname, domainAdmin: identifier };

export const operations = [
  route("inboxeu_check_auth", "Check whether the configured API token authenticates with Inbox.eu.",
    "GET", "/api/v1/security/check"),
  route("inboxeu_get_profile", "Get the current Inbox.eu administrator's profile.",
    "GET", "/api/v1/me/"),
  route("inboxeu_get_2fa_status", "Check whether two-factor authentication is enabled for the current administrator.",
    "GET", "/api/v1/me/two_factor/"),
  route("inboxeu_get_admin", "Get an Inbox.eu administrator by identifier.",
    "GET", "/api/v1/domain_admins/{domainAdmin}", { domainAdmin: identifier }),
  route("inboxeu_get_domain_admin", "Get an administrator associated with a particular domain.",
    "GET", adminPath, adminParams),
  // Inbox.eu serves these collection routes in addition to the published OpenAPI operations.
  route("inboxeu_list_domains", "List the domain names visible to the configured Inbox.eu API key.",
    "GET", "/api/v1/domains/"),
  route("inboxeu_list_mailboxes", "Get a page of mailbox addresses, internal user IDs and statuses for one domain. Use nextOffset to continue.",
    "GET", "/api/v1/domains/{domainName}/mail_users/", { domainName: hostname }, { query: {
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum mailboxes per page. Defaults to 100." },
      offset: { ...pageNumber, description: "Number of mailboxes to skip. Defaults to zero." },
    } }),
  route("inboxeu_get_mailbox",
    "Read mailbox account metadata. Pass mailboxEmail to find its internal ID automatically in the domain directory. You can also supply a known internal userId and domainName.",
    "GET", mailboxPath, mailboxParams, { localFields: { mailboxEmail: {
      ...email, description: "Full mailbox address. The server resolves it and verifies the returned account.",
    } } }),
  route("inboxeu_list_invoices", "List invoices for a domain. Use limit and offset to page through results.",
    "GET", "/api/v1/domains/{domainName}/transactions/", { domainName: hostname }, { query: {
      unexpired: nonemptyText, order_column: nonemptyText, order_direction: nonemptyText,
      limit: pageNumber, offset: pageNumber,
    } }),
  route("inboxeu_check_domain", "Check domain name availability in Inbox.eu. This checks the domain only. To check a particular mailbox, use inboxeu_get_mailbox.",
    "GET", "/api/v1/domain_find/{hostName}", { hostName: hostname }),
  route("inboxeu_check_admin_email", "Check whether an email address is available for administrator registration. To check a mailbox account, use inboxeu_get_mailbox.",
    "GET", "/api/v1/emails/admin", {}, { query: { email }, requiredQuery: ["email"] }),
  form("inboxeu_create_admin",
    "Create an Inbox.eu administrator, optionally with a domain and mailboxes. When password is omitted Inbox.eu emails a generated password.",
    "POST", "/api/v1/domain_admins/", object({
      email, language, firstName: nameText, lastName: nameText, domainName: domainForm, euRefId: nonemptyText,
      password, isEmailVerified: {
        type: "boolean", enum: [true, false], description: "Available only for specific Inbox.eu clients.",
      },
    }, ["email", "language"]),
    body => {
      body.email = emailAddress(body.email);
      if (body.domainName?.name !== undefined) {
        body.domainName = { ...body.domainName, name: dnsName(body.domainName.name) };
      }
    }),
  form("inboxeu_update_profile", "Update the current administrator's name, language, preferences, password or acceptance of the terms of service.",
    "PUT", "/api/v1/me/", object({
      language, firstName: nameText, lastName: nameText, prefs, plainPassword: password,
      tos: { type: "boolean", enum: [true], description: "Mark the terms of service as accepted." },
    }, [], { minProperties: 1 })),
  form("inboxeu_invite_admin", "Send an invitation to an administrator to manage the specified domain.",
    "POST", "/api/v1/invite/", object({ email, user: nonemptyText, hostname }, ["email", "user", "hostname"]),
    body => {
      body.email = emailAddress(body.email);
      body.hostname = dnsName(body.hostname);
    }),
  route("inboxeu_delete_profile", "Delete the current Inbox.eu administrator account.",
    "DELETE", "/api/v1/me/"),
  route("inboxeu_enable_2fa", "Enable two-factor authentication for the current Inbox.eu administrator.",
    "POST", "/api/v1/me/two_factor/"),
  route("inboxeu_disable_2fa", "Disable two-factor authentication for the current Inbox.eu administrator.",
    "DELETE", "/api/v1/me/two_factor/"),
  route("inboxeu_update_mailbox", "Update a domain mailbox account with the supplied ApiMailUser object.",
    "PUT", mailboxPath, mailboxParams, { body: mailboxBody }),
  route("inboxeu_delete_mailbox", "Delete the named mailbox user from the specified domain.",
    "DELETE", mailboxPath, mailboxParams),
  route("inboxeu_create_mailboxes", "Create multiple mailbox accounts on a domain using an array of ApiMailUser objects.",
    "POST", "/api/v1/domains/{domainName}/mail_users/multi", { domainName: hostname },
    { body: { type: "array", items: mailboxBody } }),
  route("inboxeu_create_impersonation_token", "Create an Inbox.eu impersonation token for signing in to the specified mailbox.",
    "POST", mailboxPath + "/impersonation/impersonate", mailboxParams, { body: mailboxBody }),
  route("inboxeu_validate_impersonation_token", "Check the supplied impersonation token for the specified mailbox.",
    "POST", mailboxPath + "/impersonation/validate", mailboxParams,
    { body: mailboxBody, query: { impersonationToken: { ...nonemptyText, writeOnly: true } }, requiredQuery: ["impersonationToken"] }),
  route("inboxeu_send_mailbox_details", "Send the account details of a created or updated mailbox to another email address.",
    "POST", mailboxPath + "/details", mailboxParams, { body: mailDetails }),
  route("inboxeu_update_mailbox_filters", "Call the Inbox.eu mailbox filter update. The published operation specifies only the domain and mailbox identifiers.",
    "PUT", mailboxPath + "/filters", mailboxParams),
  route("inboxeu_remove_domain_admin", "Revoke an administrator's access to the specified domain.",
    "DELETE", adminPath, adminParams),
];
