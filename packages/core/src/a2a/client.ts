export * as A2AClient from "./client.js"

import { A2A } from "@opencode/schema/a2a"
import { Duration, Effect, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { collectBoundedResponseBody } from "../tool/http-body.js"
import { A2ACodec } from "./codec.js"

export class RequestError extends Schema.TaggedError<RequestError>()("A2AClient.RequestError", {
  message: Schema.String,
}) {}

/** Cards and JSON-RPC answers come from remote agents, so their bodies are read up to this size. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

export interface Remote {
  /** An Agent Card URL, or a base URL whose card is at `/.well-known/agent-card.json`. */
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
}

export interface Target extends Remote {
  readonly card: A2A.RemoteCard
  /** The JSON-RPC endpoint. */
  readonly endpoint: string
  readonly version: A2ACodec.Version
}

/** Reads the remote Agent Card and picks its JSON-RPC endpoint and dialect. */
export const discover = Effect.fn("A2AClient.discover")(function* (http: HttpClient.HttpClient, remote: Remote) {
  const card = yield* http
    .execute(
      HttpClientRequest.get(cardURL(remote.url)).pipe(
        HttpClientRequest.setHeaders(remote.headers ?? {}),
        HttpClientRequest.acceptJson,
      ),
    )
    .pipe(Effect.flatMap((response) => decodeBody(response, A2A.RemoteCard)))
  const target = A2ACodec.endpoint(card)
  if (!target) return yield* new RequestError({ message: `${card.name} offers no JSON-RPC interface` })
  return { ...remote, card, endpoint: target.url, version: target.version } satisfies Target
}, Effect.mapError(toError))

/**
 * Sends one text message and waits for the agent's answer: a direct reply message, or the task once it is terminal
 * or waiting on input. Agents that answer before the task settles are polled with GetTask.
 */
export const send = Effect.fn("A2AClient.send")(function* (
  http: HttpClient.HttpClient,
  target: Target,
  input: {
    readonly text: string
    readonly contextId?: string
    readonly taskId?: string
    readonly timeout: Duration.Input
  },
) {
  const message: A2ACodec.Message = {
    messageId: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: input.text }],
    contextId: input.contextId,
    taskId: input.taskId,
  }
  return yield* call(http, target, "send", {
    message: A2ACodec.encodeMessage(target.version, message),
    configuration: target.version === "0.3" ? { blocking: true } : { returnImmediately: false },
  }).pipe(
    Effect.flatMap((event) => {
      if (event.type === "message") return Effect.succeed<A2ACodec.Task | A2ACodec.Message>(event.message)
      if (event.type !== "task")
        return Effect.fail(new RequestError({ message: `Unexpected ${event.type} event in a send result` }))
      if (settled(event.task)) return Effect.succeed(event.task)
      return get(http, target, event.task.id).pipe(
        Effect.repeat({ schedule: Schedule.spaced("2 seconds"), until: settled }),
      )
    }),
    Effect.timeoutOrElse({
      duration: input.timeout,
      orElse: () => Effect.fail(new RequestError({ message: `${target.card.name} did not finish in time` })),
    }),
  )
}, Effect.mapError(toError))

const settled = (task: A2ACodec.Task) =>
  A2ACodec.isTerminal(task.status.state) || A2ACodec.isInterrupted(task.status.state)

const get = (http: HttpClient.HttpClient, target: Target, id: string) =>
  call(http, target, "get", { id }).pipe(
    Effect.flatMap((event) =>
      event.type === "task"
        ? Effect.succeed(event.task)
        : Effect.fail(new RequestError({ message: `Unexpected ${event.type} event in a GetTask result` })),
    ),
  )

const RpcResponse = Schema.Struct({
  result: Schema.optional(A2A.WireResult),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})

function call(http: HttpClient.HttpClient, target: Target, method: "send" | "get", params: unknown) {
  return Effect.gen(function* () {
    const request = HttpClientRequest.post(target.endpoint).pipe(
      HttpClientRequest.setHeaders({
        ...target.headers,
        ...(target.version === "1.0" ? { "A2A-Version": "1.0" } : {}),
      }),
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJsonUnsafe({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: A2ACodec.methods[method][target.version],
        params,
      }),
    )
    const body = yield* http.execute(request).pipe(Effect.flatMap((response) => decodeBody(response, RpcResponse)))
    if (body.error)
      return yield* new RequestError({ message: `${target.card.name}: ${body.error.message} (${body.error.code})` })
    if (!body.result) return yield* new RequestError({ message: `${target.card.name} sent no result` })
    return A2ACodec.normalizeResult(body.result)
  })
}

function decodeBody<S extends Schema.Top & { readonly DecodingServices: never }>(
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
) {
  return HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap((ok) =>
      collectBoundedResponseBody(
        ok,
        MAX_RESPONSE_BYTES,
        () => new RequestError({ message: `Response exceeds ${MAX_RESPONSE_BYTES} bytes` }),
      ),
    ),
    Effect.flatMap((bytes) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(bytes.toString())),
  )
}

function cardURL(url: string) {
  const parsed = new URL(url)
  if (parsed.pathname !== "/" && parsed.pathname !== "") return parsed.href
  return new URL("/.well-known/agent-card.json", parsed).href
}

function toError(error: Error) {
  return error instanceof RequestError ? error : new RequestError({ message: error.message })
}
