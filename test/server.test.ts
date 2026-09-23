import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.js";
import { commit, tmpRepo, write } from "./helpers.js";

describe("mcp server", () => {
  it("exposes five tools and round-trips load/save", async () => {
    const root = tmpRepo();
    write(root, "docs/architecture.md", "---\nowns: [.]\n---\n# x\n");
    commit(root);
    const [c, s] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const tools = (await client.listTools()).tools.map(t => t.name).sort();
    expect(tools).toEqual(["docsic_check", "docsic_init", "docsic_load", "docsic_recall", "docsic_save"]);
    await client.callTool({ name: "docsic_save", arguments: { cwd: root, kind: "state", content: "## Now\na\n## In flight\nb\n## Next\nc" } });
    const res: any = await client.callTool({ name: "docsic_load", arguments: { cwd: root } });
    expect(JSON.parse(res.content[0].text).state).toContain("## Now");
  });
});
