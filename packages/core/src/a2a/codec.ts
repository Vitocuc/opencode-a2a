export * as A2ACodec from "./codec.js"

import { A2A } from "@opencode/schema/a2a"

/**
 * The dialect-free A2A model OpenCode works with, and its translation to and from the two JSON-RPC wire dialects
 * that `@opencode/schema/a2a` decodes: 0.3 (`kind` discriminators, lowercase enums) and 1.0 (member-name
 * discriminators, `TASK_STATE_*` enums).
 */
export type Version = "0.3" | "1.0"

export type State = A2A.State

const terminalStates: ReadonlySet<State> = new Set(["completed", "canceled", "failed", "rejected"])
/** Terminal states end a task; interrupted ones wait on the caller. Either ends a stream. */
export const isTerminal = (state: State) => terminalStates.has(state)
export const isInterrupted = (state: State) => state === "input-required" || state === "auth-required"

export type Part =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "file"
      readonly bytes?: string
      readonly uri?: string
      readonly name?: string
      readonly mime?: string
    }
  | { readonly type: "data"; readonly data: unknown }

export interface Message {
  readonly messageId: string
  readonly role: "user" | "agent"
  readonly parts: readonly Part[]
  readonly contextId?: string
  readonly taskId?: string
  readonly metadata?: Record<string, unknown>
}

export interface Artifact {
  readonly artifactId: string
  readonly name?: string
  readonly parts: readonly Part[]
}

export interface Status {
  readonly state: State
  readonly message?: Message
  readonly timestamp?: string
}

export interface Task {
  readonly id: string
  readonly contextId: string
  readonly status: Status
  readonly artifacts?: readonly Artifact[]
  readonly history?: readonly Message[]
}

export type Event =
  | { readonly type: "task"; readonly task: Task }
  | { readonly type: "message"; readonly message: Message }
  | { readonly type: "status"; readonly taskId: string; readonly contextId: string; readonly status: Status }
  | {
      readonly type: "artifact"
      readonly taskId: string
      readonly contextId: string
      readonly artifact: Artifact
      readonly append?: boolean
      readonly lastChunk?: boolean
    }

export interface CardInput {
  readonly name: string
  readonly description: string
  readonly version: string
  /** The JSON-RPC endpoint callers send to. */
  readonly url: string
  readonly skills: ReadonlyArray<{ readonly id: string; readonly name: string; readonly description: string }>
  /** Whether the server requires HTTP Basic credentials. */
  readonly basicAuth: boolean
}

