import { createHmac, randomBytes } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY, createRequestStateCodec, inputRequired, inputResponse,
} from "@modelcontextprotocol/server";
import { dnsName, InputError, validateIdentifier } from "./operations.js";

const targetFields = new Set(["domainName", "hostName", "hostname", "userId"]);
const invalidReply = "The clarification reply could not be used. Retry the tool with the target argument.";

// A client's JSON serializer may reorder object keys between rounds.
function sortedObject(_key, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
}

function supportsForms(server, ctx) {
  const capabilities = ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? server.server.getClientCapabilities();
  const elicitation = capabilities?.elicitation;
  // Older clients declare support for forms with an empty elicitation object.
  return elicitation !== undefined && (elicitation.form !== undefined || elicitation.url === undefined);
}

export function createClarification() {
  const codec = createRequestStateCodec({ key: randomBytes(32) });
  const bindingKey = randomBytes(32);
  function argumentBinding(operationName, args) {
    // The signed state is client-readable. A keyed digest keeps even low-entropy arguments private.
    const original = JSON.stringify([operationName, args], sortedObject);
    return createHmac("sha256", bindingKey).update(original).digest("base64url");
  }

  function priorAnswers(ctx, operationName, args) {
    const state = ctx.mcpReq.requestState();
    const responses = ctx.mcpReq.inputResponses;
    if (ctx.mcpReq.droppedInputResponseKeys?.length) throw new InputError(invalidReply);
    if (state === undefined) {
      if (responses !== undefined && Object.keys(responses).length) throw new InputError(invalidReply);
      return {};
    }
    const { field, answers, binding } = state;
    if (binding !== argumentBinding(operationName, args) || !targetFields.has(field) ||
        !responses || Object.keys(responses).length !== 1 || !Object.hasOwn(responses, field)) {
      throw new InputError(invalidReply);
    }
    const reply = inputResponse(responses, field);
    if (reply.kind !== "elicit") throw new InputError(invalidReply);
    if (reply.action !== "accept") throw new InputError("The user declined or cancelled the target selection.");
    const content = reply.content;
    if (!content || !Object.hasOwn(content, field) || Object.keys(content).length !== 1) {
      throw new InputError(invalidReply);
    }
    const value = field === "userId" ? validateIdentifier(content[field]) : dnsName(content[field]);
    return { ...answers, [field]: value };
  }

  async function askTarget({ server, ctx, operationName, args, answers, missing }) {
    const { field, message, choices } = missing;
    if (!targetFields.has(field)) throw new InputError(invalidReply);
    const suggestions = choices?.slice(0, 5).filter(choice => choice.length <= 100);
    const hint = suggestions?.length ? `Configured choices include ${suggestions.join(", ")}.` : "";
    if (!supportsForms(server, ctx)) {
      throw new InputError([message, hint, `Ask the user and retry with their answer in ${field}.`].filter(Boolean).join(" "));
    }
    const property = { type: "string", title: field === "userId" ? "Mailbox ID" : "Domain", minLength: 1 };
    if (hint) property.description = hint;
    const requestState = await codec.mint({ field, answers, binding: argumentBinding(operationName, args) });
    return inputRequired({
      requestState,
      inputRequests: {
        [field]: inputRequired.elicit({
          message,
          requestedSchema: { type: "object", properties: { [field]: property }, required: [field] },
        }),
      },
    });
  }

  return { serverOptions: { requestState: { verify: codec.verify } }, priorAnswers, askTarget };
}
