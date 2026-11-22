import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("desktop preparation emits a host-compatible stdio command and leaves the key in the project", async t => {
  const project = await mkdtemp(path.join(tmpdir(), "inboxeu desktop "));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(project)), path.resolve(tmpdir()));
    return rm(project, { recursive: true, force: true });
  });
  const plugin = path.join(project, "plugins", "inboxeu-business");
  const script = path.join(project, "scripts", "prepare-desktop-plugin.mjs");
  const entry = path.join(project, "src", "index.js");
  await Promise.all([plugin, path.dirname(script), path.dirname(entry)].map(dir => mkdir(dir, { recursive: true })));
  await copyFile(new URL("../scripts/prepare-desktop-plugin.mjs", import.meta.url), script);
  await writeFile(entry, "");
  await writeFile(path.join(project, ".env"), "INBOXEU_API_KEY=fixture-key\n");

  const prepare = () => execFileSync(process.execPath, [script], { cwd: tmpdir(), stdio: "pipe" });
  prepare();
  const configPath = path.join(plugin, "mcp.json");
  const first = await readFile(configPath, "utf8");
  assert.deepEqual(JSON.parse(first), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { inboxeu: { type: "stdio", command: "node", args: [entry] } },
  });
  prepare();
  assert.equal(await readFile(configPath, "utf8"), first);
  assert.deepEqual(await readdir(plugin), ["mcp.json"]);
});