export function card(version: Version, input: CardInput): A2A.Card {
  const base = {
    name: input.name,
    description: input.description,
    version: input.version,
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain"],
    skills: input.skills.map((skill) => ({ ...skill, tags: ["opencode"] })),
  }
  if (version === "0.3")
    return {
      ...base,
      protocolVersion: "0.3.0",
      url: input.url,
      preferredTransport: "JSONRPC",
      capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
      ...(input.basicAuth
        ? { securitySchemes: { basic: { type: "http", scheme: "basic" } }, security: [{ basic: [] }] }
        : {}),
    }
  return {
    ...base,
    supportedInterfaces: [{ url: input.url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    capabilities: { streaming: true, pushNotifications: false },
    ...(input.basicAuth
      ? {
          securitySchemes: { basic: { httpAuthSecurityScheme: { scheme: "basic" } } },
          securityRequirements: [{ schemes: { basic: { list: [] } } }],
        }
      : {}),
  }
}

/**
 * The `A2A-Version` a request names, as Major.Minor. An empty or missing value means 0.3; a patch component is
 * tolerated. Undefined for a version this implementation does not speak.
 */
export function requestedVersion(value: string | undefined): Version | undefined {
  const trimmed = value?.trim() ?? ""
  if (trimmed === "") return "0.3"
  const [major, minor] = trimmed.split(".")
  const name = `${major}.${minor ?? "0"}`
  return name === "0.3" || name === "1.0" ? name : undefined
}

/** Where to send JSON-RPC for a remote card, and in which dialect. Undefined when it offers no JSON-RPC binding. */
export function endpoint(remote: A2A.RemoteCard): { readonly url: string; readonly version: Version } | undefined {
  const jsonrpc = remote.supportedInterfaces?.find((item) => item.protocolBinding.toUpperCase() === "JSONRPC")
  if (jsonrpc) return { url: jsonrpc.url, version: jsonrpc.protocolVersion?.startsWith("0.") ? "0.3" : "1.0" }
  if (remote.url) return { url: remote.url, version: "0.3" }
  return undefined
}

export const methods = {
  send: { "0.3": "message/send", "1.0": "SendMessage" },
  stream: { "0.3": "message/stream", "1.0": "SendStreamingMessage" },
  get: { "0.3": "tasks/get", "1.0": "GetTask" },
  cancel: { "0.3": "tasks/cancel", "1.0": "CancelTask" },
  subscribe: { "0.3": "tasks/resubscribe", "1.0": "SubscribeToTask" },
  // 0.3 defines no JSON-RPC list method.
  list: { "0.3": undefined, "1.0": "ListTasks" },
} as const satisfies Record<string, Record<Version, string | undefined>>
export type Method = keyof typeof methods

const byName = new Map<string, { readonly method: Method; readonly version: Version }>(
  (Object.keys(methods) as Method[]).flatMap((key) =>
    (["0.3", "1.0"] as const).flatMap((version) => {
      const name = methods[key][version]
      return name === undefined ? [] : [[name, { method: key, version }] as const]
    }),
  ),
)

/** The operation and dialect a JSON-RPC method name selects. */
export const method = (name: string) => byName.get(name)

/** Push notification config methods in both dialects, all refused because the card does not offer them. */
export const pushMethods: ReadonlySet<string> = new Set([
  "tasks/pushNotificationConfig/set",
  "tasks/pushNotificationConfig/get",
  "tasks/pushNotificationConfig/list",
  "tasks/pushNotificationConfig/delete",
  "CreateTaskPushNotificationConfig",
  "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "DeleteTaskPushNotificationConfig",
])

/** Extended Agent Card methods in both dialects; the card does not declare one. */
export const extendedCardMethods: ReadonlySet<string> = new Set([
  "agent/getAuthenticatedExtendedCard",
  "GetExtendedAgentCard",
])

export const errors = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotificationNotSupported: -32003,
  unsupportedOperation: -32004,
  versionNotSupported: -32009,
} as const

/** `ErrorInfo.reason` for A2A-specific error codes, carried in 1.0 `error.data`. */
export const errorReasons: Readonly<Record<number, string>> = {
  [errors.taskNotFound]: "TASK_NOT_FOUND",
  [errors.taskNotCancelable]: "TASK_NOT_CANCELABLE",
  [errors.pushNotificationNotSupported]: "PUSH_NOTIFICATION_NOT_SUPPORTED",
  [errors.unsupportedOperation]: "UNSUPPORTED_OPERATION",
  [errors.versionNotSupported]: "VERSION_NOT_SUPPORTED",
}

/** A JSON-RPC `error` object; 1.0 adds a google.rpc `ErrorInfo` for A2A-specific codes. */
export function encodeError(version: Version | undefined, error: { readonly code: number; readonly message: string }) {
  const reason = errorReasons[error.code]
  return {
    code: error.code,
    message: error.message,
    ...(version === "1.0" && reason !== undefined
      ? { data: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "a2a-protocol.org" }] }
      : {}),
  }
}

// Normalization of decoded wire values.

function normalizePart(part: typeof A2A.WirePart.Type): Part {
  if ("text" in part) return { type: "text", text: part.text }
  if ("data" in part) return { type: "data", data: part.data }
  if ("file" in part)
    return { type: "file", bytes: part.file.bytes, uri: part.file.uri, name: part.file.name, mime: part.file.mimeType }
  return { type: "file", bytes: part.raw, uri: part.url, name: part.filename, mime: part.mediaType }
}

export function normalizeMessage(message: typeof A2A.WireMessage.Type): Message {
  return {
    messageId: message.messageId,
    role: message.role === "agent" || message.role === "ROLE_AGENT" ? "agent" : "user",
    parts: message.parts.map(normalizePart),
    contextId: message.contextId,
    taskId: message.taskId,
    metadata: message.metadata,
  }
}

export function normalizeState(state: typeof A2A.WireState.Type): State {
  if (!state.startsWith("TASK_STATE_")) return state as State
  const name = state.slice("TASK_STATE_".length).toLowerCase().replaceAll("_", "-")
  if (name === "cancelled") return "canceled"
  if (name === "unspecified") return "unknown"
  return name as State
}

function normalizeStatus(status: typeof A2A.WireStatus.Type): Status {
  return {
    state: normalizeState(status.state),
    message: status.message ? normalizeMessage(status.message) : undefined,
    timestamp: status.timestamp,
  }
}

function normalizeArtifact(artifact: typeof A2A.WireArtifact.Type): Artifact {
  return { artifactId: artifact.artifactId, name: artifact.name, parts: artifact.parts.map(normalizePart) }
}

function normalizeTask(task: typeof A2A.WireTask.Type): Task {
  return {
    id: task.id,
    contextId: task.contextId ?? "",
    status: normalizeStatus(task.status),
    artifacts: task.artifacts?.map(normalizeArtifact),
    history: task.history?.map(normalizeMessage),
  }
}

