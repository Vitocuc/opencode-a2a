# V2 A2A

Status: **Current semantic overview, experimental.** Behind the `a2a` flag. The routes live under `/api/experimental/a2a` and may change without notice.

This document describes how OpenCode speaks the [Agent2Agent (A2A) protocol](https://a2a-protocol.org), one connection at a time: who opens it, what is sent, what comes back, and which OpenCode element sits behind each A2A field. It does not repeat the A2A specification. It only states the choices OpenCode makes on top of it.

## Roles

OpenCode plays both A2A roles. They are independent: either works without the other.

| Role             | What OpenCode does                                                                        | Code                                          |
| ---------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Remote agent** | Serves an Agent Card and a JSON-RPC endpoint, so any A2A client can send it tasks.        | `packages/server/src/handlers/a2a.ts`         |
| **Client agent** | Gives the model an `a2a` tool that sends tasks to the remote agents listed in the config. | `packages/core/src/tool/plugin/a2a.ts`        |
| Shared           | Translates between the 0.3 and 1.0 wire dialects and one internal shape.                  | `packages/core/src/a2a/codec.ts`              |
| Shared           | Wire types for both dialects, and the config for remote agents.                           | `packages/schema/src/a2a.ts`, `config/a2a.ts` |

## How OpenCode elements map to A2A

| OpenCode element                                               | A2A element                                    |
| -------------------------------------------------------------- | ---------------------------------------------- |
| One **Location** (a project directory on an OpenCode server)   | One remote agent, with its own Agent Card      |
| The Location's main **agents** (not subagents, not hidden)     | The card's skills                              |
| A **Session**                                                  | A context. `contextId` is the Session ID.      |
| One **prompt** in that Session                                 | A task. `taskId` is `<sessionID>:<messageID>`. |
| The prompt's reply, up to the end of its turn                  | The task's artifact `response`                 |
| A pending **permission prompt** or **question** in the Session | The task state `input-required`                |
| The server password                                            | The card's HTTP Basic security scheme          |
| An entry under `a2a.agents` in the config                      | A remote agent the client role can call        |

Tasks have no table of their own. A task is read back from Session history every time it is asked for. That is why its ID carries both the Session ID and the prompt's message ID.

## The connections

```text
  you ──(TUI, not A2A)──▶ your OpenCode ──(C3, C4)──▶ remote A2A agent
                                                     (any A2A server, or another OpenCode)

  any A2A client ──(C1, C2)──▶ OpenCode as remote agent
```

| #   | From → to                    | Request                                  | Purpose                              |
| --- | ---------------------------- | ---------------------------------------- | ------------------------------------ |
| C1  | A2A client → OpenCode        | `GET /api/experimental/a2a/card`         | Read the Agent Card of one Location  |
| C2  | A2A client → OpenCode        | `POST /api/experimental/a2a` (JSON-RPC)  | Send, follow, read and cancel tasks  |
| C3  | OpenCode `a2a` tool → remote | `GET` the remote's card URL              | Find the remote's JSON-RPC endpoint  |
| C4  | OpenCode `a2a` tool → remote | `POST` JSON-RPC `SendMessage`, `GetTask` | Delegate one task and get its answer |

The connection from your terminal to your own OpenCode server is the normal OpenCode API, not A2A.

The sections below each have an animated diagram that follows the code. Columns are components and name their source file. A pill is a message or event, and the arrow it leaves keeps its name. A dashed box is a step inside one component. A shaded bar is a request still open, or the handler waiting on Bus events. The arrows to the Session runtime and the Bus never leave OpenCode: they show what makes the server answer.

## Rules for every request to OpenCode (C1 and C2)

### Turning it on

The `a2a` flag must be on for the Location: `experimental.a2a: true` in its config, or `OPENCODE_FLAGS=a2a`. Flags are on in local and dev builds and off in releases. With the flag off:

- C1 answers HTTP 403.
- C2 answers JSON-RPC error `-32004` "A2A is disabled for this location".

### Which Location

Both routes pick the Location as every Location-scoped route does: the `location[directory]` query parameter, else the `x-opencode-directory` header, else the server's working directory. The card's endpoint URL always carries the query, so a client that follows the card reaches the same Location.

### Authentication

A2A requests go through the same server authorization as the rest of the API. When the server has a password, every request needs HTTP Basic credentials with user `opencode` and that password, or a pairing session token. The card says so: it declares a `basic` HTTP security scheme only when a password is set.

### Versions and dialects

OpenCode speaks A2A **1.0** and **0.3**, both over JSON-RPC 2.0.

- The client names a version with the `A2A-Version` header, or the `A2A-Version` query parameter.
  - `1.0` (or `1.0.x`) means 1.0.
  - A missing or empty value means 0.3, as the 1.0 specification requires.
  - Any other version gets error `-32009` VersionNotSupported.
- For JSON-RPC, **the method name decides the dialect** of the answer. A 1.0 method such as `SendMessage` is answered in 1.0 even without the header.
- For the card, the header decides. A version OpenCode does not speak gets the 1.0 card.

| Operation       | 1.0 method             | 0.3 method          |
| --------------- | ---------------------- | ------------------- |
| Send a message  | `SendMessage`          | `message/send`      |
| Send and stream | `SendStreamingMessage` | `message/stream`    |
| Read a task     | `GetTask`              | `tasks/get`         |
| List tasks      | `ListTasks`            | (none in 0.3)       |
| Cancel a task   | `CancelTask`           | `tasks/cancel`      |
| Follow a task   | `SubscribeToTask`      | `tasks/resubscribe` |

The dialects differ only in encoding. The codec turns both into one internal shape on the way in, and back into the caller's dialect on the way out:

| Field             | 0.3                              | 1.0                          |
| ----------------- | -------------------------------- | ---------------------------- |
| Type of a value   | `kind: "task"`, `"message"`      | wrapper key: `{ "task": … }` |
| Task state        | `completed`                      | `TASK_STATE_COMPLETED`       |
| Message role      | `user`, `agent`                  | `ROLE_USER`, `ROLE_AGENT`    |
| Text part         | `{ kind: "text", text }`         | `{ text }`                   |
| Last stream event | status update with `final: true` | the stream simply ends       |

The examples below use 1.0.

## C1: Agent Card

```http
GET /api/experimental/a2a/card?location[directory]=/srv/fpga
A2A-Version: 1.0
Authorization: Basic …
```

```json
{
  "name": "OpenCode (fpga)",
  "description": "OpenCode coding agent working in /srv/fpga. Each context is an OpenCode session; pick a skill's agent with message metadata { \"agent\": \"<skill id>\" }.",
  "version": "<server version>",
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain"],
  "skills": [{ "id": "build", "name": "build", "description": "…", "tags": ["opencode"] }],
  "supportedInterfaces": [
    {
      "url": "https://host/api/experimental/a2a?location%5Bdirectory%5D=%2Fsrv%2Ffpga",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "1.0"
    }
  ],
  "capabilities": { "streaming": true, "pushNotifications": false },
  "securitySchemes": { "basic": { "httpAuthSecurityScheme": { "scheme": "basic" } } },
  "securityRequirements": [{ "schemes": { "basic": { "list": [] } } }]
}
```

- **Name and description** come from the Location's directory.
- **Skills** are the Location's agents, without subagents and hidden agents. A skill's `id` is the agent ID.
- **The endpoint URL** is built from the host the caller reached. Behind a proxy, `X-Forwarded-Host` and `X-Forwarded-Proto` win.
- **The 0.3 card** has `protocolVersion: "0.3.0"`, `url` and `preferredTransport: "JSONRPC"`. It also lists both interfaces in `supportedInterfaces`, so a 1.x SDK that fetched it without the header still picks 1.0.
- **Caching:** the answer has an `ETag`, `Cache-Control: private, max-age=300` and `Vary: A2A-Version, Authorization`. A matching `If-None-Match` gets 304. A card with no skills gets `Cache-Control: no-store` instead: on a Location whose agents haven't loaded yet, the list is empty for now, and a client mustn't keep it. The server doesn't wait for the agents to load.

![Animated sequence: the client gets the card, OpenCode checks auth and the flag, lists agents as skills, and answers; a second request with If-None-Match gets 304](./a2a/card.svg)

**There is no well-known card.** `/.well-known/agent-card.json` answers 404, because one server holds many Locations and the card is per Location. A client must be given the card URL above. (The CLI sends `/.well-known/*` to the API, so that 404 is a real 404 and not the web app's page.)

## C2: JSON-RPC

```http
POST /api/experimental/a2a?location[directory]=/srv/fpga
Content-Type: application/json
A2A-Version: 1.0
Authorization: Basic …
```

Every answer is a JSON-RPC 2.0 response with the request's `id`, or, for the streaming methods, a `text/event-stream` of such responses.

### What a task is

A task is **one prompt in one Session**. Its state is read from the Session history that follows the prompt:

| What the history shows                                         | Task state       |
| -------------------------------------------------------------- | ---------------- |
| The prompt still waits in the Session's inbox                  | `submitted`      |
| The prompt was delivered, and its turn has not ended           | `working`        |
| Same, and the Session waits on a permission prompt or question | `input-required` |
| The turn ended with the Session going idle after success       | `completed`      |
| The turn ended with the Session going idle after a failure     | `failed`         |
| The turn ended with the Session going idle after an interrupt  | `canceled`       |
| The next prompt was delivered before any idle point            | `completed`      |

The last row exists because queued prompts are delivered one after the other in the same run, with no idle point in between.

![Animated sequence: two non-blocking sends to one context; B waits in the inbox, A completes when B is delivered, and B completes when the Session goes idle](./a2a/queued.svg)

A task carries:

| Field              | Value                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `id`               | `<sessionID>:<messageID>`                                                                                       |
| `contextId`        | The Session ID                                                                                                  |
| `status.timestamp` | When the turn ended, or when the prompt was sent while it still runs                                            |
| `status.message`   | Only for `failed` and `canceled`: the reply or the error. For `input-required`: the question (see below).       |
| `artifacts`        | One artifact, ID `<taskId>:response`, name `response`: the text of the turn's last assistant message with text. |
| `history`          | The prompt, then the reply. `historyLength` keeps the last N; `0` leaves it out.                                |

A completed task's answer is only in the artifact. It is not repeated in `status.message`.

OpenCode never reports `rejected` or `auth-required`.

### SendMessage or SendStreamingMessage

Both methods admit the message the same way and start the same task. They differ in how the result comes back.

|                    | `SendMessage`                                              | `SendStreamingMessage`                                         |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------------------------- |
| 0.3 method name    | `message/send`                                             | `message/stream`                                               |
| HTTP response      | One JSON-RPC response                                      | A `text/event-stream` of JSON-RPC responses with the same `id` |
| What comes back    | The task once, when it is terminal or `input-required`     | The task first, then artifact chunks and a status update       |
| Partial text       | No, the answer arrives whole                               | Yes, one chunk per finished stretch of text                    |
| Answer text        | The last assistant message's text                          | Every stretch while it runs, then the last message's text      |
| Return before done | `returnImmediately: true` (1.0) or `blocking: false` (0.3) | Not needed: the stream reports progress as it goes             |

A blocking `SendMessage` also waits for the end; it is silent until then. Streaming suits a client that shows progress, such as a chat UI. Either way, a task that needs input ends the call, and the client answers it with a new message on the same `taskId`. `SubscribeToTask` is the stream without a new message: it follows a task that already runs.

### SendMessage: a new task

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "b91e…",
      "role": "ROLE_USER",
      "parts": [{ "text": "List the .bit files in your project directory" }],
      "metadata": { "agent": "build" }
    }
  }
}
```

What OpenCode does:

1. **Checks the role.** `message.role` must be user, or the request fails with `-32602`.
2. **Finds the Session:**
   - no `contextId`: creates a new Session, marked as an A2A context, and leaves it untitled so it gets named from the conversation;
   - with a `contextId`: uses that Session, and marks it as an A2A context if it wasn't. An unknown ID fails with `-32602` "Unknown contextId".
3. **Picks the agent.** `message.metadata.agent` chooses one of the card's skills, at creation or by switching the agent of an existing Session.
4. **Turns the parts into a prompt:**
   - text parts become the prompt text;
   - data parts become fenced JSON blocks in the text;
   - files with bytes become attachments;
   - files with a URL are named in the text.
5. **Queues the prompt in the Session's inbox.** A task sent while another runs in the same context waits its turn, so each task gets its own answer.
6. **Answers:**
   - by default it waits until the task is terminal or `input-required`, then sends the task;
   - `configuration.returnImmediately: true` (1.0) or `blocking: false` (0.3) sends it straight away, usually as `submitted` or `working`.

The wait is driven by Session events, not by polling. OpenCode re-reads the task whenever the Session finishes a run, delivers its next prompt, or asks a permission or question.

![Animated sequence: SendMessage creates a Session, queues the prompt, subscribes to Bus progress events, re-reads the task on each event, and answers once it is completed](./a2a/send-blocking.svg)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "task": {
      "id": "ses_9Lq2…:msg_3Hd8…",
      "contextId": "ses_9Lq2…",
      "status": { "state": "TASK_STATE_COMPLETED", "timestamp": "2026-11-13T10:02:11.000Z" },
      "artifacts": [
        {
          "artifactId": "ses_9Lq2…:msg_3Hd8…:response",
          "name": "response",
          "parts": [{ "text": "Found 2: top.bit, test.bit" }]
        }
      ],
      "history": [
        {
          "messageId": "msg_3Hd8…",
          "role": "ROLE_USER",
          "parts": [{ "text": "List the .bit files…" }],
          "contextId": "ses_9Lq2…",
          "taskId": "ses_9Lq2…:msg_3Hd8…"
        },
        {
          "messageId": "ses_9Lq2…:msg_3Hd8…:reply",
          "role": "ROLE_AGENT",
          "parts": [{ "text": "Found 2: top.bit, test.bit" }],
          "contextId": "ses_9Lq2…",
          "taskId": "ses_9Lq2…:msg_3Hd8…"
        }
      ]
    }
  }
}
```

