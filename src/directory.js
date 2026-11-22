import { InboxEuError } from "./client.js";
import { dnsName, emailAddress, operations, validateMailboxId } from "./operations.js";

const listMailboxes = operations.find(operation => operation.name === "inboxeu_list_mailboxes");
const domainList = operations.find(operation => operation.name === "inboxeu_list_domains");
const pageSize = 100;
const invalidPage = "Inbox.eu returned an invalid mailbox list.";
const inconsistentPage = "The mailbox list changed or contains duplicate entries. Try again.";

export async function listDomains(request, signal) {
  const params = domainList.build({});
  if (signal?.aborted) throw new InboxEuError("The request was cancelled.");
  const response = await request({ ...params, method: domainList.method, signal });
  const records = response?.data?.data;
  const invalid = "Inbox.eu returned an invalid domain list.";
  if (!Array.isArray(records)) throw new InboxEuError(invalid);
  let domains;
  try {
    domains = records.map(record => dnsName(record?.name));
  } catch {
    throw new InboxEuError(invalid);
  }
  if (new Set(domains).size !== domains.length) throw new InboxEuError(invalid);
  return { domains };
}

function directoryEntry(record, domain) {
  if (!record || typeof record.user !== "string") throw new InboxEuError(invalidPage);
  let { id } = record;
  if (Number.isSafeInteger(id) && id > 0) id = String(id);
  try {
    const userId = validateMailboxId(id);
    const email = emailAddress(record.user.includes("@") ? record.user : record.user + "@" + domain);
    if (!email.endsWith("@" + domain) || (record.email != null && emailAddress(record.email) !== email) ||
        (record.domainName != null && dnsName(record.domainName) !== domain)) {
      throw new InboxEuError(invalidPage);
    }
    const row = { userId, email };
    if (typeof record.status === "string" && /^[A-Za-z][A-Za-z_-]{0,31}$/.test(record.status)) {
      row.status = record.status;
    }
    return row;
  } catch {
    throw new InboxEuError(invalidPage);
  }
}

function trackUnique(rows, ids, addresses) {
  for (const { userId, email } of rows) {
    if (ids.has(userId) || addresses.has(email)) throw new InboxEuError(inconsistentPage);
    ids.add(userId);
    addresses.add(email);
  }
}

export async function listMailboxPage(request, { domainName, limit = pageSize, offset = 0 }, signal) {
  const domain = dnsName(domainName);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > pageSize ||
      !Number.isSafeInteger(offset) || offset < 0) {
    throw new InboxEuError("Use a limit from 1 to 100 and a nonnegative integer offset.");
  }
  if (signal?.aborted) throw new InboxEuError("The request was cancelled.");
  const params = listMailboxes.build({ domainName: domain, limit, offset });
  let response;
  try {
    response = await request({ ...params, method: listMailboxes.method, signal });
  } catch (error) {
    if (error instanceof InboxEuError && [401, 403, 404, 405, 501].includes(error.httpStatus)) {
      throw new InboxEuError("Cannot access the mailbox directory. Check domain access or supply a known mailbox ID.", error.httpStatus);
    }
    throw error;
  }
  const page = response?.data?.data;
  const total = page?.count;
  if (!Array.isArray(page?.data) || !Number.isSafeInteger(total) || total < 0 ||
      page.data.length > limit || page.data.length > Math.max(0, total - offset)) {
    throw new InboxEuError(invalidPage);
  }
  if (!page.data.length && offset < total) throw new InboxEuError(inconsistentPage);
  const data = page.data.map(record => directoryEntry(record, domain));
  trackUnique(data, new Set(), new Set());
  const end = offset + data.length;
  return { data, total, offset, nextOffset: end < total ? end : null };
}

export async function findMailboxId(request, mailboxEmail, signal) {
  const address = emailAddress(mailboxEmail);
  const domainName = address.split("@")[1];
  const ids = new Set();
  const addresses = new Set();
  let expectedTotal;
  let match;
  let offset = 0;
  do {
    const page = await listMailboxPage(request, { domainName, offset }, signal);
    if (expectedTotal !== undefined && page.total !== expectedTotal) throw new InboxEuError(inconsistentPage);
    expectedTotal = page.total;
    trackUnique(page.data, ids, addresses);
    const entry = page.data.find(row => row.email === address);
    if (entry) match = entry.userId;
    offset = page.nextOffset;
  } while (offset !== null);
  return match;
}
