# The shared server for an organization's internal A2A agents. Build the bundle first, from this package:
#   bun run build && docker build -t a2a-registry-mcp .
# Then mount a folder holding agents.json at /data and publish port 8787 (see README.md).
FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY dist/a2a-registry-mcp.js /app/a2a-registry-mcp.js
USER bun
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD ["bun", "-e", "fetch('http://127.0.0.1:8787/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["bun", "/app/a2a-registry-mcp.js", "/data/agents.json", "--http", "--host", "0.0.0.0", "--port", "8787"]