**Continuing a context:** send the next message with the same `contextId` and no `taskId`. It becomes a new task in the same Session, and the model sees the earlier conversation.

### SendMessage: answering a task that needs input

When the remote OpenCode needs a decision, for example a shell permission with nobody at its terminal, the task reports `input-required` with the question as text:

```json
"status": {
  "state": "TASK_STATE_INPUT_REQUIRED",
  "message": {
    "messageId": "ses_9Lq2…:msg_7Xc1…:input",
    "role": "ROLE_AGENT",
    "parts": [{ "text": "opencode needs permission to use shell on echo hi. Reply \"allow\", \"always\" or \"deny\"." }]
  }
}
```

The client answers with a message that names the task:

```json
{
  "message": { "messageId": "…", "role": "ROLE_USER", "taskId": "ses_9Lq2…:msg_7Xc1…", "parts": [{ "text": "allow" }] }
}
```

| The Session waits on           | Accepted answer                                            | What OpenCode does                   |
| ------------------------------ | ---------------------------------------------------------- | ------------------------------------ |
| A permission prompt            | `allow`, `always` or `deny`, as text or a string data part | Replies `once`, `always` or `reject` |
| A question with one field      | The answer as text (a list of one for multi-select)        | Fills the field and submits the form |
| A question with several fields | A data part keyed by field                                 | Submits the form with those values   |

