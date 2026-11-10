import { A2ACodec } from "@opencode/core/a2a/codec"
import { Agent } from "@opencode/core/agent"
import { Flag } from "@opencode/core/flag"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Session } from "@opencode/core/session"
import { ForbiddenError } from "@opencode/protocol/errors"
import { A2A_PATH } from "@opencode/protocol/groups/a2a"
import { A2A } from "@opencode/schema/a2a"
import { SessionMessage } from "@opencode/schema/session-message"
import { Hash } from "@opencode/util/hash"
import { Cause, Data, DateTime, Effect, Option, Schedule, Schema, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import path from "path"
import { ServerAuth } from "../auth"
import { EventFeed } from "../event-feed"
import { locationErrors, requestRef } from "../location"
import { ServerInfo } from "../server-info"
import { matchesIfNoneMatch } from "./media"

/**
 * OpenCode as an A2A agent. A context is a Session and a task is one prompt: its ID joins the Session ID and the
 * prompt's message ID, so tasks are read back from Session history without a table of their own. A task's state
 * follows the first `idle` marker after its prompt, and its answer is the turn's last assistant text.
 */
export const makeA2A = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const locations = yield* LocationServiceMap.Service
  const auth = yield* ServerAuth.Config

  const card = Effect.fn("server.a2a.card")(function* (request: HttpServerRequest.HttpServerRequest) {
    if (!(yield* Flag.enabled("a2a"))) return yield* new ForbiddenError({ message: DISABLED })
    const location = yield* Location.Service
    const info = yield* ServerInfo.Service
    const agents = yield* Agent.Service.use((service) => service.list())
    const url = new URL(A2A_PATH, origin(request))
    url.searchParams.set("location[directory]", location.directory)
    // A version this server does not speak gets the newest card it has.
    const json = JSON.stringify(
      A2ACodec.card(A2ACodec.requestedVersion(requestVersion(request)) ?? "1.0", {
        name: `OpenCode (${path.basename(location.directory) || location.directory})`,
        description: `OpenCode coding agent working in ${location.directory}. Each context is an OpenCode session; pick a skill's agent with message metadata { "agent": "<skill id>" }.`,
        version: info.app.version ?? "unknown",
        url: url.href,
        skills: agents
          .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
          .map((agent) => ({
            id: agent.id,
            name: agent.name,
            description: agent.description ?? `Work with the ${agent.name} agent.`,
          })),
        basicAuth: ServerAuth.required(auth),
      }),
    )
    const etag = `"${Hash.sha256(json)}"`
    // The card depends on the requested dialect and declares the server's auth, so caches keep it per caller.
    const headers = { "Cache-Control": "private, max-age=300", ETag: etag, Vary: "A2A-Version, Authorization" }
    if (matchesIfNoneMatch(request.headers["if-none-match"], etag))
      return HttpServerResponse.empty({ status: 304, headers })
    return HttpServerResponse.text(json, { contentType: "application/json", headers })
  })

  const rpc = Effect.fn("server.a2a.rpc")(function* (request: HttpServerRequest.HttpServerRequest) {
    const body = yield* request.text.pipe(Effect.option)
    const json = Option.flatMap(body, Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown)))
    if (Option.isNone(json))
      return rpcError(null, new RpcError({ code: A2ACodec.errors.parse, message: "Invalid JSON" }))
    const decoded = Schema.decodeUnknownOption(A2A.RpcRequest)(json.value)
    if (Option.isNone(decoded))
      return rpcError(null, new RpcError({ code: A2ACodec.errors.invalidRequest, message: "Invalid JSON-RPC request" }))
    const id = decoded.value.id ?? null
    if (!(yield* Flag.enabled("a2a")))
      return rpcError(id, new RpcError({ code: A2ACodec.errors.unsupportedOperation, message: DISABLED }))
    const requested = requestVersion(request)
    const version = A2ACodec.requestedVersion(requested)
    if (version === undefined)
      return rpcError(
        id,
        new RpcError({
          code: A2ACodec.errors.versionNotSupported,
          message: `A2A version ${requested} is not supported; use 0.3 or 1.0`,
        }),
        "1.0",
      )
    const selected = A2ACodec.method(decoded.value.method)
    if (!selected) return rpcError(id, unsupported(decoded.value.method), version)
    // The method name decides the dialect, so a 1.0 method without the header is still answered in 1.0.
    const dialect = selected.version
    const location = requestRef(request)
    const params = decoded.value.params

    const answer: Effect.Effect<HttpServerResponse.HttpServerResponse, RpcError> =
      selected.method === "send"
        ? send(location, params).pipe(
            Effect.flatMap((task) =>
              task.blocking ? settle(task.ref, task.historyLength) : read(task.ref, task.historyLength),
            ),
            Effect.map((task) => rpcResult(id, A2ACodec.encodeEvent(dialect, { type: "task", task }))),
          )
        : selected.method === "stream"
          ? send(location, params).pipe(
              Effect.flatMap((task) => read(task.ref).pipe(Effect.map((initial) => follow(task.ref, initial)))),
              Effect.map((events) => sse(id, dialect, events)),
            )
          : selected.method === "subscribe"
            ? taskParams(params).pipe(
                Effect.flatMap((input) =>
                  read(input.ref).pipe(
                    Effect.filterOrFail(
                      (task) => !A2ACodec.isTerminal(task.status.state),
                      (task) =>
                        new RpcError({
                          code: A2ACodec.errors.unsupportedOperation,
                          message: `Task ${task.id} is already ${task.status.state}`,
                        }),
                    ),
                    Effect.map((task) => sse(id, dialect, follow(input.ref, task))),
                  ),
                ),
              )
            : selected.method === "list"
              ? list(location, params).pipe(Effect.map((result) => rpcResult(id, result)))
              : taskParams(params).pipe(
                  Effect.flatMap((input) =>
                    selected.method === "get" ? read(input.ref, input.historyLength) : cancel(input.ref),
                  ),
                  Effect.map((task) => rpcResult(id, A2ACodec.encodeTask(dialect, task))),
                )
    return yield* answer.pipe(Effect.catchTag("A2A.RpcError", (error) => Effect.succeed(rpcError(id, error, dialect))))
  })

  return {
    card: (request: HttpServerRequest.HttpServerRequest) =>
      card(request).pipe(Effect.provide(locations.get(requestRef(request))), locationErrors),
    rpc: (request: HttpServerRequest.HttpServerRequest) =>
      rpc(request).pipe(
        Effect.provide(locations.get(requestRef(request))),
        Effect.catchCause((cause) =>
          Effect.succeed(
            rpcError(null, new RpcError({ code: A2ACodec.errors.internal, message: Cause.pretty(cause) })),
          ),
        ),
      ),
  }

  /** Admits the message as a prompt, in its context's Session or a new one. */
  function send(location: Location.Ref, params: unknown) {
    return Effect.gen(function* () {
      const input = yield* decodeParams(A2A.SendParams, params)
      const message = A2ACodec.normalizeMessage(input.message)
      if (message.role !== "user") return yield* invalidParams("message.role must be user")
      const agent = typeof message.metadata?.agent === "string" ? Agent.ID.make(message.metadata.agent) : undefined
      const sessionID = yield* contextSession(message)
      // A new Session is left untitled so the runner names it from the conversation.
      const session = sessionID
        ? yield* sessions.get(sessionID).pipe(Effect.mapError(() => invalidParams(`Unknown contextId: ${sessionID}`)))
        : yield* sessions.create({ location, agent, metadata: { a2a: true } }).pipe(Effect.mapError(internal))
      // A Session continued over A2A becomes an A2A context, so ListTasks finds its tasks.
      if (session.metadata?.a2a !== true)
        yield* sessions
          .setMetadata({ sessionID: session.id, metadata: { ...session.metadata, a2a: true } })
          .pipe(Effect.ignore)
      if (sessionID && agent) yield* sessions.switchAgent({ sessionID: session.id, agent }).pipe(Effect.ignore)
      const messageID = SessionMessage.ID.create()
      yield* sessions
        .prompt({
          sessionID: session.id,
          id: messageID,
          ...prompt(message),
          metadata: { a2a: { messageId: message.messageId } },
        })
        .pipe(Effect.mapError(internal))
      const configuration = input.configuration
      return {
        ref: { sessionID: session.id, messageID },
        blocking: configuration?.blocking !== false && configuration?.returnImmediately !== true,
        historyLength: configuration?.historyLength,
      }
    })
  }

  /** The task's prompt once delivered, none while it waits in the inbox, and TaskNotFound otherwise. */
  function prompted(ref: TaskRef) {
    return Effect.gen(function* () {
      const message = yield* sessions.messageWithRefs(ref)
      if (message?.type === "user") return Option.some(message)
      const inbox = yield* sessions.inbox(ref.sessionID).pipe(Effect.orElseSucceed(() => []))
      if (!inbox.some((item) => item.id === ref.messageID)) return yield* taskNotFound(taskID(ref))
      return Option.none<SessionMessage.MediaUser>()
    })
  }

  /** The task's current state, read from Session history. */
  function read(ref: TaskRef, historyLength?: number) {
    return prompted(ref).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.succeed<A2ACodec.Task>({
              id: taskID(ref),
              contextId: ref.sessionID,
              status: { state: "submitted" },
            }),
          onSome: (user) =>
            sessions
              .messagesWithRefs({
                sessionID: ref.sessionID,
                order: "asc",
                cursor: { id: ref.messageID, direction: "next" },
              })
              .pipe(
                Effect.mapError(internal),
                Effect.map((after) => fromHistory(ref, user, after, historyLength)),
              ),
        }),
      ),
    )
  }

  /**
   * ListTasks over this Location's A2A contexts, newest status first. The page token is the base64url ID of the
   * previous page's last task. Prompts still waiting in a Session's inbox are not listed until they are delivered.
   */
  function list(location: Location.Ref, params: unknown) {
    return Effect.gen(function* () {
      const input = yield* decodeParams(A2A.ListParams, params)
      const pageSize = input.pageSize ?? 50
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
        return yield* invalidParams("pageSize must be an integer from 1 to 100")
      const contexts =
        input.contextId === undefined
          ? yield* contextSessions(location)
          : yield* Option.match(Schema.decodeUnknownOption(Session.ID)(input.contextId), {
              onNone: () => Effect.succeed<readonly Session.Info[]>([]),
              onSome: (sessionID) =>
                sessions.get(sessionID).pipe(
                  Effect.map((session) => (session.metadata?.a2a === true ? [session] : [])),
                  Effect.orElseSucceed(() => []),
                ),
            })
      const tasks = yield* Effect.forEach(contexts, (session) =>
        sessions.messagesWithRefs({ sessionID: session.id, order: "asc" }).pipe(
          Effect.mapError(internal),
          Effect.map((messages) =>
            messages.flatMap((message, index) =>
              message.type === "user" && message.metadata?.a2a !== undefined
                ? [
                    fromHistory(
                      { sessionID: session.id, messageID: message.id },
                      message,
                      messages.slice(index + 1),
                      input.historyLength,
                    ),
                  ]
                : [],
            ),
          ),
        ),
      )
      const status = input.status === undefined ? undefined : A2ACodec.normalizeState(input.status)
      const after = input.statusTimestampAfter === undefined ? undefined : Date.parse(input.statusTimestampAfter)
      if (after !== undefined && Number.isNaN(after)) return yield* invalidParams("Invalid statusTimestampAfter")
      const matching = tasks
        .flat()
        .filter((task) => status === undefined || task.status.state === status)
        .filter((task) => after === undefined || Date.parse(task.status.timestamp ?? "") > after)
        .toSorted(
          (a, b) => (b.status.timestamp ?? "").localeCompare(a.status.timestamp ?? "") || b.id.localeCompare(a.id),
        )
      const token = input.pageToken ? Buffer.from(input.pageToken, "base64url").toString() : undefined
      const start = token === undefined ? 0 : matching.findIndex((task) => task.id === token) + 1
      if (token !== undefined && start === 0) return yield* invalidParams("Invalid pageToken")
      const page = matching.slice(start, start + pageSize)
      const last = page.at(-1)
      return {
        tasks: page.map((task) =>
          A2ACodec.encodeTask("1.0", input.includeArtifacts === true ? task : { ...task, artifacts: undefined }),
        ),
        nextPageToken: last && start + pageSize < matching.length ? Buffer.from(last.id).toString("base64url") : "",
        pageSize,
        totalSize: matching.length,
      }
    })
  }

  /** Every A2A context in the Location, read page by page. */
  function contextSessions(location: Location.Ref) {
    const page = (
      cursor: Session.ListCursor | undefined,
      found: readonly Session.Info[],
    ): Effect.Effect<readonly Session.Info[], RpcError> =>
      sessions.list({ directory: location.directory, limit: 200, cursor }).pipe(
        Effect.mapError(internal),
        Effect.flatMap((result) => {
          const next = [...found, ...result.data.filter((session) => session.metadata?.a2a === true)]
          return result.cursor.next ? page(result.cursor.next, next) : Effect.succeed(next)
        }),
      )
    return page(undefined, [])
  }

  /**
   * The Session a message continues: its contextId, else the Session of the task it answers. A taskId must name an
   * existing task, and a contextId sent with it must be that task's context.
   */
  function contextSession(message: A2ACodec.Message): Effect.Effect<Session.ID | undefined, RpcError> {
    const taskId = message.taskId
    if (taskId !== undefined)
      return Option.match(parseTaskID(taskId), {
        onNone: () => Effect.fail(taskNotFound(taskId)),
        onSome: (ref) =>
          message.contextId !== undefined && message.contextId !== ref.sessionID
            ? Effect.fail(invalidParams(`contextId ${message.contextId} does not match task ${taskId}`))
            : prompted(ref).pipe(Effect.as(ref.sessionID)),
      })
    if (message.contextId !== undefined)
      return Option.match(Schema.decodeUnknownOption(Session.ID)(message.contextId), {
        onNone: () => Effect.fail(invalidParams(`Unknown contextId: ${message.contextId}`)),
        onSome: (id) => Effect.succeed(id),
      })
    return Effect.succeed(undefined)
  }

  /** Waits until the task reaches a terminal state. */
  function settle(ref: TaskRef, historyLength?: number) {
    return sessions.wait(ref.sessionID).pipe(
      Effect.mapError(internal),
      Effect.andThen(read(ref, historyLength)),
      // The Session can go idle before this prompt's turn when it was queued behind other work.
      Effect.repeat({
        schedule: Schedule.spaced("250 millis"),
        until: (task) => A2ACodec.isTerminal(task.status.state),
      }),
    )
  }

  function cancel(ref: TaskRef) {
    return Effect.gen(function* () {
      const task = yield* read(ref)
      if (A2ACodec.isTerminal(task.status.state))
        return yield* new RpcError({
          code: A2ACodec.errors.taskNotCancelable,
          message: `Task ${task.id} is already ${task.status.state}`,
        })
      if (task.status.state === "submitted")
        yield* sessions.cancelInbox({ sessionID: ref.sessionID, inboxID: ref.messageID }).pipe(Effect.ignore)
      yield* sessions.interrupt(ref.sessionID)
      return yield* settle(ref).pipe(
        Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => read(ref) }),
        // A prompt cancelled before delivery leaves no history, so it reads as not found.
        Effect.catchTag("A2A.RpcError", (error) =>
          error.code === A2ACodec.errors.taskNotFound
            ? Effect.succeed<A2ACodec.Task>({ ...task, status: { state: "canceled" } })
            : Effect.fail(error),
        ),
      )
    })
  }

  /**
   * The task, then each finished stretch of assistant text as an artifact chunk, then its terminal status. The
   * Session log replays history before it follows live events; only events after its sync marker are new, and the
   * marker itself rechecks the task in case it finished before the log was opened.
   */
  function follow(ref: TaskRef, initial: A2ACodec.Task): Stream.Stream<A2ACodec.Event, RpcError> {
    const id = taskID(ref)
    const chunks = { count: 0 }
    const artifact = (
      text: string,
      flags: { readonly append?: boolean; readonly lastChunk?: boolean },
    ): A2ACodec.Event => ({
      type: "artifact",
      taskId: id,
      contextId: ref.sessionID,
      artifact: responseArtifact(id, text),
      ...flags,
    })
    // A turn that finished before the log caught up streamed no chunks, so its answer goes out whole. Streamed
    // chunks end with an empty one marked lastChunk, since a segment is only known to be last afterwards.
    const final = (task: A2ACodec.Task): A2ACodec.Event[] => {
      if (!A2ACodec.isTerminal(task.status.state)) return []
      const answer = task.artifacts?.[0]?.parts[0]
      const closing =
        chunks.count > 0
          ? [artifact("", { append: true, lastChunk: true })]
          : answer?.type === "text"
            ? [artifact(answer.text, { lastChunk: true })]
            : []
      return [...closing, { type: "status", taskId: id, contextId: ref.sessionID, status: task.status }]
    }
    const live = sessions.log({ sessionID: ref.sessionID, follow: true }).pipe(
      Stream.mapError(internal),
      Stream.dropWhile((event) => event.type !== "log.synced"),
      Stream.mapEffect((event): Effect.Effect<A2ACodec.Event[], RpcError> => {
        if (event.type === "session.text.ended" && event.data.text.length > 0)
          return Effect.succeed([artifact(event.data.text, { append: chunks.count++ > 0 })])
        if (
          event.type === "log.synced" ||
          event.type === "session.execution.succeeded" ||
          event.type === "session.execution.failed" ||
          event.type === "session.execution.interrupted"
        )
          return read(ref).pipe(Effect.map(final))
        return Effect.succeed([])
      }),
      Stream.flattenIterable,
      Stream.takeUntil((event) => event.type === "status"),
    )
    const first: A2ACodec.Event = {
      type: "task",
      task: { ...initial, status: { state: "working" }, artifacts: [] },
    }
    return Stream.make(first).pipe(Stream.concat(live))
  }
})