export function normalizeResult(result: typeof A2A.WireResult.Type): Event {
  // 1.0 wraps each value in a member named for its type; unwrapping leaves the bare 0.3 shapes.
  if ("task" in result) return normalizeResult(result.task)
  if ("message" in result) return normalizeResult(result.message)
  if ("statusUpdate" in result) return normalizeResult(result.statusUpdate)
  if ("artifactUpdate" in result) return normalizeResult(result.artifactUpdate)
  if ("messageId" in result) return { type: "message", message: normalizeMessage(result) }
  if ("id" in result) return { type: "task", task: normalizeTask(result) }
  if ("artifact" in result)
    return {
      type: "artifact",
      taskId: result.taskId,
      contextId: result.contextId ?? "",
      artifact: normalizeArtifact(result.artifact),
      append: result.append,
      lastChunk: result.lastChunk,
    }
  return {
    type: "status",
    taskId: result.taskId,
    contextId: result.contextId ?? "",
    status: normalizeStatus(result.status),
  }
}

/** The text a task or message carries for a reader: artifacts first, else the final status or reply message. */
export function text(value: Task | Message) {
  const artifacts = "parts" in value ? [] : (value.artifacts?.flatMap((artifact) => artifact.parts) ?? [])
  const parts = "parts" in value ? value.parts : artifacts.length > 0 ? artifacts : (value.status.message?.parts ?? [])
  return parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text]
      if (part.type === "data") return [JSON.stringify(part.data)]
      return [part.uri ? `[file ${part.name ?? part.uri}: ${part.uri}]` : `[file ${part.name ?? "attachment"}]`]
    })
    .join("\n")
}

// Encoding to one dialect.

export function encodePart(version: Version, part: Part) {
  if (version === "0.3") {
    if (part.type === "text") return { kind: "text", text: part.text }
    if (part.type === "data") return { kind: "data", data: part.data }
    return {
      kind: "file",
      file: compact({ bytes: part.bytes, uri: part.uri, name: part.name, mimeType: part.mime }),
    }
  }
  if (part.type === "text") return { text: part.text }
  if (part.type === "data") return { data: part.data, mediaType: "application/json" }
  return compact({ raw: part.bytes, url: part.uri, filename: part.name, mediaType: part.mime })
}

export function encodeMessage(version: Version, message: Message) {
  return compact({
    ...(version === "0.3" ? { kind: "message" } : {}),
    messageId: message.messageId,
    role: version === "0.3" ? message.role : message.role === "agent" ? "ROLE_AGENT" : "ROLE_USER",
    parts: message.parts.map((part) => encodePart(version, part)),
    contextId: message.contextId,
    taskId: message.taskId,
    metadata: message.metadata,
  })
}

function encodeState(version: Version, state: State) {
  if (version === "0.3") return state
  if (state === "unknown") return "TASK_STATE_UNSPECIFIED"
  return `TASK_STATE_${state.toUpperCase().replaceAll("-", "_")}`
}

function encodeStatus(version: Version, status: Status) {
  return compact({
    state: encodeState(version, status.state),
    message: status.message ? encodeMessage(version, status.message) : undefined,
    timestamp: status.timestamp,
  })
}

function encodeArtifact(version: Version, artifact: Artifact) {
  return compact({
    artifactId: artifact.artifactId,
    name: artifact.name,
    parts: artifact.parts.map((part) => encodePart(version, part)),
  })
}

export function encodeTask(version: Version, task: Task) {
  return compact({
    ...(version === "0.3" ? { kind: "task" } : {}),
    id: task.id,
    contextId: task.contextId,
    status: encodeStatus(version, task.status),
    artifacts: task.artifacts?.map((artifact) => encodeArtifact(version, artifact)),
    history: task.history?.map((message) => encodeMessage(version, message)),
  })
}

/** A JSON-RPC `result`: a send result or one streamed event. 0.3 status updates carry `final`. */
export function encodeEvent(version: Version, event: Event) {
  if (event.type === "task")
    return version === "0.3" ? encodeTask(version, event.task) : { task: encodeTask(version, event.task) }
  if (event.type === "message")
    return version === "0.3"
      ? encodeMessage(version, event.message)
      : { message: encodeMessage(version, event.message) }
  if (event.type === "status") {
    const update = {
      taskId: event.taskId,
      contextId: event.contextId,
      status: encodeStatus(version, event.status),
    }
    if (version === "1.0") return { statusUpdate: update }
    return {
      kind: "status-update",
      ...update,
      final: isTerminal(event.status.state) || isInterrupted(event.status.state),
    }
  }
  const update = compact({
    taskId: event.taskId,
    contextId: event.contextId,
    artifact: encodeArtifact(version, event.artifact),
    append: event.append,
    lastChunk: event.lastChunk,
  })
  return version === "0.3" ? { kind: "artifact-update", ...update } : { artifactUpdate: update }
}

function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>
  }
}