Then the same task continues under the same ID, and the answer works like any other send: blocking by default.

![Animated sequence: a permission.asked event makes the task input-required; the client answers allow on the same taskId, OpenCode replies once to the permission, and the task completes](./a2a/input-required.svg)

A message with a `taskId` fails when:

| Case                                               | Error                                       |
| -------------------------------------------------- | ------------------------------------------- |
| The task ID is malformed or unknown                | `-32001` TaskNotFound                       |
| `contextId` is given and is not the task's Session | `-32602` InvalidParams                      |
| The task is terminal                               | `-32004` UnsupportedOperation               |
| The task is not waiting for input                  | `-32602` InvalidParams                      |
| The answer doesn't fit the question                | `-32602` InvalidParams, saying what to send |

### SendStreamingMessage and SubscribeToTask

`SendStreamingMessage` admits the message exactly like `SendMessage`, then answers with server-sent events. `SubscribeToTask` (params `{ "id": "<taskId>" }`) sends the same events for a task that already exists. A terminal task can't be followed: `-32004`.

The events, one JSON-RPC response per `data:` line:

```text
data: {"jsonrpc":"2.0","id":2,"result":{"task":{"id":"…","contextId":"…","status":{"state":"TASK_STATE_WORKING"},"artifacts":[],…}}}

data: {"jsonrpc":"2.0","id":2,"result":{"artifactUpdate":{"taskId":"…","artifact":{"artifactId":"…:response","name":"response","parts":[{"text":"Let me look at the project directory."}]},"append":false}}}

data: {"jsonrpc":"2.0","id":2,"result":{"artifactUpdate":{"taskId":"…","artifact":{…,"parts":[{"text":"Found 2: top.bit, test.bit"}]},"append":true}}}

data: {"jsonrpc":"2.0","id":2,"result":{"artifactUpdate":{"taskId":"…","artifact":{…,"parts":[{"text":"Found 2: top.bit, test.bit"}]},"append":false,"lastChunk":true}}}

data: {"jsonrpc":"2.0","id":2,"result":{"statusUpdate":{"taskId":"…","status":{"state":"TASK_STATE_COMPLETED",…}}}}
```

