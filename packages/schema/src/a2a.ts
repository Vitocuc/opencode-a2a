export * as A2A from "./a2a.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
/**
 * Agent2Agent (A2A) protocol wire contracts over the JSON-RPC binding. Two dialects are in use: 0.3 (`message/send`,
 * `kind` discriminators, lowercase enums) and 1.0 (`SendMessage`, member-name discriminators, `TASK_STATE_*` enums).
 * Inbound schemas accept either. Normalizing and encoding live in Core's `A2ACodec`.
 */

export const State = Schema.Literals([
  "submitted",
  "working",
  "input-required",
  "auth-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
  "unknown",
]).annotate({ identifier: "A2A.State" })
export type State = typeof State.Type

// Inbound wire schemas. Excess properties are ignored on decode, so `{ kind: "text", text }` (0.3) and
// `{ text }` (1.0) both match the same text part.

const Metadata = Schema.Record(Schema.String, Schema.Unknown)

const WireTextPart = Schema.Struct({ text: Schema.String })
const WireDataPart = Schema.Struct({ data: Schema.Unknown })
const WireFile03 = Schema.Struct({
  file: Schema.Struct({
    bytes: Schema.String.pipe(optional),
    uri: Schema.String.pipe(optional),
    name: Schema.String.pipe(optional),
    mimeType: Schema.String.pipe(optional),
  }),
})
const WireFile10 = Schema.Struct({
  raw: Schema.String.pipe(optional),
  url: Schema.String.pipe(optional),
  filename: Schema.String.pipe(optional),
  mediaType: Schema.String.pipe(optional),
})
export const WirePart = Schema.Union([WireTextPart, WireDataPart, WireFile03, WireFile10])

const WireRole = Schema.Literals(["user", "agent", "ROLE_USER", "ROLE_AGENT"])

export const WireMessage = Schema.Struct({
  messageId: Schema.String,
  role: WireRole,
  parts: Schema.Array(WirePart),
  contextId: Schema.String.pipe(optional),
  taskId: Schema.String.pipe(optional),
  metadata: Metadata.pipe(optional),
}).annotate({ identifier: "A2A.WireMessage" })

export const WireState = Schema.Union([
  State,
  Schema.Literals([
    "TASK_STATE_UNSPECIFIED",
    "TASK_STATE_SUBMITTED",
    "TASK_STATE_WORKING",
    "TASK_STATE_INPUT_REQUIRED",
    "TASK_STATE_AUTH_REQUIRED",
    "TASK_STATE_COMPLETED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_CANCELLED",
    "TASK_STATE_FAILED",
    "TASK_STATE_REJECTED",
  ]),
])

export const WireStatus = Schema.Struct({
  state: WireState,
  message: WireMessage.pipe(optional),
  timestamp: Schema.String.pipe(optional),
})

export const WireArtifact = Schema.Struct({
  artifactId: Schema.String,
  name: Schema.String.pipe(optional),
  parts: Schema.Array(WirePart),
})

export const WireTask = Schema.Struct({
  id: Schema.String,
  contextId: Schema.String.pipe(optional),
  status: WireStatus,
  artifacts: Schema.Array(WireArtifact).pipe(optional),
  history: Schema.Array(WireMessage).pipe(optional),
}).annotate({ identifier: "A2A.WireTask" })

const WireStatusUpdate = Schema.Struct({
  taskId: Schema.String,
  contextId: Schema.String.pipe(optional),
  status: WireStatus,
})

const WireArtifactUpdate = Schema.Struct({
  taskId: Schema.String,
  contextId: Schema.String.pipe(optional),
  artifact: WireArtifact,
  append: Schema.Boolean.pipe(optional),
  lastChunk: Schema.Boolean.pipe(optional),
})

/** A `SendMessage` / `message/send` result, or one streamed event, in either dialect. */
export const WireResult = Schema.Union([
  Schema.Struct({ task: WireTask }),
  Schema.Struct({ message: WireMessage }),
  Schema.Struct({ statusUpdate: WireStatusUpdate }),
  Schema.Struct({ artifactUpdate: WireArtifactUpdate }),
  WireTask,
  WireMessage,
  WireStatusUpdate,
  WireArtifactUpdate,
]).annotate({ identifier: "A2A.WireResult" })

