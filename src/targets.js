import { dnsName, InputError } from "./operations.js";

function soleMailbox(domains, domain) {
  const ids = domains.get(domain);
  return ids?.length === 1 ? ids[0] : undefined;
}

// Select defaults per call so that switching a domain cannot reuse another mailbox's ID or token.
export function toolArguments(schema, defaults, domains) {
  const fields = schema.properties;
  const domainField = ["domainName", "hostName", "hostname"].find(field => fields[field]?.type === "string");
  const primaryDomain = domainField && defaults[domainField];
  const primaryMailbox = defaults.userId ?? soleMailbox(domains, primaryDomain);
  const optional = new Set(Object.keys(defaults));
  // These inputs can be supplied interactively after tool discovery.
  if (domainField) optional.add(domainField);
  if (fields.userId) optional.add("userId");
  if (domainField && domains.size) {
    if (!primaryDomain) optional.delete("domainAdmin");
    if (!primaryDomain || !primaryMailbox) optional.delete("impersonationToken");
  }

  function resolve(args) {
    const values = { ...defaults, ...args };
    if (!domainField) return { values };
    const selected = values[domainField];
    if (selected === undefined) {
      return { missing: {
        field: domainField,
        message: "Which domain should this operation use?",
        choices: [...domains.keys()],
      } };
    }
    const domain = dnsName(selected);
    const usePrimary = primaryDomain === undefined ? domains.size === 0 : primaryDomain === domain;
    if (fields.userId && !Object.hasOwn(args, "userId")) {
      const userId = usePrimary ? primaryMailbox : soleMailbox(domains, domain);
      if (userId === undefined) {
        return { missing: {
          field: "userId",
          message: `Which mailbox ID should this operation use in ${domain}?`,
          choices: domains.get(domain) ?? [],
        } };
      }
      values.userId = userId;
    }
    if (fields.domainAdmin && !usePrimary && !Object.hasOwn(args, "domainAdmin")) {
      throw new InputError("Specify the administrator ID for the selected domain.");
    }
    if (defaults.impersonationToken && !Object.hasOwn(args, "impersonationToken")) {
      const switchedMailbox = primaryMailbox !== undefined && values.userId !== primaryMailbox;
      if (!usePrimary || switchedMailbox || (domains.size && !primaryMailbox)) {
        throw new InputError("Supply the token issued for the selected mailbox.");
      }
    }
    return { values };
  }
  return { optional, resolve };
}
