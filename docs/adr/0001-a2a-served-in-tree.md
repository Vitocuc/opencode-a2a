# A2A is served inside the opencode server, unlike ACP

OpenCode serves A2A from routes inside its own server (under `/api/experimental/a2a`, behind the `a2a` flag), with one Agent Card per Location. It does not use a separate `opencode a2a` adapter process, even though `opencode acp` is built that way. ACP serves one interactive editor that starts its own process. A2A is called by autonomous client agents (ADK and `a2a-sdk` orchestrators, other opencode servers, independent agents on the same machine) that expect opencode to already be reachable. Serving it in-tree means there is no extra program to start, it reuses the server's password and Locations, and it stays within upstream's rule that new endpoints start experimental.

## Considered Options

- **An `opencode a2a` CLI adapter** that serves A2A and calls the server through `@opencode/client`. It is feasible at medium effort, but it needs its own listener, SSE stream and auth, and someone has to start it.
- **A plugin, a sidecar outside the repo, or an A2A-to-MCP bridge.** Ruled out for weaker adoption.

## Consequences

Revisit the adapter only if upstream maintainers would accept A2A only as an adapter, or if one A2A endpoint is needed in front of several opencode servers (a gateway).
