import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createClient, InboxEuError } from "./client.js";
import { readAdmin } from "./admin.js";
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

function createServer({ mode, readApiKey, toolDefaults, domains, mailboxAddresses }, clarification) {
  const server = new McpServer({ name: "inboxeu-mcp", version: "1.0.0" }, clarification.serverOptions);
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
      let apiKey;
      let params;
      let resolvedArgs;
      try {
        apiKey = readApiKey();
        const answers = clarification.priorAnswers(ctx, operation.name, args);
        const { values, missing } = resolve(args, answers);
        if (missing) {
          return await clarification.askTarget({ server, ctx, operationName: operation.name, args, answers, missing });
        }
        const checked = await fullSchema.validate(values);
        if (checked.issues?.length) throw new InputError(invalidParameters);
        resolvedArgs = checked.value;
        params = operation.build(resolvedArgs);
      } catch (error) {
        return toolError(error instanceof InputError || error instanceof ConfigError ? error.message : invalidParameters);
      }
      try {
        const request = createClient({ apiKey });
        const signal = ctx.mcpReq.signal;
        const response = operation.name === "inboxeu_get_admin"
          ? await readAdmin(request, {
            domainAdmin: resolvedArgs.domainAdmin, domainName: toolDefaults.inboxeu_get_domain_admin?.domainName,
          }, signal)
          : await request({ ...params, method: operation.method, signal });
        const requestedCount = operation.name === "inboxeu_create_mailboxes" ? params.body.length : undefined;
        const { domainName, userId, mailboxEmail } = resolvedArgs;
        const result = projectResult(operation.name, response, { domainName, userId, mailboxEmail, requestedCount });
        return {
          structuredContent: result,
          content: [{ type: "text", text: resultText(result) }],
        };
      } catch (error) {
        return toolError(error instanceof InboxEuError ? error.message : "Internal Inbox.eu MCP error.");
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
