import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm, utimes } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createMcpHandler } from "@modelcontextprotocol/server"
import { Registry } from "../src/registry"
import { RegistryServer } from "../src/server"

const cards = {
  translator: {
    name: "Translator",
    description: "Translates documents between languages",
    version: "2.0.0",
    provider: { organization: "Docs team" },
    capabilities: { streaming: true },
    supportedInterfaces: [{ url: "http://agents.internal/translator/rpc", protocolBinding: "JSONRPC" }],
    skills: [{ id: "translate", name: "Translate", description: "Any language to any other", tags: ["language"] }],
  },
  builds: {
    name: "Build bot",
    description: "Runs the nightly FPGA builds",
    provider: { organization: "Hardware team" },
    capabilities: { streaming: false },
    supportedInterfaces: [{ url: "http://agents.internal/builds/rpc", protocolBinding: "JSONRPC" }],
    skills: [{ id: "bitstream", name: "Build a bitstream", tags: ["fpga"] }],
  },
}

const state = { buildsUp: true, seenToken: "" }
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/.well-known/agent-card.json") return Response.json(cards.translator)
    if (url.pathname === "/builds/card.json") {
      state.seenToken = request.headers.get("authorization") ?? ""
      return state.buildsUp ? Response.json(cards.builds) : new Response("down", { status: 503 })
    }
    if (url.pathname === "/broken/card.json") return Response.json({ description: "no name, not a card" })
    return new Response("not found", { status: 404 })
  },
})
const base = `http://127.0.0.1:${server.port}`
const dir = { path: "" }

beforeAll(async () => {
  dir.path = await mkdtemp(path.join(os.tmpdir(), "a2a-registry-mcp-"))
  process.env.A2A_REGISTRY_TEST_TOKEN = "secret-token"
})

afterAll(async () => {
  await server.stop(true)
  await rm(dir.path, { recursive: true, force: true })
  delete process.env.A2A_REGISTRY_TEST_TOKEN
})

async function agentsFile(name: string, agents: unknown[]) {
  const file = path.join(dir.path, name)
  await Bun.write(file, JSON.stringify({ agents }))
  return file
}

const listed = () => [
  { url: base, category: "docs" },
  { url: `${base}/builds/card.json`, headers: { Authorization: "Bearer {env:A2A_REGISTRY_TEST_TOKEN}" } },
  { url: `${base}/broken/card.json` },
  // Nothing listens here, so the agent is listed as unhealthy.
  { url: "http://127.0.0.1:9/card.json" },
]

test("reads every listed card and reports the ones it can't read", async () => {
  const agents = await Registry.open(await agentsFile("all.json", listed())).agents()
  expect(agents.map((agent) => [agent.name, agent.is_healthy, agent.conformance])).toEqual([
    ["Translator", true, true],
    ["Build bot", true, true],
    [`127.0.0.1:${server.port}`, true, false],
    ["127.0.0.1:9", false, false],
  ])
  expect(agents[0]).toMatchObject({
    wellKnownURI: `${base}/.well-known/agent-card.json`,
    url: "http://agents.internal/translator/rpc",
    author: "Docs team",
    version: "2.0.0",
    category: "docs",
    _meta: { content_trust: "untrusted_third_party" },
  })
  // Header values name environment variables, so the token stays out of the file.
  expect(state.seenToken).toBe("Bearer secret-token")
})

test("searches by keyword and filters like the A2A Registry", async () => {
  const agents = await Registry.open(await agentsFile("search.json", listed())).agents()
  expect(Registry.search(agents, "fpga").map((agent) => agent.name)).toEqual(["Build bot"])
  expect(Registry.search(agents, "translates documents").map((agent) => agent.name)).toEqual(["Translator"])
  expect(Registry.list(agents, { skill: "language" }).agents.map((agent) => agent.name)).toEqual(["Translator"])
  expect(Registry.list(agents, { capability: "streaming" }).agents.map((agent) => agent.name)).toEqual(["Translator"])
  expect(Registry.list(agents, { author: "hardware" }).agents.map((agent) => agent.name)).toEqual(["Build bot"])
  expect(Registry.list(agents, { healthy: false }).total).toBe(1)
  expect(Registry.list(agents, { conformance: "standard" }).total).toBe(2)
  expect(Registry.list(agents, { category: "docs" }).total).toBe(1)
  expect(Registry.list(agents, { limit: 1, offset: 1 })).toMatchObject({ total: 4, limit: 1, offset: 1 })
  expect(Registry.skills(agents)).toEqual([
    { id: "bitstream", count: 1 },
    { id: "translate", count: 1 },
  ])
})

test("keeps an agent's last card when it stops answering, and rereads a changed file", async () => {
  const file = await agentsFile("reload.json", [{ url: `${base}/builds/card.json` }])
  const registry = Registry.open(file, { ttl: 0 })
  const before = await registry.agents()
  state.buildsUp = false
  const after = await registry.agents()
  state.buildsUp = true
  expect(after[0]).toMatchObject({ id: before[0]!.id, name: "Build bot", is_healthy: false })

  await Bun.write(file, JSON.stringify({ agents: [{ url: base }] }))
  // Some filesystems keep the same mtime for a quick rewrite, so move it on explicitly.
  const later = new Date(Date.now() + 5_000)
  await utimes(file, later, later)
  const changed = await Registry.open(file).agents()
  expect(changed.map((agent) => agent.name)).toEqual(["Translator"])
})

test("serves the registry's tools over MCP", async () => {
  const registry = Registry.open(await agentsFile("mcp.json", listed()))
  const handler = createMcpHandler(() => RegistryServer.create(registry))
  const rpc = async (id: number, method: string, params: unknown) => {
    const response = await handler.fetch(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }),
    )
    const text = await response.text()
    const data = text.split("\n").find((line) => line.startsWith("data: "))
    return JSON.parse(data ? data.slice("data: ".length) : text)
  }
  await rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  })
  const tools = await rpc(2, "tools/list", {})
  expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
    "search_agents",
    "list_agents",
    "get_agent",
    "list_skills",
  ])
  const found = await rpc(3, "tools/call", { name: "search_agents", arguments: { query: "translate" } })
  expect(found.result.structuredContent.result).toHaveLength(1)
  const id = found.result.structuredContent.result[0].id
  const agent = await rpc(4, "tools/call", { name: "get_agent", arguments: { agent_id: id } })
  expect(agent.result.structuredContent.result).toMatchObject({ name: "Translator" })
  const page = await rpc(5, "tools/call", { name: "list_agents", arguments: { healthy: true, limit: 2 } })
  expect(page.result.structuredContent).toMatchObject({ total: 3, limit: 2, offset: 0 })
  await handler.close()
})
