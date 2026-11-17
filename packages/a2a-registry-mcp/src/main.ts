#!/usr/bin/env bun
// Serves the internal agents listed in a file over MCP: stdio by default, or HTTP with --http.
import path from "node:path"
import { parseArgs } from "node:util"
import { createMcpHandler } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { Registry } from "./registry.js"
import { RegistryServer } from "./server.js"

const args = parseArgs({
  allowPositionals: true,
  options: {
    http: { type: "boolean", default: false },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "8787" },
    ttl: { type: "string", default: "300" },
  },
})
const file = args.positionals[0]
if (!file) {
  console.error("Usage: a2a-registry-mcp <agents.json> [--http] [--host 127.0.0.1] [--port 8787] [--ttl 300]")
  process.exit(1)
}
const registry = Registry.open(path.resolve(file), { ttl: Number(args.values.ttl) * 1000 })
// Read the file once at start, so a broken file fails here instead of on the first tool call.
await registry.agents()
const factory = () => RegistryServer.create(registry)

if (args.values.http) {
  const handler = createMcpHandler(factory)
  const server = Bun.serve({
    hostname: args.values.host,
    port: Number(args.values.port),
    // Docker's health check asks /health; every other path is the MCP endpoint.
    fetch: (request) => (new URL(request.url).pathname === "/health" ? new Response("ok") : handler.fetch(request)),
  })
  console.error(`a2a-registry-mcp on http://${server.hostname}:${server.port}/`)
}
if (!args.values.http) serveStdio(factory)
