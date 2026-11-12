import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { LLMClient } from "@opencode/ai/effect"
import { TestLLM } from "@opencode/ai/testing"
import { OpenCode } from "@opencode/client"
import { A2AClient } from "@opencode/core/a2a/client"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { A2ACodec } from "@opencode/core/a2a/codec"
import { Effect, Layer, Schedule } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "@opencode/server/fetch"

const base = "http://opencode.local"
const provider = {
  model: "custom/fictional-chat",
  providers: {
    custom: {
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: "https://provider.example/v1" },
      models: { "fictional-chat": {} },
    },
  },
}

// Five prompts each run a full Session turn against the scripted model, past the 5s package default.
it.live(
  "serves OpenCode as an A2A agent in both protocol dialects",
  () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped("opencode-a2a-")).path
      const project = path.join(dir, "project")
      const off = path.join(dir, "off")
      yield* Effect.promise(async () => {
        await Promise.all([project, off].map((item) => fs.mkdir(item, { recursive: true })))
        await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ experimental: { a2a: true } }))
        await fs.writeFile(path.join(off, "opencode.json"), JSON.stringify({ experimental: { a2a: false } }))
      })
      const llm = yield* TestLLM.Test.pipe(
        Effect.provide(TestLLM.testLayer({ fallback: TestLLM.text("Hello from OpenCode", "answer") })),
      )
      const handler = yield* ServerFetch.make(
        {
          app: { version: "test" },
          database: { path: path.join(dir, "opencode.db") },
          config: {
            directory: path.join(dir, "global"),
            project: true,
            claude: false,
            content: JSON.stringify(provider),
          },
          models: { fetch: false },
          fs: { filewatcher: false },
        },
        { overrides: [llmClient.replace(Layer.succeed(LLMClient.Service, llm))] },
      )
      const query = (directory: string) => `?location[directory]=${encodeURIComponent(directory)}`
      const cardURL = `${base}/api/experimental/a2a/card${query(project)}`
      const rpcURL = `${base}/api/experimental/a2a${query(project)}`
      const json = (url: string, init?: RequestInit) =>
        Effect.promise(() => handler(new Request(url, init)).then((response) => response.json()))
      const rpc = (method: string, params: unknown, url = rpcURL, headers: Record<string, string> = {}) =>
        json(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })

      // Plugins load asynchronously, so wait for the configured model before prompting.
      yield* json(`${base}/api/model${query(project)}`).pipe(
        Effect.repeat({
          until: (body: { data: { id: string }[] }) => body.data.some((model) => model.id === "fictional-chat"),
          schedule: Schedule.spaced("20 millis"),
        }),
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.die(new Error("model never loaded")) }),
      )

      expect(yield* json(cardURL)).toMatchObject({
        protocolVersion: "0.3.0",
        preferredTransport: "JSONRPC",
        url: `${base}/api/experimental/a2a?location%5Bdirectory%5D=${encodeURIComponent(project)}`,
        capabilities: { streaming: true },
        skills: expect.arrayContaining([expect.objectContaining({ id: "build" })]),
      })
      expect(yield* json(cardURL, { headers: { "A2A-Version": "1.0" } })).toMatchObject({
        supportedInterfaces: [{ protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      })
      expect(yield* json(`${cardURL}&A2A-Version=1.0`)).toMatchObject({
        supportedInterfaces: [{ url: expect.any(String) }],
      })
      // The card is cacheable and revalidates with its ETag.
      const cached = yield* Effect.promise(() => handler(new Request(cardURL)))
      expect(cached.headers.get("cache-control")).toContain("max-age")
      const etag = cached.headers.get("etag") ?? ""
      expect(etag).not.toBe("")
      const revalidated = yield* Effect.promise(() =>
        handler(new Request(cardURL, { headers: { "If-None-Match": etag } })),
      )
      expect(revalidated.status).toBe(304)

      // OpenCode's own A2A client against the server, in each dialect, continuing the context it was given.
      const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))
      const viaServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(
            FetchHttpClient.Fetch,
            Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
              preconnect: fetch.preconnect,
            }),
          ),
        )
      for (const version of ["0.3", "1.0"] as const) {
        const target = yield* viaServer(
          A2AClient.discover(http, { url: cardURL, headers: version === "1.0" ? { "A2A-Version": "1.0" } : {} }),
        )
        expect(target.version).toBe(version)
        const first = yield* viaServer(A2AClient.send(http, target, { text: "Say hello", timeout: "20 seconds" }))
        expect(first).toMatchObject({ status: { state: "completed" } })
        expect(A2ACodec.text(first)).toBe("Hello from OpenCode")
        const contextId = "contextId" in first ? first.contextId : undefined
        const next = yield* viaServer(A2AClient.send(http, target, { text: "Again", contextId, timeout: "20 seconds" }))
        expect(next).toMatchObject({ contextId, status: { state: "completed" } })
      }

      // Raw JSON-RPC: the answer is readable by task ID, a finished task cannot be cancelled, and errors are JSON-RPC.
      const sent = (yield* rpc("message/send", {
        message: { kind: "message", messageId: "m1", role: "user", parts: [{ kind: "text", text: "Hi" }] },
        configuration: { blocking: true },
      })) as { result: { id: string; kind: string; status: { state: string } } }
      expect(sent.result).toMatchObject({ kind: "task", status: { state: "completed" } })
      expect(yield* rpc("GetTask", { id: sent.result.id })).toMatchObject({
        result: {
          id: sent.result.id,
          status: { state: "TASK_STATE_COMPLETED" },
          artifacts: [{ parts: [{ text: "Hello from OpenCode" }] }],
        },
      })
      expect(yield* rpc("tasks/cancel", { id: sent.result.id })).toMatchObject({ error: { code: -32002 } })
      expect(yield* rpc("tasks/get", { id: "ses_missing:msg_missing" })).toMatchObject({ error: { code: -32001 } })
      expect(yield* rpc("tasks/pushNotificationConfig/set", {})).toMatchObject({ error: { code: -32003 } })
      expect(yield* rpc("nope", {})).toMatchObject({ error: { code: -32601 } })
      // 1.0 errors carry an ErrorInfo; an unsupported A2A-Version is refused.
      expect(yield* rpc("GetTask", { id: "ses_missing:msg_missing" })).toMatchObject({
        error: { code: -32001, data: [{ reason: "TASK_NOT_FOUND", domain: "a2a-protocol.org" }] },
      })
      expect(yield* rpc("GetTask", { id: sent.result.id }, rpcURL, { "A2A-Version": "2.0" })).toMatchObject({
        error: { code: -32009, data: [{ reason: "VERSION_NOT_SUPPORTED" }] },
      })
      expect(yield* rpc("GetExtendedAgentCard", {})).toMatchObject({ error: { code: -32004 } })
      expect(yield* rpc("tasks/resubscribe", { id: sent.result.id })).toMatchObject({ error: { code: -32004 } })
      // A taskId must belong to the contextId sent with it.
      expect(
        yield* rpc("message/send", {
          message: {
            messageId: "m3",
            role: "user",
            parts: [{ kind: "text", text: "Hi" }],
            taskId: sent.result.id,
            contextId: "ses_other",
          },
        }),
      ).toMatchObject({ error: { code: -32602 } })

      // ListTasks pages through every A2A task in the Location, newest first, without artifacts by default.
      type ListResult = {
        result: {
          tasks: { id: string; artifacts?: unknown }[]
          nextPageToken: string
          pageSize: number
          totalSize: number
        }
      }
      const first = (yield* rpc("ListTasks", { pageSize: 2 })) as ListResult
      expect(first.result).toMatchObject({ pageSize: 2, totalSize: 5 })
      expect(first.result.tasks).toHaveLength(2)
      expect(first.result.tasks[0]).not.toHaveProperty("artifacts")
      expect(first.result.tasks[0].id).toBe(sent.result.id)
      const pages = [first]
      while (pages.at(-1)!.result.nextPageToken !== "")
        pages.push(
          (yield* rpc("ListTasks", { pageSize: 2, pageToken: pages.at(-1)!.result.nextPageToken })) as ListResult,
        )
      expect(new Set(pages.flatMap((page) => page.result.tasks.map((task) => task.id))).size).toBe(5)
      expect(
        yield* rpc("ListTasks", { contextId: sent.result.id.split(":")[0], includeArtifacts: true }),
      ).toMatchObject({ result: { totalSize: 1, tasks: [{ artifacts: [{ name: "response" }] }] } })
      expect(yield* rpc("ListTasks", { pageSize: 0 })).toMatchObject({ error: { code: -32602 } })
      expect(
        yield* json(rpcURL, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }),
      ).toMatchObject({ error: { code: -32700 } })

      // Streaming sends the task first and ends with a final status update.
      const frames = yield* Effect.promise(async () => {
        const response = await handler(
          new Request(rpcURL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "message/stream",
              params: { message: { messageId: "m2", role: "user", parts: [{ kind: "text", text: "Stream" }] } },
            }),
          }),
        )
        expect(response.headers.get("content-type")).toContain("text/event-stream")
        return (await response.text())
          .split("\n\n")
          .filter((frame) => frame.startsWith("data: "))
          .map((frame) => JSON.parse(frame.slice("data: ".length)).result)
      })
      expect(frames[0]).toMatchObject({ kind: "task", status: { state: "working" } })
      expect(frames).toContainEqual(
        expect.objectContaining({
          kind: "artifact-update",
          artifact: expect.objectContaining({ parts: [{ kind: "text", text: "Hello from OpenCode" }] }),
        }),
      )
      expect(frames.at(-2)).toMatchObject({ kind: "artifact-update", lastChunk: true })
      expect(frames.at(-1)).toMatchObject({ kind: "status-update", final: true, status: { state: "completed" } })

      // Off where the location turns the flag off.
      const offCard = yield* Effect.promise(() =>
        handler(new Request(`${base}/api/experimental/a2a/card${query(off)}`)),
      )
      expect(offCard.status).toBe(403)
      expect(yield* rpc("message/send", {}, `${base}/api/experimental/a2a${query(off)}`)).toMatchObject({
        error: { code: -32004 },
      })
    }),
  20_000,
)