type TaskRef = { readonly sessionID: Session.ID; readonly messageID: SessionMessage.ID }

class RpcError extends Data.TaggedError("A2A.RpcError")<{ readonly code: number; readonly message: string }> {}

const DISABLED = "A2A is disabled for this location; set experimental.a2a to true in its config"

const taskID = (ref: TaskRef) => `${ref.sessionID}:${ref.messageID}`

const responseArtifact = (id: string, text: string): A2ACodec.Artifact => ({
  artifactId: `${id}:response`,
  name: "response",
  parts: [{ type: "text", text }],
})

/**
 * A delivered prompt as a task. `after` is the Session history that follows it; the first `idle` marker ends its
 * turn and dates its terminal status.
 */
function fromHistory(
  ref: TaskRef,
  user: SessionMessage.MediaUser,
  after: readonly SessionMessage.MediaInfo[],
  historyLength?: number,
): A2ACodec.Task {
  const id = taskID(ref)
  const idle = after.find((message): message is SessionMessage.Idle => message.type === "idle")
  const turn = idle ? after.slice(0, after.indexOf(idle)) : after
  const state: A2ACodec.State = idle
    ? ({ succeeded: "completed", failed: "failed", interrupted: "canceled" } as const)[idle.outcome]
    : "working"
  const answer = turn
    .filter((message) => message.type === "assistant")
    .map((message) => message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join(""))
    .findLast((text) => text.length > 0)
  const reply = answer ?? idle?.error?.message
  const agentMessage: A2ACodec.Message | undefined = reply
    ? {
        messageId: `${id}:reply`,
        role: "agent",
        parts: [{ type: "text", text: reply }],
        contextId: ref.sessionID,
        taskId: id,
      }
    : undefined
  const history: A2ACodec.Message[] = [
    {
      messageId: ref.messageID,
      role: "user",
      parts: [{ type: "text", text: user.text }],
      contextId: ref.sessionID,
      taskId: id,
    },
    ...(agentMessage ? [agentMessage] : []),
  ]
  return {
    id,
    contextId: ref.sessionID,
    status: {
      state,
      message: A2ACodec.isTerminal(state) ? agentMessage : undefined,
      timestamp: DateTime.formatIso(idle ? idle.time.created : user.time.created),
    },
    artifacts: answer ? [responseArtifact(id, answer)] : [],
    history: historyLength === undefined ? history : historyLength <= 0 ? undefined : history.slice(-historyLength),
  }
}

