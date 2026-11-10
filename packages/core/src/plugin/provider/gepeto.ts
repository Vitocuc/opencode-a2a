import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { App } from "../../app.js"
import { Integration } from "../../integration.js"
import { IntegrationConnection } from "../../integration/connection.js"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"
import { SharedCache } from "../../shared-cache.js"
import type { PluginInternal } from "../internal.js"
import { activeCredential } from "./credential-settings.js"
import { ProviderRefresh } from "./refresh.js"

/** The only provider Podarcis offers. `GepetoLockPlugin` removes every other one. */
export const providerID = Provider.ID.make("gepeto")
const integrationID = Integration.ID.make("gepeto")

// Gepeto is an Open WebUI deployment: its OpenAI-compatible API lives under `/api` and takes the `sk-...` API key a
// user creates in Gepeto under Settings > Account.
const baseURL = "https://gepeto.bsc.es/api"

const RemoteModel = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  info: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        meta: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              capabilities: Schema.optional(Schema.NullOr(Schema.Struct({ vision: Schema.optional(Schema.Boolean) }))),
            }),
          ),
        ),
      }),
    ),
  ),
})
type RemoteModel = typeof RemoteModel.Type
const ModelsResponse = Schema.Struct({ data: Schema.Array(RemoteModel) })

export const GepetoPlugin = define({
  id: "podarcis.provider.gepeto",
  effect: Effect.fn(function* (ctx) {
    const cache = yield* SharedCache.Service
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const discovered = yield* ProviderRefresh.start({
      integrationID,
      initial: { models: [] } as { readonly key?: string; readonly models: readonly RemoteModel[] },
      active: ctx.integration.connection.active(integrationID),
      reload: ctx.provider.reload(),
      load: Effect.fn("GepetoPlugin.load")(function* (_current, options) {
        const { connection, credential } = yield* activeCredential(ctx, integrationID)
        if (!connection || credential?.type !== "key") return { connection, value: { models: [] } }
        const key = `gepeto:${IntegrationConnection.key(connection)}`
        const models = yield* cache
          .get({
            key,
            ...options,
            load: http
              .execute(
                HttpClientRequest.get(`${baseURL}/models`).pipe(
                  HttpClientRequest.bearerToken(credential.key),
                  HttpClientRequest.acceptJson,
                  HttpClientRequest.setHeader("User-Agent", App.useragent(ctx.app)),
                ),
              )
              .pipe(
                Effect.flatMap(HttpClientResponse.schemaBodyJson(ModelsResponse)),
                Effect.timeout("10 seconds"),
                Effect.map((response) =>
                  response.data.filter((model) => model.id.length > 0).toSorted((a, b) => a.id.localeCompare(b.id)),
                ),
              ),
          })
          .pipe(Effect.orElseSucceed((): readonly RemoteModel[] => []))
        return { connection, value: { key, models } }
      }),
    })

    yield* ctx.integration.transform((integrations) => {
      integrations.update(integrationID, (integration) => (integration.name = "Gepeto"))
      integrations.method.update({ integrationID, method: { type: "key" } })
      integrations.method.update({ integrationID, method: { type: "env", names: ["GEPETO_API_KEY"] } })
    })

    yield* ctx.provider.transform((providers) => {
      providers.update(providerID, (provider) => {
        provider.name = "Gepeto"
        provider.integrationID = integrationID
        provider.package = "@opencode/ai/providers/openai-compatible"
        provider.settings = { ...provider.settings, baseURL, provider: providerID }
      })
      for (const item of discovered.current.models) {
        providers.models.update(providerID, item.id, (model) => {
          model.modelID = Model.ID.make(item.id)
          model.name = item.name || item.id
          // Open WebUI does not report tool support; a coding agent needs it, so assume the backend handles it.
          model.capabilities = {
            tools: true,
            input: ["text", ...(item.info?.meta?.capabilities?.vision ? (["image"] as const) : [])],
            output: ["text"],
          }
          // Open WebUI does not report context windows either; config can override per model.
          model.limit = { context: 128_000, output: 8_192 }
        })
      }
    })
  }),
} satisfies PluginInternal.InternalPlugin)

/**
 * Runs after every config and external plugin so nothing can add another provider back: removes each provider
 * that is not Gepeto.
 */
export const GepetoLockPlugin = define({
  id: "podarcis.provider.lock",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.provider.transform((providers) => {
      for (const record of providers.list()) {
        if (record.provider.id !== providerID) providers.remove(record.provider.id)
      }
    })
  }),
} satisfies PluginInternal.InternalPlugin)