// Three Session turns (the caller, the remote task, the caller again) against the scripted model.
it.live(
  "gives agents an a2a tool for configured remote agents",
  () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped("opencode-a2a-tool-")).path
      const project = path.join(dir, "project")
      const card = `${base}/api/experimental/a2a/card?location[directory]=${encodeURIComponent(project)}`
      yield* Effect.promise(async () => {
        await fs.mkdir(project, { recursive: true })
        // The remote agent is this same server, reached through the fetch OpenCode uses for its own requests.
        await fs.writeFile(
          path.join(project, "opencode.json"),
          JSON.stringify({
            experimental: { a2a: true },
            a2a: {
              agents: { self: { url: card, description: "Another OpenCode" }, hidden: { url: card, enabled: false } },
            },
          }),
        )
      })
      const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
      const toolOffers: string[][] = []
      // Only the caller's first request delegates; the remote task and the caller's follow-up answer with text.
      yield* llm.serve((request) => {
        const tools = request.tools.map((tool) => tool.name)
        if (tools.includes("a2a")) toolOffers.push(tools)
        if (toolOffers.length !== 1 || !tools.includes("a2a")) return TestLLM.text("Hello from OpenCode", "answer")
        return TestLLM.toolCall("call-a2a", "a2a", { agent: "self", message: "Say hello" })
      })
      const local: { handler?: (request: Request) => Promise<Response> } = {}
      const handler = yield* ServerFetch.make(
        {
          app: { version: "test" },
          database: { path: path.join(dir, "opencode.db") },
          config: {
            directory: path.join(dir, "global"),
            project: true,
            claude: false,
            content: JSON.stringify(provider),
          },
          models: { fetch: false },
          fs: { filewatcher: false },
          fetch: Object.assign(
            (input: string | URL | Request, init?: RequestInit) => local.handler!(new Request(input, init)),
            { preconnect: fetch.preconnect },
          ),
        },
        { overrides: [llmClient.replace(Layer.succeed(LLMClient.Service, llm))] },
      )
      local.handler = handler
      const api = OpenCode.make({
        baseUrl: base,
        fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
          preconnect: fetch.preconnect,
        }),
      })

      yield* Effect.promise(async () => {
        const deadline = Date.now() + 5_000
        while (
          !(await api.model.list({ location: { directory: project } })).data.some((m) => m.id === "fictional-chat")
        ) {
          if (Date.now() > deadline) throw new Error("model never loaded")
          await Bun.sleep(20)
        }
        const session = await api.session.create({ location: { directory: project } })
        await api.session.prompt({ sessionID: session.id, text: "Ask the other agent to say hello" })
        await api.experimental.session.wait({ sessionID: session.id })
      })

      const requests = yield* llm.requests()
      // The caller's follow-up request carries the tool result with the remote agent's answer and context.
      expect(JSON.stringify(requests.at(-1))).toMatch(/self \(completed; contextId: ses_\w+, taskId: ses_\w+:msg_\w+\)/)
      expect(JSON.stringify(requests.at(-1))).toContain("Hello from OpenCode")
      expect(toolOffers[0]).toContain("a2a")
    }),
  20_000,
)

