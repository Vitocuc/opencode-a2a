import { EOL } from "node:os"
import { readFile, writeFile } from "node:fs/promises"
import { cancel, confirm, isCancel } from "@clack/prompts"
import { Effect, Option, Schema } from "effect"
import { applyEdits, modify, parse } from "jsonc-parser"
import { A2A } from "@opencode/schema/a2a"
import { ConfigA2A } from "@opencode/schema/config/a2a"
import { Global } from "@opencode/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { resolveConfigPath } from "../mcp/add"

export default Runtime.handler(
  Commands.commands.a2a.commands.add,
  Effect.fn("cli.a2a.add")(function* (input) {
    if (!URL.canParse(input.url)) return yield* Effect.fail(new Error(`Invalid URL: ${input.url}`))
    const headers = yield* Effect.try({
      try: () => headerReferences(Option.getOrUndefined(input.header) ?? {}),
      catch: (error) => error as Error,
    })
    const card = yield* Effect.tryPromise({ try: () => readCard(input.url), catch: (error) => error as Error })
    const name = Option.getOrUndefined(input.name) ?? ConfigA2A.agentName(card.card.name)
    const global = yield* Global.Service
    const configPath = yield* Effect.promise(() => resolveConfigPath(global.config))

    // Check the name before asking, so a confirmed add doesn't then fail.
    yield* Effect.tryPromise({ try: () => checkName(configPath, name, input.force), catch: (error) => error as Error })
    process.stdout.write(describe(name, input.url, card) + EOL)
    if (card.security.length > 0 && Object.keys(headers).length === 0)
      process.stdout.write(
        `Warning: the card asks for authentication (${card.security.join(", ")}). Add it with --header Authorization=<ENV_VAR>.${EOL}`,
      )
    if (!input.yes) {
      if (!process.stdin.isTTY) return yield* Effect.fail(new Error("Not a terminal: pass --yes to add the agent"))
      const accepted = yield* Effect.promise(() => confirm({ message: `Add "${name}" to ${configPath}?` }))
      if (isCancel(accepted) || !accepted) return cancel("Nothing was added")
    }

    yield* Effect.tryPromise({
      try: () =>
        writeAgent(
          configPath,
          name,
          { url: input.url, ...(Object.keys(headers).length > 0 ? { headers } : {}) },
          input.force,
        ),
      catch: (error) => error as Error,
    })
    const variables = Object.values(headers).flatMap((value) =>
      [...value.matchAll(/\{env:([^}]+)\}/g)].map((m) => m[1]),
    )
    process.stdout.write(`A2A agent "${name}" added to ${configPath}${EOL}`)
    if (variables.length > 0) process.stdout.write(`Set ${variables.join(", ")} before OpenCode calls it.${EOL}`)
  }),
)

/** The remote agent's card, read the way OpenCode's a2a tool reads it, and the security schemes it declares. */
export async function readCard(url: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(cardURL(url), {
    headers: { "A2A-Version": "1.0", accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  }).catch((error) => {
    throw new Error(
      `Could not read the Agent Card at ${cardURL(url)}: ${error instanceof Error ? error.message : error}`,
    )
  })
  if (!response.ok) throw new Error(`Could not read the Agent Card at ${cardURL(url)}: HTTP ${response.status}`)
  const json: unknown = await response.json().catch(() => undefined)
  const card = Schema.decodeUnknownOption(A2A.RemoteCard)(json)
  if (Option.isNone(card)) throw new Error(`${cardURL(url)} is not an A2A Agent Card`)
  const endpoint =
    card.value.supportedInterfaces?.find((item) => item.protocolBinding.toUpperCase() === "JSONRPC")?.url ??
    card.value.url
  if (!endpoint) throw new Error(`${card.value.name} offers no JSON-RPC interface`)
  return { card: card.value, endpoint, security: Object.keys(card.value.securitySchemes ?? {}) }
}

/**
 * Headers as `{env:VAR}` references only, so secrets never land in a config file. `Authorization=TOKEN` becomes
 * `Bearer {env:TOKEN}`; any other header gets the variable's value as it is.
 */
export function headerReferences(input: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(input).map(([header, variable]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable))
        throw new Error(
          `--header ${header}=${variable}: give the name of an environment variable that holds the value, not the value itself`,
        )
      return [header, header.toLowerCase() === "authorization" ? `Bearer {env:${variable}}` : `{env:${variable}}`]
    }),
  )
}

/** Sets `a2a.agents.<name>` in a JSONC config, keeping its comments and formatting. */
export async function writeAgent(configPath: string, name: string, agent: unknown, force: boolean) {
  const text = await checkName(configPath, name, force)
  const edits = modify(text, ["a2a", "agents", name], agent, { formattingOptions: { tabSize: 2, insertSpaces: true } })
  await writeFile(configPath, applyEdits(text, edits))
}

/** The config's text, once it's known that `name` is free or may be replaced. */
async function checkName(configPath: string, name: string, force: boolean) {
  const text = await readFile(configPath, "utf8").catch((error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "{}"
    throw error
  })
  const existing = (parse(text, [], { allowTrailingComma: true }) as { a2a?: { agents?: Record<string, unknown> } })
    ?.a2a?.agents?.[name]
  if (existing !== undefined && !force)
    throw new Error(`An A2A agent named "${name}" is already configured in ${configPath}; pass --force to replace it`)
  return text
}

// Same rule as the a2a tool's client in Core, which the CLI can't import.
function cardURL(url: string) {
  const parsed = new URL(url)
  if (parsed.pathname !== "/" && parsed.pathname !== "") return parsed.href
  return new URL("/.well-known/agent-card.json", parsed).href
}

function describe(name: string, url: string, card: Awaited<ReturnType<typeof readCard>>) {
  const skills = (card.card.skills ?? []).map((skill) => skill.name).join(", ")
  return [
    `Agent:    ${card.card.name} (as "${name}")`,
    ...(card.card.description ? [`About:    ${card.card.description}`] : []),
    `Card:     ${cardURL(url)}`,
    `Endpoint: ${card.endpoint}`,
    ...(skills ? [`Skills:   ${skills}`] : []),
  ].join(EOL)
}