1. **The task** comes first, as `working`, with no artifacts.
2. **One artifact chunk** follows for each finished stretch of assistant text. The first has `append: false`, the rest `append: true`.
3. **A closing chunk** ends the artifact with `lastChunk: true` and `append: false`: it **replaces** the streamed chunks with the task's answer, the last assistant message's text. A stretch is only known to be the last one afterwards, so this extra chunk is needed.
4. **The status update** comes last, and the stream ends.

![Animated sequence: SendStreamingMessage subscribes to session.text.ended and progress events, sends the task, one artifact chunk per finished stretch of text, a closing lastChunk that replaces them with the answer, and the status update](./a2a/streaming.svg)

Some cases change the sequence:

- **The task finished before the stream started:** the whole answer goes out as one chunk with `lastChunk: true`, then the status.
- **The task needs input:** the stream ends with the `input-required` status update, without a closing chunk. Answer with a `SendMessage` on the task, then follow it again with `SubscribeToTask`.
- **Keep-alive:** a `: heartbeat` comment line is sent every 15 seconds.
- **A failure in the stream** sends one JSON-RPC error event (`-32603`).

While the task runs, the chunks show all the text the turn writes, including text written before tool calls. The closing chunk then leaves the artifact equal to the `response` artifact that `GetTask` returns. A client that appends every chunk and ignores `append: false` would show the answer twice; the a2a-sdk replaces the artifact, as the specification asks.

