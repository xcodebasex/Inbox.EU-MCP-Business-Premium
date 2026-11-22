import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createClient, InboxEuError } from "./client.js";
import { readAdmin } from "./admin.js";
import { listDomains, listMailboxPage } from "./directory.js";
import { resolveReadTarget } from "./read-target.js";
import { ConfigError, loadConfig } from "./config.js";
import { InputError, operations } from "./operations.js";
import { projectResult } from "./results.js";
import { toolArguments } from "./targets.js";
import { createClarification } from "./clarification.js";

function toolError(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

function resultText(result) {
  if (result.message) return result.message;
  const batch = result.summary;
  if (batch) {
    const unconfirmed = batch.unknown + Math.max(0, batch.requested - batch.reported);
    if (batch.failed || unconfirmed) {
      if (batch.requested === 1 && batch.reported === 1) return result.data[0].message;
      return `${batch.succeeded} created, ${batch.failed} failed, ${unconfirmed} unconfirmed.`;
    }
  }
  return JSON.stringify(result);
}

const invalidParameters = "Check the tool arguments.";

function toolInputSchema(schema, defaults, optional) {
  // Publish which arguments can be omitted, while keeping configured values private.
  const catalogSchema = { ...schema, required: schema.required.filter(field => !optional.has(field)) };
  if (schema.minProperties) catalogSchema.minProperties = Math.max(0, schema.minProperties - Object.keys(defaults).length);
  const input = fromJsonSchema(catalogSchema);
  return {
    ...input,
    "~standard": {
      ...input["~standard"],
      async validate(args) {
        const result = await input["~standard"].validate(args);
        // The SDK puts returned issues in tool output, including validator diagnostics.
        if (result.issues?.length) throw new Error(invalidParameters);
        return result;
      },
    },
  };
}

async function executeOperation(request, operation, args, defaultDomain, signal) {
  if (operation.name === "inboxeu_list_domains") return listDomains(request, signal);
  if (operation.name === "inboxeu_list_mailboxes") return listMailboxPage(request, args, signal);
  const response = operation.name === "inboxeu_get_admin"
    ? await readAdmin(request, { domainAdmin: args.domainAdmin, domainName: defaultDomain }, signal)
    : await request({ ...operation.build(args), method: operation.method, signal });
  const requestedCount = operation.name === "inboxeu_create_mailboxes" ? args.body.length : undefined;
  const { domainName, userId, mailboxEmail } = args;
  return projectResult(operation.name, response, { domainName, userId, mailboxEmail, requestedCount });
}

function createServer({ mode, readApiKey, toolDefaults, domains, mailboxAddresses }, clarification) {
  const server = new McpServer({ name: "inboxeu-mcp", version: "1.0.0" }, {
    ...clarification.serverOptions,
    instructions: "For mailbox questions, use inboxeu_get_mailbox with the full mailboxEmail. It discovers the ID. " +
      "For a list across all domains, call inboxeu_list_domains and then inboxeu_list_mailboxes per domain. " +
      "Follow nextOffset until it is null when a complete list is requested. Use inboxeu_get_profile for the current administrator. " +
      "Ask which account the user means when several match. Use verified IDs for authorized changes in full mode.",
  });
  for (const operation of operations) {
    const readOnly = operation.method === "GET";
    if (!readOnly && mode !== "full") continue;
    const defaults = toolDefaults[operation.name] ?? {};
    const { optional, resolve } = toolArguments(operation.inputSchema, defaults, domains, mailboxAddresses);
    const fullSchema = fromJsonSchema(operation.inputSchema)["~standard"];
    server.registerTool(operation.name, {
      description: operation.description,
      inputSchema: toolInputSchema(operation.inputSchema, defaults, optional),
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: ["PUT", "DELETE"].includes(operation.method) || operation.name === "inboxeu_enable_2fa",
        idempotentHint: readOnly,
        openWorldHint: true,
      },
    }, async (args, ctx) => {
      try {
        const request = createClient({ apiKey: readApiKey() });
        const signal = ctx.mcpReq.signal;
        const answers = clarification.priorAnswers(ctx, operation.name, args);
        const target = readOnly
          ? await resolveReadTarget(resolve, args, answers, request, signal)
          : resolve(args, answers);
        if (target.missing) {
          return await clarification.askTarget({
            server, ctx, operationName: operation.name, args, answers: target.answers ?? answers, missing: target.missing,
          });
        }
        const checked = await fullSchema.validate(target.values);
        if (checked.issues?.length) throw new InputError(invalidParameters);
        const result = await executeOperation(request, operation, checked.value, toolDefaults.inboxeu_get_domain_admin?.domainName, signal);
        return {
          structuredContent: result,
          content: [{ type: "text", text: resultText(result) }],
        };
      } catch (error) {
        const expected = error instanceof InboxEuError || error instanceof InputError || error instanceof ConfigError;
        return toolError(expected ? error.message : "Internal Inbox.eu MCP error.");
      }
    });
  }
  return server;
}

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
    return;
  }
  if (config.legacyWrites) {
    process.stderr.write("Read-only mode is active. Set INBOXEU_MODE=full in .env to enable changes.\n");
  }
  const clarification = createClarification();
  serveStdio(() => createServer(config, clarification));
}

main();
