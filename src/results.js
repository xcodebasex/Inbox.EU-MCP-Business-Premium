import { InboxEuError } from "./client.js";

const adminFields = [
  "id", "username", "email", "firstName", "lastName", "registered",
  "createdBy", "role", "language", "tos",
];
const preferenceFields = ["itemsPerPage", "userSortField", "userSortOrder"];
const invoiceFields = [
  "orderId", "payer", "payerDomain", "domainId", "created", "start", "finish",
  "quota", "quotaTotal", "invoiceNumber", "sum", "currency", "isRecurrent", "productName",
];
// ApiMailUser has no published field list. Return only recognizable scalar
// metadata, even if Inbox.eu adds credentials or nested objects to its payload.
const mailboxFields = [
  "id", "userId", "user", "username", "email", "domainName", "firstName",
  "lastName", "forename", "surname", "status", "quota", "registered", "language",
];
const mailboxIdentityFields = ["id", "userId", "user", "username", "email", "domainName"];
const premiumMailboxLimit = /^Could not create user\. Reason: You can make maximum (0|[1-9]\d{0,15}) premium users(?:\r?\n)?$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unexpectedShape() {
  return new InboxEuError("Inbox.eu returned an unexpected response.");
}

function unexpectedWriteShape() {
  return new InboxEuError("The change may have been applied. Check Inbox.eu before retrying.");
}

function scalarFields(record, fields) {
  if (!isRecord(record)) throw unexpectedShape();
  const result = {};
  for (const field of fields) {
    const value = record[field];
    if (Object.hasOwn(record, field) &&
        (value === null || ["string", "number", "boolean"].includes(typeof value))) {
      result[field] = value;
    }
  }
  return result;
}

function publicRecord(record, fields) {
  const result = scalarFields(record, fields);
  if (!Object.keys(result).length) throw unexpectedShape();
  return result;
}

function writeResult(matchesContract) {
  if (!matchesContract) throw unexpectedWriteShape();
  return { success: true };
}

function twoFactorSetup(data) {
  if (!isRecord(data)) throw unexpectedWriteShape();
  const setup = {};
  if (typeof data.isEnabled === "boolean") setup.isEnabled = data.isEnabled;
  if (typeof data.secret === "string" && data.secret.length) {
    setup.secret = data.secret;
  } else if (typeof data.qrCodeImage === "string" && data.qrCodeImage.length) {
    setup.qrCodeImage = data.qrCodeImage;
  }
  if (!Object.keys(setup).length) throw unexpectedWriteShape();
  return { data: setup };
}

function createdImpersonationToken(data) {
  if (!Array.isArray(data) || data.length !== 1) throw unexpectedWriteShape();
  const [item] = data;
  const values = isRecord(item)
    ? [item.impersonationToken, item.impersonation_token, item.token]
    : [item];
  const tokens = new Set(values.filter(value => typeof value === "string" && value.trim() && !value.includes("[redacted]")));
  if (tokens.size !== 1) throw unexpectedWriteShape();
  return { impersonationToken: [...tokens][0] };
}

function tokenValidity(data) {
  if (!Array.isArray(data)) throw unexpectedShape();
  if (data.length === 1) {
    const [item] = data;
    const flags = isRecord(item) ? [item.valid, item.isValid] : [item];
    const values = new Set(flags.filter(value => typeof value === "boolean"));
    if (values.size === 1) return { valid: [...values][0] };
  }
  return { valid: null, message: "Inbox.eu did not report whether the token is valid." };
}

// Inbox.eu does not specify a result-item schema. Preserve per-row outcomes
// only when the server supplies a recognizable signal, without echoing errors.
function reportedOutcome(item, creatingMailbox = false) {
  const status = typeof item.status === "string" ? item.status.toLowerCase() : null;
  const errors = [item.error, item.errors, item.errorMessages].some(error =>
    error && typeof error === "object" ? Object.keys(error).length > 0 : Boolean(error));
  const flags = [item.success, item.ok];
  if (creatingMailbox) flags.push(item.created);
  if (errors || flags.includes(false) || ["error", "failed", "failure"].includes(status)) {
    return "failed";
  }
  if (flags.includes(true) || ["created", "success", "succeeded"].includes(status)) {
    return "succeeded";
  }
  return "unknown";
}

function mailboxRow(identity, outcome, record) {
  const row = { ...identity, outcome };
  if (outcome === "succeeded") return row;
  if (outcome === "unknown") {
    return { ...row, message: "Check whether the mailbox was created before retrying." };
  }
  // Only the recognized provider sentence can supply a quota value.
  const reasons = [record.message, record.error].concat(record.errorMessages ?? []);
  for (const reason of reasons) {
    if (typeof reason !== "string") continue;
    const match = premiumMailboxLimit.exec(reason);
    if (match && Number.isSafeInteger(Number(match[1]))) {
      return { ...row, message: `Premium mailbox limit reached (${match[1]}).` };
    }
  }
  return { ...row, message: "Mailbox creation failed." };
}

