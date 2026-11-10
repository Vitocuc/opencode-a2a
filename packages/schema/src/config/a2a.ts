export * as ConfigA2A from "./a2a.js"

import { Schema } from "effect"
import { optional, PositiveInt } from "../schema.js"

export class Agent extends Schema.Class<Agent>("ConfigA2A.Agent")({
  url: Schema.String.annotate({
    description:
      "The remote agent's Agent Card URL, or its base URL, where the card is read from /.well-known/agent-card.json",
  }),
  description: Schema.String.pipe(optional).annotate({
    description: "What the agent is for, shown to the model. Defaults to the description on its Agent Card",
  }),
  headers: Schema.Record(Schema.String, Schema.String).pipe(optional).annotate({
    description: "Headers sent with every request to the agent, such as Authorization",
  }),
  enabled: Schema.Boolean.pipe(optional).annotate({ description: "Set to false to hide the agent (default: true)" }),
  timeout: PositiveInt.pipe(optional).annotate({
    description: "Seconds to wait for the agent to finish a task (default: 600)",
  }),
}) {}

export class Info extends Schema.Class<Info>("Config.A2A")({
  agents: Schema.Record(Schema.String, Agent).pipe(optional).annotate({
    description: "Remote A2A agents the a2a tool can send tasks to, by name",
  }),
}) {}