A client that lost its stream reads the task with `GetTask`, then follows it again with `SubscribeToTask`. Chunks sent before it reconnected are not sent again.

![Animated sequence: GetTask returns the working task, SubscribeToTask follows it again, and only text written after the reconnect arrives as chunks](./a2a/reconnect.svg)

### GetTask

Params `{ "id": "<taskId>", "historyLength": 1 }`. Answers the task itself, not wrapped in `{ "task": … }`. An unknown ID gets `-32001`.

### ListTasks (1.0 only)

Lists the tasks of the Location's A2A contexts: Sessions created or continued over A2A, and only the prompts that came in over A2A. Prompts still waiting in an inbox are not listed until they are delivered.

| Param                  | Meaning                                     |
| ---------------------- | ------------------------------------------- |
| `contextId`            | Only this Session                           |
| `status`               | Only this state                             |
| `statusTimestampAfter` | Only tasks whose status is newer (ISO date) |
| `pageSize`             | 1 to 100, default 50                        |
| `pageToken`            | The previous page's `nextPageToken`         |
| `historyLength`        | As for `GetTask`                            |
| `includeArtifacts`     | Include the answers (off by default)        |

The newest status comes first. The answer is `{ tasks, nextPageToken, pageSize, totalSize }`, and `nextPageToken` is `""` on the last page.

### CancelTask

Params `{ "id": "<taskId>" }`.

| The task is | What happens                                                          |
| ----------- | --------------------------------------------------------------------- |
| Terminal    | `-32002` TaskNotCancelable                                            |
| `submitted` | The prompt is removed from the inbox, then the Session is interrupted |
| Running     | The Session is interrupted                                            |

OpenCode then waits up to 10 seconds for the task to settle and answers with it, normally as `canceled`.

Interrupting stops the Session's current run, whichever task it belongs to.

![Animated sequence: CancelTask reads the task, interrupts the Session, waits on Bus events for session.execution.interrupted, and answers the task as canceled](./a2a/cancel.svg)

### Not supported

| Request                                                      | Answer                                    |
| ------------------------------------------------------------ | ----------------------------------------- |
| Push notification config methods (both dialects)             | `-32003` PushNotificationNotSupported     |
| `GetExtendedAgentCard`, `agent/getAuthenticatedExtendedCard` | `-32004` UnsupportedOperation             |
| Any other unknown method                                     | `-32601` MethodNotFound                   |
| The gRPC and HTTP+JSON bindings                              | Not offered: the card lists JSON-RPC only |

### Errors