function parseTaskID(id: string) {
  const [session, message] = id.split(":")
  const sessionID = Schema.decodeUnknownOption(Session.ID)(session)
  const messageID = Schema.decodeUnknownOption(SessionMessage.ID)(message)
  if (Option.isNone(sessionID) || Option.isNone(messageID)) return Option.none<TaskRef>()
  return Option.some({ sessionID: sessionID.value, messageID: messageID.value })
}

function decodeParams<S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, params: unknown) {
  return Schema.decodeUnknownEffect(schema)(params).pipe(Effect.mapError(() => invalidParams("Invalid params")))
}

function taskParams(params: unknown) {
  return decodeParams(A2A.TaskParams, params).pipe(
    Effect.flatMap((input) =>
      Option.match(parseTaskID(input.id), {
        onNone: () => Effect.fail(taskNotFound(input.id)),
        onSome: (ref) => Effect.succeed({ ref, historyLength: input.historyLength }),
      }),
    ),
  )
}

/** Text and data parts become the prompt text; inline files become attachments and linked files are named in the text. */
function prompt(message: A2ACodec.Message) {
  const text = message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text]
      if (part.type === "data") return ["```json\n" + JSON.stringify(part.data, null, 2) + "\n```"]
      if (part.uri) return [part.name ? `Attached file ${part.name}: ${part.uri}` : `Attached file: ${part.uri}`]
      return []
    })
    .join("\n\n")
  const files = message.parts.flatMap((part) =>
    part.type === "file" && part.bytes
      ? [{ uri: `data:${part.mime ?? "application/octet-stream"};base64,${part.bytes}`, name: part.name }]
      : [],
  )
  return { text, ...(files.length > 0 ? { files } : {}) }
}