// A real model is still answering when the stream starts, so the stream must follow live events to the end.
it.live(
  "streams a task that is still running when the stream starts",
  () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped("opencode-a2a-stream-")).path
      const project = path.join(dir, "project")
      yield* Effect.promise(async () => {
        await fs.mkdir(project, { recursive: true })
        await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ experimental: { a2a: true } }))
      })
      const llm = yield* TestLLM.Test.pipe(
        Effect.provide(TestLLM.testLayer({ fallback: TestLLM.text("Answered late", "answer") })),
      )
      const handler = yield* ServerFetch.make(
        {
          app: { version: "test" },
          database: { path: path.join(dir, "opencode.db") },
          config: {
            directory: path.join(dir, "global"),
            project: true,
            claude: false,
            content: JSON.stringify(provider),
          },
          models: { fetch: false },
          fs: { filewatcher: false },
        },
        { overrides: [llmClient.replace(Layer.succeed(LLMClient.Service, llm))] },
      )
      const query = `?location[directory]=${encodeURIComponent(project)}`
      yield* Effect.promise(() => handler(new Request(`${base}/api/model${query}`)).then((r) => r.json())).pipe(
        Effect.repeat({
          until: (body: { data: { id: string }[] }) => body.data.some((model) => model.id === "fictional-chat"),
          schedule: Schedule.spaced("20 millis"),
        }),
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.die(new Error("model never loaded")) }),
      )
      // The model holds its answer until the stream has sent its first frame.
      const gate = yield* llm.gate()
      const response = yield* Effect.promise(() =>
        handler(
          new Request(`${base}/api/experimental/a2a${query}`, {
            method: "POST",
            headers: { "content-type": "application/json", "a2a-version": "1.0" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "SendStreamingMessage",
              params: { message: { messageId: "late", role: "ROLE_USER", parts: [{ text: "Answer late" }] } },
            }),
          }),
        ),
      )
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      const frames: unknown[] = []
      const state = { buffer: "" }
      const readFrames = (until: (frames: unknown[]) => boolean) =>
        Effect.promise(async () => {
          while (!until(frames)) {
            const chunk = await reader.read()
            if (chunk.done) return
            state.buffer += decoder.decode(chunk.value, { stream: true })
            const parts = state.buffer.split("\n\n")
            state.buffer = parts.pop() ?? ""
            frames.push(
              ...parts.filter((part) => part.startsWith("data: ")).map((part) => JSON.parse(part.slice(6)).result),
            )
          }
        })
      yield* readFrames((items) => items.length > 0)
      expect(frames[0]).toMatchObject({ task: { status: { state: "TASK_STATE_WORKING" } } })
      yield* gate.started
      yield* gate.release
      yield* readFrames(() => false).pipe(
        Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.die(new Error("stream never finished")) }),
      )
      expect(frames).toContainEqual(
        expect.objectContaining({
          artifactUpdate: expect.objectContaining({
            artifact: expect.objectContaining({ parts: [{ text: "Answered late" }] }),
          }),
        }),
      )
      expect(frames.at(-1)).toMatchObject({ statusUpdate: { status: { state: "TASK_STATE_COMPLETED" } } })
    }),
  20_000,
)