| Code     | Name                         | When                                                               |
| -------- | ---------------------------- | ------------------------------------------------------------------ |
| `-32700` | Parse error                  | The body is not JSON                                               |
| `-32600` | Invalid request              | The body is not a JSON-RPC 2.0 request                             |
| `-32601` | Method not found             | Unknown method                                                     |
| `-32602` | Invalid params               | Bad params, wrong role, unknown `contextId`, wrong answer to input |
| `-32603` | Internal error               | Anything unexpected                                                |
| `-32001` | TaskNotFound                 | The task ID is malformed or unknown                                |
| `-32002` | TaskNotCancelable            | Cancel on a terminal task                                          |
| `-32003` | PushNotificationNotSupported | Push config methods                                                |
| `-32004` | UnsupportedOperation         | Flag off, message or subscribe on a terminal task, extended card   |
| `-32009` | VersionNotSupported          | An `A2A-Version` other than 0.3 or 1.0                             |

In 1.0, the A2A-specific codes (`-32001` to `-32009`) also carry a `google.rpc.ErrorInfo` in `error.data`, with `reason` such as `TASK_NOT_FOUND` and `domain: "a2a-protocol.org"`.

## The client role (C3 and C4)

### Config

```json
{
  "experimental": { "a2a": true },
  "a2a": {
    "agents": {
      "python": { "url": "http://127.0.0.1:48810" },
      "fpga": {
        "url": "https://fpga-box:4096/api/experimental/a2a/card?location[directory]=/srv/fpga",
        "headers": { "Authorization": "Basic …" },
        "description": "Builds and tests bitstreams on the FPGA box",
        "timeout": 1800
      }
    }
  }
}
```

| Field         | Meaning                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| `url`         | The card URL, or a base URL where the card is read from `/.well-known/agent-card.json` |
| `headers`     | Sent with every request to this agent, for example `Authorization`                     |
| `description` | Shown to the model. The card's own text never is                                       |
| `enabled`     | `false` hides the agent                                                                |
| `timeout`     | Seconds to wait for a task to settle, default 600                                      |

The model gets the `a2a` tool only when the flag is on and at least one agent is enabled, and the `a2a_add` tool whenever the flag is on. Each config entry is read on its own, so one broken entry doesn't hide the others. A config change reloads the tool.

### The tool

| Input       | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `agent`     | A name from `a2a.agents`                                                      |
| `message`   | The task, written to stand on its own: the remote can't see this conversation |
| `contextId` | Optional: continue an earlier remote conversation                             |
| `taskId`    | Optional: answer a remote task that is `input-required`                       |

Every call goes through a permission check, with action `a2a` and the agent's name as the resource. The default agent rules allow it; a rule such as `{ "action": "a2a", "resource": "*", "effect": "ask" }` makes it ask. Answering "always" then saves an allow rule for `a2a` on every agent in this project.

### Adding remote agents

Agents get into `a2a.agents` in the **global** config in three ways. Secrets are only ever written as `{env:VAR}` references.

| Way                      | Who chooses                               | What it does                                                                                                                                                                       |
| ------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit the config          | You                                       | As above                                                                                                                                                                           |
| `opencode a2a add <url>` | You                                       | Reads the card (C3), shows its name, endpoint and skills, asks, and writes the agent. `--header Authorization=ENV_VAR` writes `Bearer {env:ENV_VAR}`; `--name`, `--force`, `--yes` |
| The `a2a_add` tool       | The model proposes, you approve or reject | Reads the card (C3), asks permission, writes the agent, and waits for the config to reload so the `a2a` tool lists it in the model's next step                                     |

The `a2a_add` tool takes the card URL (`url`) and an optional `name`; the default name is made from the card's name. It fails, writing nothing, when the name is taken, the card can't be read, or the card has no JSON-RPC interface.

- **Permission:** action `a2a_add`, the card URL as the resource, and the agent's name, card name, endpoint and skills as metadata, which the TUI shows. The default agent rules **ask** for it even where everything else is allowed, and it offers no "always": each agent is approved on its own. A config rule can still override it.
- **Authentication:** when the card declares `securitySchemes`, the agent is written with `Authorization: Bearer {env:A2A_<NAME>_TOKEN}`, and the model is told to ask you to set that variable.
- **Writing:** through `PATCH /api/experimental/config` with `{ "a2a": { "agents": { "<name>": { … } } } }`. A patch sets only the agents it names and leaves the rest of the file, comments included, as it was.
- **Card text** comes from a third party. It is shown to you in the permission prompt, never written into the agent's `description`, and never put in the `a2a` tool's description.

#### Finding agents

