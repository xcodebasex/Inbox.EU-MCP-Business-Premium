import assert from "node:assert/strict";
import test from "node:test";
import { createClarification } from "../src/clarification.js";

test("a target answer is bound to the same operation and original arguments across prompt rounds", async () => {
  const { askTarget, priorAnswers, serverOptions } = createClarification();
  const operationName = "inboxeu_update_mailbox";
  const args = { domainName: "example.org", body: { forename: "Fixture", password: "fixture-only" } };
  const prompt = await askTarget({
    server: { server: { getClientCapabilities: () => ({ elicitation: { form: {} } }) } },
    ctx: { mcpReq: {} }, operationName, args, answers: {},
    missing: { field: "userId", message: "Which mailbox ID?", choices: [] },
  });
  const state = await serverOptions.requestState.verify(prompt.requestState);
  assert.doesNotMatch(JSON.stringify(state), /fixture-only|forename/);
  const ctx = { mcpReq: {
    requestState: () => state,
    inputResponses: { userId: { action: "accept", content: { userId: "007" } } },
  } };
  assert.deepEqual(priorAnswers(ctx, operationName, {
    body: { password: "fixture-only", forename: "Fixture" }, domainName: "example.org",
  }), { userId: "007" });
  assert.throws(() => priorAnswers(ctx, operationName, { ...args, domainName: "other.example" }));
  assert.throws(() => priorAnswers(ctx, "inboxeu_delete_mailbox", args));
  assert.throws(() => priorAnswers({ mcpReq: { ...ctx.mcpReq, requestState: () => undefined } }, operationName, args));
});
