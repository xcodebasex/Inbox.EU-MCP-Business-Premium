import { InboxEuError } from "./client.js";
import { findMailboxId, listDomains, listMailboxPage } from "./directory.js";

export async function resolveReadTarget(resolve, args, answers, request, signal) {
  let target = resolve(args, answers);
  if (target.missing?.field === "userId") answers = { ...answers, domainName: target.missing.domainName };
  // Only owned-domain reads use domainName. Availability checks can reference any hostname.
  try {
    if (target.missing?.field === "domainName" && !target.missing.choices?.length) {
      const { domains } = await listDomains(request, signal);
      if (!domains.length) throw new InboxEuError("No domains were returned for this API key.");
      if (domains.length > 1) {
        return { missing: { ...target.missing, choices: domains, fromDirectory: true }, answers };
      }
      // Keep the chosen domain in the signed form state if a second question is needed.
      answers = { ...answers, domainName: domains[0] };
      target = resolve(args, answers);
    }
    if (target.missing?.field === "userId" && !target.missing.choices?.length) {
      const { domainName } = target.missing;
      const { data, total } = await listMailboxPage(request, { domainName, limit: 2 }, signal);
      if (!total) throw new InboxEuError("No mailboxes were returned for this domain.");
      if (total > 1) {
        const examples = data.map(row => `${row.email} (ID ${row.userId})`).join(", ");
        return { answers: { ...answers, domainName }, missing: {
          field: "userId", message: `Which mailbox in ${domainName}? The directory includes ${examples}. You can also look up a full email address.`,
        } };
      }
      return { values: { domainName, userId: data[0].userId, mailboxEmail: data[0].email }, answers };
    }
  } catch (error) {
    // A known domain or mailbox ID may remain usable when directory access is restricted.
    if (error instanceof InboxEuError && [401, 403, 404, 405, 501].includes(error.httpStatus)) {
      return { ...target, answers };
    }
    throw error;
  }
  const values = target.values;
  if (values?.mailboxEmail && values.userId === undefined) {
    const userId = await findMailboxId(request, values.mailboxEmail, signal);
    if (userId === undefined) throw new InboxEuError("The address was not found in the mailbox directory for this domain.");
    return { values: { ...values, userId }, answers };
  }
  return { ...target, answers };
}