OpenCode doesn't search for agents itself. The model finds them through MCP servers in the config, and passes a result's `wellKnownURI` to `a2a_add`.

- **Public agents:** the [A2A Registry](https://www.a2aregistry.org)'s hosted MCP server, `https://a2aregistry.org/mcp/`, with `search_agents`, `list_agents`, `get_agent` and more.
- **Internal agents** stay inside the company with `packages/a2a-registry-mcp`: an MCP server that reads a file of card URLs and exposes the same tools and result fields, over stdio or HTTP. It contacts only the URLs in its file. See its README.

```json
{
  "mcp": {
    "servers": {
      "a2a-registry": { "type": "remote", "url": "https://a2aregistry.org/mcp/" },
      "company-agents": {
        "type": "local",
        "command": ["bun", "/path/to/a2a-registry-mcp/src/main.ts", "/path/to/agents.json"]
      }
    }
  }
}
```

### C3: Reading the remote card

On the first call to an agent, OpenCode reads its card and keeps it for that URL until the process ends.

```http
GET http://127.0.0.1:48810/.well-known/agent-card.json
A2A-Version: 1.0
Accept: application/json
```

- **The card URL:** a URL with a path is used as it is. A bare host gets `/.well-known/agent-card.json` added.
- **The headers:** `A2A-Version: 1.0` is always sent, because without it a server may send a 0.3-only card. The configured headers are added and can override it.
- **The endpoint and dialect:** among the card's JSON-RPC interfaces OpenCode prefers a 1.x one, else takes the first. A 0.3 card without `supportedInterfaces` uses its `url` with 0.3. A card without any JSON-RPC interface fails the call.

### C4: Sending the task

```json
{
  "jsonrpc": "2.0",
  "id": "7f3c…",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "b91e…",
      "role": "ROLE_USER",
      "parts": [{ "text": "Say hello" }],
      "contextId": "…",
      "taskId": "…"
    },
    "configuration": { "returnImmediately": false }
  }
}
```

- **Why not streaming:** the model gets one result per tool call, so streamed chunks would not reach it any sooner. Polling also covers remote servers that answer before the task ends despite the blocking flag.
- **The request:** one text part, with `contextId` and `taskId` only when the model passed them. A 0.3 remote gets `message/send` with `blocking: true` and no `A2A-Version` header.
- **The result:**
  - a message counts as a completed answer;
  - a task that is terminal or `input-required` is the answer;
  - any other task is polled with `GetTask` every 2 seconds until it is.
- **The timeout** stops the wait with "did not finish in time". The remote task is not cancelled.
- **Failures:**
  - a JSON-RPC error becomes a tool error: `<agent name>: <message> (<code>)`;
  - a non-2xx HTTP status fails the call;
  - a response over 5 MB fails the call.

![Animated sequence: the model calls the a2a tool, which checks config and permission, discovers the remote card once, sends a blocking SendMessage, polls GetTask every 2 seconds, and returns a summary to the model](./a2a/client-role.svg)

### What the model sees

```text
python (completed; contextId: e81f…, taskId: 4c2a…)

Hello from Python (turn 1)
```

That is the agent name, the task state, the remote IDs, and the text. The text comes from the task's artifacts, or, when it has none, from its status message: the question of an `input-required` task, or the reason for a failure. A reply message gives its own text. With these IDs the model can continue the remote conversation (`contextId`) or answer its question (`taskId`, when the state is `input-required`).

The client role does not stream, cancel, or list remote tasks.

## End to end: OpenCode calling OpenCode

```text
you            your OpenCode (client)                remote OpenCode (server, Location /srv/fpga)
 │  prompt  ──▶ │
 │              │ model calls a2a { agent: "fpga" }
 │ ◀── permission a2a → fpga ──┤
 │  allow   ──▶ │
 │              │ C3  GET card (first call only)  ──▶ │ card for /srv/fpga
 │              │ C4  SendMessage                  ──▶ │ new Session, prompt queued, run starts
 │              │                                      │ … shell permission asked
 │              │ ◀── task input-required + question ──┤
 │ ◀── model relays the question ──┤
 │  "allow" ──▶ │
 │              │ C4  SendMessage { taskId, "allow" } ──▶ │ permission replied once, run continues
 │              │ ◀── task completed + response artifact ─┤
 │ ◀── answer ──┤
```

Whether the model asks you before answering a remote question is up to the model. Nothing in the tool forces it.
