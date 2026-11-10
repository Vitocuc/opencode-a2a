import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { A2A } from "@opencode/schema/a2a"
import { A2ACodec } from "../src/a2a/codec"

const decodeResult = (value: unknown) => A2ACodec.normalizeResult(Schema.decodeUnknownSync(A2A.WireResult)(value))

describe("A2ACodec", () => {
  test("reads messages and parts in either dialect", () => {
    const decode = (value: unknown) => A2ACodec.normalizeMessage(Schema.decodeUnknownSync(A2A.WireMessage)(value))
    expect(
      decode({
        kind: "message",
        messageId: "m",
        role: "user",
        parts: [
          { kind: "text", text: "hi" },
          { kind: "data", data: { a: 1 } },
          { kind: "file", file: { uri: "https://x/y.png", mimeType: "image/png", name: "y.png" } },
        ],
      }),
    ).toEqual({
      messageId: "m",
      role: "user",
      parts: [
        { type: "text", text: "hi" },
        { type: "data", data: { a: 1 } },
        { type: "file", uri: "https://x/y.png", mime: "image/png", name: "y.png", bytes: undefined },
      ],
      contextId: undefined,
      taskId: undefined,
      metadata: undefined,
    })
    expect(
      decode({
        messageId: "m",
        role: "ROLE_AGENT",
        parts: [{ text: "hi" }, { raw: "aGk=", filename: "a.txt", mediaType: "text/plain" }],
      }).parts,
    ).toEqual([
      { type: "text", text: "hi" },
      { type: "file", bytes: "aGk=", name: "a.txt", mime: "text/plain", uri: undefined },
    ])
  })

  test("reads send results and stream events in either dialect", () => {
    expect(
      decodeResult({ task: { id: "t", contextId: "c", status: { state: "TASK_STATE_CANCELLED" } } }),
    ).toMatchObject({
      type: "task",
      task: { id: "t", status: { state: "canceled" } },
    })
    expect(decodeResult({ kind: "task", id: "t", contextId: "c", status: { state: "input-required" } })).toMatchObject({
      type: "task",
      task: { status: { state: "input-required" } },
    })
    expect(
      decodeResult({ statusUpdate: { taskId: "t", contextId: "c", status: { state: "TASK_STATE_WORKING" } } }),
    ).toMatchObject({ type: "status", status: { state: "working" } })
    expect(
      decodeResult({
        kind: "artifact-update",
        taskId: "t",
        contextId: "c",
        artifact: { artifactId: "a", parts: [{ kind: "text", text: "x" }] },
        append: true,
      }),
    ).toMatchObject({ type: "artifact", append: true, artifact: { parts: [{ type: "text", text: "x" }] } })
  })

  test("writes each dialect", () => {
    const status = { type: "status", taskId: "t", contextId: "c", status: { state: "completed" } } as const
    expect<unknown>(A2ACodec.encodeEvent("0.3", status)).toEqual({
      kind: "status-update",
      taskId: "t",
      contextId: "c",
      status: { state: "completed" },
      final: true,
    })
    expect<unknown>(A2ACodec.encodeEvent("1.0", status)).toEqual({
      statusUpdate: { taskId: "t", contextId: "c", status: { state: "TASK_STATE_COMPLETED" } },
    })
    const message = { messageId: "m", role: "agent", parts: [{ type: "data", data: { a: 1 } }] } as const
    expect<unknown>(A2ACodec.encodeMessage("1.0", message)).toEqual({
      messageId: "m",
      role: "ROLE_AGENT",
      parts: [{ data: { a: 1 }, mediaType: "application/json" }],
    })
  })

  test("adds an ErrorInfo to 1.0 A2A errors only", () => {
    const error = { code: A2ACodec.errors.taskNotFound, message: "Task not found" }
    expect<unknown>(A2ACodec.encodeError("1.0", error)).toEqual({
      ...error,
      data: [
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "TASK_NOT_FOUND", domain: "a2a-protocol.org" },
      ],
    })
    expect<unknown>(A2ACodec.encodeError("0.3", error)).toEqual(error)
    expect<unknown>(A2ACodec.encodeError("1.0", { code: A2ACodec.errors.invalidParams, message: "bad" })).toEqual({
      code: A2ACodec.errors.invalidParams,
      message: "bad",
    })
  })

  test("picks the dialect from the method and the remote card", () => {
    expect(A2ACodec.method("message/stream")).toEqual({ method: "stream", version: "0.3" })
    expect(A2ACodec.method("CancelTask")).toEqual({ method: "cancel", version: "1.0" })
    expect(A2ACodec.method("tasks/list")).toBeUndefined()
    expect(A2ACodec.method("ListTasks")).toEqual({ method: "list", version: "1.0" })
    expect(A2ACodec.method("")).toBeUndefined()
    expect([undefined, "", "0.3", "1.0", "1.0.2", "2.0", "0.2"].map(A2ACodec.requestedVersion)).toEqual([
      "0.3",
      "0.3",
      "0.3",
      "1.0",
      "1.0",
      undefined,
      undefined,
    ])
    expect(A2ACodec.endpoint({ name: "a", url: "https://a/rpc" })).toEqual({ url: "https://a/rpc", version: "0.3" })
    expect(
      A2ACodec.endpoint({
        name: "a",
        supportedInterfaces: [
          { url: "https://a/grpc", protocolBinding: "GRPC", protocolVersion: "1.0" },
          { url: "https://a/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        ],
      }),
    ).toEqual({ url: "https://a/rpc", version: "1.0" })
  })
})
