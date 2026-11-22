import { randomUUID } from "node:crypto";
import { access, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../src/index.js", import.meta.url));
const configPath = fileURLToPath(new URL("../plugins/inboxeu-business/mcp.json", import.meta.url));

async function preparePlugin() {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error("The Inbox.eu server requires Node.js 22 or newer.");
  }
  await access(entrypoint);
  const config = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      inboxeu: { type: "stdio", command: "node", args: [entrypoint] },
    },
  };
  const content = JSON.stringify(config, null, 2) + "\n";
  try {
    const previous = await lstat(configPath);
    if (!previous.isFile() || previous.nlink !== 1) {
      throw new Error(`Expected a regular, unlinked file at ${configPath}.`);
    }
    if (await readFile(configPath, "utf8") === content) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { flag: "wx" });
    await rename(temporaryPath, configPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

await preparePlugin();
console.log(`Desktop plugin configuration ready at ${configPath}`);
