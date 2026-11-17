import { afterAll, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parse } from "jsonc-parser"
import { ConfigA2A } from "@opencode/schema/config/a2a"
import { headerReferences, readCard, writeAgent } from "../src/commands/handlers/a2a/add"
import { tmpdir } from "./fixture/tmpdir"

const card = {
  name: "Translator Bot",
  description: "Translates documents",
  supportedInterfaces: [{ url: "http://agents.internal/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  skills: [{ id: "translate", name: "Translate" }],
  securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "bearer" } } },
}

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/.well-known/agent-card.json") return Response.json(card)
    if (url.pathname === "/exact/card.json") return Response.json({ ...card, securitySchemes: undefined })
    if (url.pathname === "/not-a-card.json") return Response.json({ hello: "world" })
    if (url.pathname === "/grpc-only.json")
      return Response.json({ name: "gRPC", supportedInterfaces: [{ url: "grpc://x", protocolBinding: "GRPC" }] })
    return new Response("not found", { status: 404 })
  },
})
const base = `http://127.0.0.1:${server.port}`
afterAll(() => server.stop(true))

test("reads the card from a base URL or an exact card URL", async () => {
  const fromBase = await readCard(base)
  expect(fromBase).toMatchObject({ endpoint: "http://agents.internal/rpc", security: ["bearer"] })
  expect(fromBase.card.name).toBe("Translator Bot")
  expect((await readCard(`${base}/exact/card.json`)).security).toEqual([])
})

test("refuses what isn't a usable Agent Card", async () => {
  await expect(readCard(`${base}/missing.json`)).rejects.toThrow("HTTP 404")
  await expect(readCard(`${base}/not-a-card.json`)).rejects.toThrow("is not an A2A Agent Card")
  await expect(readCard(`${base}/grpc-only.json`)).rejects.toThrow("offers no JSON-RPC interface")
})

test("names the agent after its card", () => {
  expect(ConfigA2A.agentName("Translator Bot")).toBe("translator-bot")
  expect(ConfigA2A.agentName("  FPGA / Build v2 ")).toBe("fpga-build-v2")
  expect(ConfigA2A.agentName("***")).toBe("agent")
})

test("writes headers only as environment variable references", () => {
  expect(headerReferences({ Authorization: "TRANSLATOR_TOKEN", "X-API-Key": "API_KEY" })).toEqual({
    Authorization: "Bearer {env:TRANSLATOR_TOKEN}",
    "X-API-Key": "{env:API_KEY}",
  })
  expect(() => headerReferences({ Authorization: "Bearer sk-live-123" })).toThrow("environment variable")
})

test("adds the agent to a config, keeps its comments, and replaces only with force", async () => {
  await using root = await tmpdir()
  const configPath = path.join(root.path, "opencode.jsonc")
  await writeFile(configPath, `{\n  // my settings\n  "shell": "zsh"\n}\n`)
  await writeAgent(configPath, "translator", { url: base }, false)
  const text = await readFile(configPath, "utf8")
  expect(text).toContain("// my settings")
  expect(parse(text)).toEqual({ shell: "zsh", a2a: { agents: { translator: { url: base } } } })

  await expect(writeAgent(configPath, "translator", { url: "http://other" }, false)).rejects.toThrow("--force")
  await writeAgent(configPath, "translator", { url: "http://other" }, true)
  expect(parse(await readFile(configPath, "utf8")).a2a.agents.translator).toEqual({ url: "http://other" })

  const fresh = path.join(root.path, "missing.json")
  await writeAgent(fresh, "translator", { url: base }, false)
  expect(parse(await readFile(fresh, "utf8"))).toEqual({ a2a: { agents: { translator: { url: base } } } })
})
