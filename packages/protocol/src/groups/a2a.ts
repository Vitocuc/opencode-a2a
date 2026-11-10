import { A2A } from "@opencode/schema/a2a"
import { Schema } from "effect"
import { HttpApiEndpoint, OpenApi } from "effect/http-api"
import { ForbiddenError, LocationNotFoundError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const EXPERIMENTAL = "Experimental: needs experimental.a2a in the Location's config and may change without notice."

export const A2A_PATH = "/api/experimental/a2a"
export const A2A_CARD_PATH = "/api/experimental/a2a/card"

// The routes share the `server.experimental` group with the persistent PTY prototype; tag them on their own.
const tags = OpenApi.annotations({ transform: (operation) => ({ ...operation, tags: ["experimental"] }) })

/** OpenCode as an Agent2Agent protocol agent for one Location. Lives in the `server.experimental` group. */
export const A2AEndpoints = [
  HttpApiEndpoint.get("a2a.card", A2A_CARD_PATH, {
    query: LocationQuery,
    headers: Schema.Struct({ "a2a-version": Schema.optional(Schema.String) }),
    success: A2A.Card,
    error: [ForbiddenError, LocationNotFoundError],
  })
    .annotateMerge(locationQueryOpenApi)
    .annotateMerge(tags)
    .annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.a2a.card",
        summary: "Get A2A Agent Card",
        description: `The Agent Card for this Location. Sends the A2A 1.0 card when A2A-Version names 1.x, and the 0.3 card otherwise. Its JSON-RPC URL keeps the Location query. ${EXPERIMENTAL}`,
      }),
    ),
  // The body is read in a raw handler so malformed requests get JSON-RPC errors and streaming methods can answer
  // with server-sent events.
  HttpApiEndpoint.post("a2a.rpc", A2A_PATH, {
    query: LocationQuery,
    payload: A2A.RpcRequest,
    success: Schema.Unknown,
  })
    .annotateMerge(locationQueryOpenApi)
    .annotateMerge(tags)
    .annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.a2a.rpc",
        summary: "A2A JSON-RPC",
        description: `A2A JSON-RPC 2.0 endpoint. Accepts 1.0 (SendMessage, SendStreamingMessage, GetTask, CancelTask, SubscribeToTask) and 0.3 (message/send, message/stream, tasks/get, tasks/cancel, tasks/resubscribe) methods and answers in the dialect of the method. A context is a Session and a task is one prompt. ${EXPERIMENTAL}`,
      }),
    ),
] as const