export const SendParams = Schema.Struct({
  message: WireMessage,
  configuration: Schema.Struct({
    /** 0.3: wait for a terminal or interrupted state. */
    blocking: Schema.Boolean.pipe(optional),
    /** 1.0: answer as soon as the task exists. */
    returnImmediately: Schema.Boolean.pipe(optional),
    historyLength: Schema.Number.pipe(optional),
  }).pipe(optional),
  metadata: Metadata.pipe(optional),
}).annotate({ identifier: "A2A.SendParams" })

/** 1.0 `ListTasks`; 0.3 has no JSON-RPC list method. */
export const ListParams = Schema.Struct({
  contextId: Schema.String.pipe(optional),
  status: WireState.pipe(optional),
  pageSize: Schema.Number.pipe(optional),
  pageToken: Schema.String.pipe(optional),
  historyLength: Schema.Number.pipe(optional),
  statusTimestampAfter: Schema.String.pipe(optional),
  includeArtifacts: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "A2A.ListParams" })

export const TaskParams = Schema.Struct({
  id: Schema.String,
  historyLength: Schema.Number.pipe(optional),
}).annotate({ identifier: "A2A.TaskParams" })

export const RpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.String, Schema.Number, Schema.Null]).pipe(optional),
  method: Schema.String,
  params: Schema.Unknown.pipe(optional),
}).annotate({ identifier: "A2A.RpcRequest" })

/** What a client needs from a remote Agent Card in either dialect. */
export const RemoteCard = Schema.Struct({
  name: Schema.String,
  description: Schema.String.pipe(optional),
  url: Schema.String.pipe(optional),
  protocolVersion: Schema.String.pipe(optional),
  supportedInterfaces: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      protocolBinding: Schema.String,
      protocolVersion: Schema.String.pipe(optional),
    }),
  ).pipe(optional),
  skills: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, description: Schema.String.pipe(optional) }),
  ).pipe(optional),
}).annotate({ identifier: "A2A.RemoteCard" })
export type RemoteCard = typeof RemoteCard.Type

// Outbound Agent Card, served per dialect.

const Skill = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  tags: Schema.Array(Schema.String),
})

const CardBase = {
  name: Schema.String,
  description: Schema.String,
  version: Schema.String,
  defaultInputModes: Schema.Array(Schema.String),
  defaultOutputModes: Schema.Array(Schema.String),
  skills: Schema.Array(Skill),
}

export const Card03 = Schema.Struct({
  ...CardBase,
  protocolVersion: Schema.String,
  url: Schema.String,
  preferredTransport: Schema.Literal("JSONRPC"),
  capabilities: Schema.Struct({
    streaming: Schema.Boolean,
    pushNotifications: Schema.Boolean,
    stateTransitionHistory: Schema.Boolean,
  }),
  securitySchemes: Schema.Record(
    Schema.String,
    Schema.Struct({ type: Schema.Literal("http"), scheme: Schema.String }),
  ).pipe(optional),
  security: Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String))).pipe(optional),
}).annotate({ identifier: "A2A.Card03", description: "A2A 0.3 Agent Card." })

export const Card10 = Schema.Struct({
  ...CardBase,
  supportedInterfaces: Schema.Array(
    Schema.Struct({ url: Schema.String, protocolBinding: Schema.String, protocolVersion: Schema.String }),
  ),
  capabilities: Schema.Struct({ streaming: Schema.Boolean, pushNotifications: Schema.Boolean }),
  securitySchemes: Schema.Record(
    Schema.String,
    Schema.Struct({ httpAuthSecurityScheme: Schema.Struct({ scheme: Schema.String }) }),
  ).pipe(optional),
  securityRequirements: Schema.Array(
    Schema.Struct({
      schemes: Schema.Record(Schema.String, Schema.Struct({ list: Schema.Array(Schema.String) })),
    }),
  ).pipe(optional),
}).annotate({ identifier: "A2A.Card10", description: "A2A 1.0 Agent Card." })

export const Card = Schema.Union([Card10, Card03]).annotate({ identifier: "A2A.Card" })
export type Card = typeof Card.Type
