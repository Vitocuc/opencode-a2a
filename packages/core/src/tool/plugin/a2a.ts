export * as A2ATool from "./a2a.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { A2A } from "@opencode/schema/a2a"
import type { ConfigA2A } from "@opencode/schema/config/a2a"
import type { Document, Entry } from "@opencode/schema/config"
import { Duration, Effect, Schema } from "effect"
import { HttpClient } from "effect/http"
import { A2AClient } from "../../a2a/client.js"
import { A2ACodec } from "../../a2a/codec.js"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import { Flag } from "../../flag.js"
import { Permission } from "../../permission.js"

export const name = "a2a"
export const DEFAULT_TIMEOUT_SECONDS = 600

export const Input = Schema.Struct({
  agent: Schema.String.annotate({ description: "Name of the remote agent, as listed in this tool's description" }),
  message: Schema.String.annotate({
    description: "The task or question for the agent, self-contained: it cannot see this conversation",
  }),
  contextId: Schema.String.pipe(Schema.optionalKey).annotate({
    description: "contextId from an earlier a2a result, to continue that conversation with the same agent",
  }),
  taskId: Schema.String.pipe(Schema.optionalKey).annotate({
    description: "taskId of a task in the input-required state, to answer the agent's question",
  }),
})

const Output = Schema.Struct({
  agent: Schema.String,
  contextId: Schema.String.pipe(Schema.optionalKey),
  taskId: Schema.String.pipe(Schema.optionalKey),
  state: A2A.State,
  text: Schema.String,
})

/** Lets agents delegate to the remote Agent2Agent agents configured under `a2a.agents`. Needs experimental.a2a. */
export const Plugin = {
  id: "opencode.tool.a2a",
  effect: Effect.fn("A2ATool.Plugin")(function* (ctx: Context) {
    const config = yield* Config.Service
    const http = yield* HttpClient.HttpClient
    const permission = yield* Permission.Service
    const flags = yield* Flag.Service
    // Internal plugins are not re-run on config changes, so reload the tools instead.
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.tool.reload())
    // Cards are read on first use and kept per URL; a config change that moves an agent reads its new card.
    const targets = new Map<string, A2AClient.Target>()

    yield* ctx.tool
      .transform((editor) => {
        if (!flags.resolve(loaded.entries).a2a.enabled) return
        const agents = configured(loaded.entries)
        if (agents.size === 0) return
        editor.add({
          name,
          options: { codemode: false },
          description: describe(agents),
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const agent = agents.get(input.agent)
              if (!agent)
                return yield* new A2AClient.RequestError({
                  message: `Unknown A2A agent "${input.agent}". Configured: ${[...agents.keys()].join(", ")}`,
                })
              yield* permission.assert({
                action: name,
                resources: [input.agent],
                save: ["*"],
                metadata: input,
                ...Permission.invocation(context),
              })
              const target =
                targets.get(agent.url) ?? (yield* A2AClient.discover(http, { url: agent.url, headers: agent.headers }))
              targets.set(agent.url, target)
              const result = yield* A2AClient.send(http, target, {
                text: input.message,
                contextId: input.contextId,
                taskId: input.taskId,
                timeout: Duration.seconds(agent.timeout ?? DEFAULT_TIMEOUT_SECONDS),
              })
              const output = view(input.agent, result)
              return { output, content: summary(output) }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
        })
      })
      .pipe(Effect.orDie)
  }),
}

/** Enabled agents by name; later config documents override earlier ones. */
function configured(entries: readonly Entry[]) {
  const merged = new Map(
    entries
      .filter((entry): entry is Document => entry.type === "document")
      .flatMap((entry) => Object.entries(entry.info.a2a?.agents ?? {})),
  )
  return new Map([...merged].filter((entry) => entry[1].enabled !== false))
}

function describe(agents: ReadonlyMap<string, ConfigA2A.Agent>) {
  const list = [...agents].map(([key, agent]) => `- ${key}${agent.description ? `: ${agent.description}` : ""}`)
  return [
    "Send a task to a remote agent over the Agent2Agent (A2A) protocol and wait for its answer.",
    "",
    "The remote agent cannot see this conversation, so include everything it needs in the message. To continue the same conversation, pass the contextId from an earlier result. When the result's state is input-required, answer with the same contextId and taskId.",
    "",
    "Available agents:",
    ...list,
  ].join("\n")
}

/** A direct reply message counts as a completed task. */
function view(agent: string, result: A2ACodec.Task | A2ACodec.Message): typeof Output.Type {
  const reply = "parts" in result
  const taskId = reply ? result.taskId : result.id
  return {
    agent,
    ...(result.contextId ? { contextId: result.contextId } : {}),
    ...(taskId ? { taskId } : {}),
    state: reply ? "completed" : result.status.state,
    text: A2ACodec.text(result),
  }
}

function summary(output: typeof Output.Type) {
  const ids = [output.contextId && `contextId: ${output.contextId}`, output.taskId && `taskId: ${output.taskId}`]
    .filter(Boolean)
    .join(", ")
  return [`${output.agent} (${output.state}${ids ? `; ${ids}` : ""})`, "", output.text || "(no text)"].join("\n")
}
