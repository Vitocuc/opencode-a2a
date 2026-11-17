# a2a-registry-mcp

An MCP server that lists a company's internal A2A agents from a file, so they can be found without being listed anywhere public.

It exposes the same tools as the public [A2A Registry](https://www.a2aregistry.org)'s MCP server, so a model searches both the same way. Each result's `wellKnownURI` is the Agent Card URL to add the agent to OpenCode (`opencode a2a add <url>`).

## The agents file

```json
{
  "agents": [
    { "url": "https://agents.internal/translator", "category": "docs" },
    {
      "url": "https://agents.internal/builds/card.json",
      "headers": { "Authorization": "Bearer {env:BUILDS_AGENT_TOKEN}" }
    }
  ]
}
```

- **`url`:** the agent's Agent Card URL, or a base URL whose card is at `/.well-known/agent-card.json`.
- **`headers`:** sent when reading the card. Values may use `{env:VAR}`, so tokens stay out of the file.
- **`category`:** optional, for the `list_agents` filter.

Cards are read at start, again when the file changes, and at most every `--ttl` seconds (default 300). An agent whose card can't be read stays listed with `is_healthy: false`, keeping its last card if it had one. The server only contacts the URLs in the file.

## Tools

| Tool            | Input                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------- |
| `search_agents` | `query`, `limit`: keyword search over name, description, author and skills               |
| `list_agents`   | `skill`, `capability`, `author`, `conformance`, `healthy`, `category`, `limit`, `offset` |
| `get_agent`     | `agent_id`                                                                               |
| `list_skills`   | `limit`                                                                                  |

Results follow the A2A Registry's fields: `id`, `name`, `description`, `author`, `url` (the JSON-RPC endpoint), `wellKnownURI`, `version`, `conformance`, `capabilities`, `skills`, `provider`, `is_healthy`, `category`. Each one is marked as untrusted third-party data.

## Use it from OpenCode

Run it locally, over stdio:

```json
{
  "mcp": {
    "servers": {
      "company-agents": {
        "type": "local",
        "command": ["bun", "/path/to/opencode/packages/a2a-registry-mcp/src/main.ts", "/path/to/agents.json"]
      }
    }
  }
}
```

Or on an internal host, over HTTP:

```bash
bun packages/a2a-registry-mcp/src/main.ts agents.json --http --host 0.0.0.0 --port 8787
```

```json
{ "mcp": { "servers": { "company-agents": { "type": "remote", "url": "http://agents.internal:8787/" } } } }
```

## Run one shared server for your organization

One server on an internal host keeps one agent list for everyone. Each person's config then holds only its URL, like any other remote MCP server, and nothing needs installing on their machines.

There is no token: anyone who can reach the host can list the agents. Run it only where the internal network (or VPN) is the boundary, never on a host reachable from the internet.

### Build the image

From this package, on any machine with Bun and Docker:

```bash
bun run build
docker build -t a2a-registry-mcp .
```

`bun run build` bundles the server and its dependencies into `dist/a2a-registry-mcp.js`, so the image holds only that file and Bun. Copy the image to the host with `docker save` / `docker load`, or push it to your internal registry.

### Run it on the host

Keep the agents file in a folder on the host, for example `/srv/a2a-agents/agents.json`, and mount the folder:

```bash
docker run -d --name a2a-agents --restart unless-stopped \
  -p 8787:8787 \
  -v /srv/a2a-agents:/data:ro \
  a2a-registry-mcp
```

- **Mount the folder, not the file.** Editors often save by replacing the file, and a single-file mount would keep showing the old one.
- **Update the list** by editing `/srv/a2a-agents/agents.json` on the host. The server rereads it on the next call; no restart.
- **Tokens for agents' cards:** pass them with `-e NAME=value`, and reference them in the file as `{env:NAME}`.
- **Health:** `GET /health` answers `ok`, and Docker reports the container as healthy.

### Everyone's config

```json
{
  "mcp": {
    "bsc-agents": { "type": "remote", "url": "http://<host>:8787/", "enabled": true }
  }
}
```

The public registry can sit next to it:

```json
{ "mcp": { "servers": { "a2a-registry": { "type": "remote", "url": "https://a2aregistry.org/mcp/" } } } }
```