function invalidParams(message: string) {
  return new RpcError({ code: A2ACodec.errors.invalidParams, message })
}

function internal(error: { readonly message: string }) {
  return new RpcError({ code: A2ACodec.errors.internal, message: error.message })
}

function taskNotFound(id: string) {
  return new RpcError({ code: A2ACodec.errors.taskNotFound, message: `Task not found: ${id}` })
}

function unsupported(method: string) {
  if (A2ACodec.pushMethods.has(method))
    return new RpcError({
      code: A2ACodec.errors.pushNotificationNotSupported,
      message: "Push notifications are not supported",
    })
  if (A2ACodec.extendedCardMethods.has(method))
    return new RpcError({ code: A2ACodec.errors.unsupportedOperation, message: "No extended Agent Card" })
  return new RpcError({ code: A2ACodec.errors.methodNotFound, message: `Method not found: ${method}` })
}

function rpcResult(id: string | number | null, result: unknown) {
  return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id, result })
}

function rpcError(id: string | number | null, error: RpcError, version?: A2ACodec.Version) {
  return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id, error: A2ACodec.encodeError(version, error) })
}

function sse(id: string | number | null, version: A2ACodec.Version, events: Stream.Stream<A2ACodec.Event, RpcError>) {
  const frame = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`
  return EventFeed.response(
    events.pipe(
      Stream.map((event) => frame({ jsonrpc: "2.0", id, result: A2ACodec.encodeEvent(version, event) })),
      Stream.catchCause((cause) =>
        Stream.make(
          frame({ jsonrpc: "2.0", id, error: { code: A2ACodec.errors.internal, message: Cause.pretty(cause) } }),
        ),
      ),
    ),
  )
}

/** `A2A-Version` from the header, or from the query parameter clients may send instead. */
function requestVersion(request: HttpServerRequest.HttpServerRequest) {
  return (
    request.headers["a2a-version"] ??
    new URL(request.url, "http://localhost").searchParams.get("A2A-Version") ??
    undefined
  )
}

/** The origin callers reached: a proxy's forwarded host, else the request's own absolute URL. */
function origin(request: HttpServerRequest.HttpServerRequest) {
  const first = (value: string) => value.split(",")[0].trim()
  const forwarded = request.headers["x-forwarded-host"]
  if (forwarded) return `${first(request.headers["x-forwarded-proto"] ?? "http")}://${first(forwarded)}`
  return URL.parse(request.originalUrl)?.origin ?? `http://${request.headers.host ?? "localhost"}`
}
