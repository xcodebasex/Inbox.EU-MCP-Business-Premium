import { dnsName, emailAddress, InputError, validateMailboxId } from "./operations.js";

function soleMailbox(domains, domain) {
  const ids = domains.get(domain);
  return ids?.length === 1 ? ids[0] : undefined;
}

// Select defaults per call so that switching a domain cannot reuse another mailbox's ID or token.
export function toolArguments(schema, defaults, domains, mailboxAddresses = new Map()) {
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

  function resolve(input, answers = {}) {
    const supplied = { ...answers, ...input };
    // Accept an address in the userId field from earlier catalogs and interactive forms.
    if (fields.mailboxEmail && typeof supplied.userId === "string" && supplied.userId.includes("@")) {
      const address = emailAddress(supplied.userId);
      if (supplied.mailboxEmail !== undefined && emailAddress(supplied.mailboxEmail) !== address) {
        throw new InputError("Supply a single mailbox address for this lookup.");
      }
      supplied.mailboxEmail = address;
      delete supplied.userId;
    }
    if (fields.mailboxEmail && supplied.mailboxEmail !== undefined) {
      const address = emailAddress(supplied.mailboxEmail);
      const domain = address.split("@")[1];
      if (supplied.domainName !== undefined && dnsName(supplied.domainName) !== domain) {
        throw new InputError("The mailbox address and domain must match.");
      }
      const knownId = mailboxAddresses.get(address);
      const explicitId = supplied.userId;
      if (explicitId !== undefined && knownId !== undefined && explicitId !== knownId) {
        throw new InputError("The mailbox ID conflicts with its address in INBOXEU_DOMAINS. Check the mapping.");
      }
      const id = explicitId ?? knownId;
      const values = { domainName: domain, mailboxEmail: address };
      if (id !== undefined) values.userId = validateMailboxId(id);
      return { values };
    }
    return resolveDefaults(supplied);
  }

  function resolveDefaults(args) {
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
          domainName: domain,
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