function groupedMailboxRow(item, group) {
  const record = isRecord(item) ? item : {};
  const mailbox = isRecord(record.user) ? record.user : record;
  const identity = {};
  for (const field of mailboxIdentityFields) {
    const value = mailbox[field];
    if ((typeof value === "string" && value.length > 0 && !/[\s\u0000-\u001f\u007f]/u.test(value)) ||
        (["id", "userId"].includes(field) && Number.isSafeInteger(value) && value >= 0)) {
      identity[field] = value;
    }
  }
  if (group === "failed") return mailboxRow(identity, "failed", record);
  // A created-list entry is a provider report. Keep malformed or contradictory
  // entries in the reported count without confirming that a mailbox exists.
  const signal = reportedOutcome(record, true);
  const recognizable = isRecord(item) && (Object.keys(identity).length > 0 || signal === "succeeded");
  const contradicted = signal === "failed" || (mailbox !== record && reportedOutcome(mailbox, true) === "failed");
  return mailboxRow(identity, recognizable && !contradicted ? "succeeded" : "unknown", record);
}

function mailboxBatch(data, requested) {
  let results;
  if (Array.isArray(data)) {
    results = data.map(item => {
      const record = isRecord(item) ? item : {};
      return mailboxRow(scalarFields(record, mailboxIdentityFields), reportedOutcome(record, true), record);
    });
  } else if (Array.isArray(data?.created) && Array.isArray(data?.failed)) {
    results = data.created.map(item => groupedMailboxRow(item, "created"))
      .concat(data.failed.map(item => groupedMailboxRow(item, "failed")));
  } else {
    throw unexpectedWriteShape();
  }
  const summary = { requested: requested ?? null, reported: results.length, succeeded: 0, failed: 0, unknown: 0 };
  for (const { outcome } of results) summary[outcome]++;
  if (data.isSuccessful === false && !summary.failed && !summary.unknown) throw unexpectedWriteShape();
  return { data: results, summary };
}

export function projectResult(name, { status, data: envelope }, { requestedCount, userId } = {}) {
  const data = envelope.data;
  switch (name) {
    case "inboxeu_check_auth":
      if (Array.isArray(data)) return { authenticated: true };
      if (typeof data?.authenticated !== "boolean") throw unexpectedShape();
      return data.authenticated ? { authenticated: true }
        : { authenticated: false, message: "Check your Inbox.eu API key." };
    case "inboxeu_check_domain":
      return { available: status === 404 };
    case "inboxeu_check_admin_email":
      return { available: status === 422 };
    case "inboxeu_get_2fa_status":
      if (typeof data?.isEnabled !== "boolean") throw unexpectedShape();
      return { data: { isEnabled: data.isEnabled } };
    case "inboxeu_get_profile":
    case "inboxeu_get_admin":
    case "inboxeu_get_domain_admin": {
      const admin = publicRecord(data, adminFields);
      if (isRecord(data.prefs)) admin.prefs = scalarFields(data.prefs, preferenceFields);
      return { data: admin };
    }
    case "inboxeu_list_invoices":
      if (!Array.isArray(data)) throw unexpectedShape();
      return { data: data.map(item => publicRecord(item, invoiceFields)) };
    case "inboxeu_get_mailbox":
      return { data: Array.isArray(data)
        ? data.map(item => publicRecord(item, mailboxFields))
        : publicRecord(data, mailboxFields) };
    case "inboxeu_update_profile":
      return writeResult(isRecord(data));
    case "inboxeu_delete_profile":
    case "inboxeu_delete_mailbox":
      if (typeof data !== "boolean") throw unexpectedWriteShape();
      if (data) return { success: true };
      return { success: false, message: name === "inboxeu_delete_profile"
        ? "Inbox.eu could not delete the profile." : "Inbox.eu could not delete the mailbox." };
    case "inboxeu_enable_2fa":
      return twoFactorSetup(data);
    case "inboxeu_create_impersonation_token":
      return createdImpersonationToken(data);
    case "inboxeu_validate_impersonation_token":
      return tokenValidity(data);
    case "inboxeu_create_mailboxes":
      return mailboxBatch(data, requestedCount);
    case "inboxeu_update_mailbox":
      if (isRecord(data)) {
        // The observed object acknowledgement contains only the updated mailbox ID.
        const id = data.id;
        const validId = typeof id === "string" || (Number.isSafeInteger(id) && id >= 0);
        return writeResult(Object.keys(data).length === 1 && validId &&
          typeof userId === "string" && userId.length > 0 && String(id) === userId);
      }
      // The published response uses the same array acknowledgement as the operations below.
    case "inboxeu_create_admin":
    case "inboxeu_invite_admin":
    case "inboxeu_disable_2fa":
    case "inboxeu_send_mailbox_details":
    case "inboxeu_update_mailbox_filters":
    case "inboxeu_remove_domain_admin":
      if (Array.isArray(data) && data.some(item => isRecord(item) && reportedOutcome(item) === "failed")) {
        throw new InboxEuError("Inbox.eu reported a failure. Check the result before retrying.");
      }
      return writeResult(Array.isArray(data));
    default:
      throw new Error("Missing result projection.");
  }
}
