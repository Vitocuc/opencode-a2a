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
const providerPackage = "@opencode/ai/providers/openai-compatible"

// Gepeto is an Open WebUI deployment: its OpenAI-compatible API lives under `/api` and takes the `sk-...` API key a
// user creates in Gepeto under Settings > Account.
const baseURL = "https://gepeto.bsc.es/api"

const ModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
      info: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            meta: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  capabilities: Schema.optional(
                    Schema.NullOr(Schema.Struct({ vision: Schema.optional(Schema.Boolean) })),
                  ),
                }),
              ),
            ),
          }),
        ),
      ),
    }),
  ),
})

type GepetoModel = { readonly id: string; readonly name: string; readonly vision: boolean }

export const GepetoPlugin = define({
  id: "podarcis.provider.gepeto",
  effect: Effect.fn(function* (ctx) {
    const cache = yield* SharedCache.Service
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const discovered = yield* ProviderRefresh.start({
      integrationID,
      initial: [] as readonly GepetoModel[],
      active: ctx.integration.connection.active(integrationID),
      reload: ctx.provider.reload(),
      load: Effect.fn("GepetoPlugin.load")(function* (_current, options) {
        const { connection, credential } = yield* activeCredential(ctx, integrationID)
        if (!connection || credential?.type !== "key") return { connection, value: [] }
        const value = yield* cache
          .get({
            key: `gepeto:${IntegrationConnection.key(connection)}`,
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
                  response.data
                    .filter((model) => model.id.length > 0)
                    .map(
                      (model): GepetoModel => ({
                        id: model.id,
                        name: model.name || model.id,
                        vision: model.info?.meta?.capabilities?.vision === true,
                      }),
                    )
                    .toSorted((a, b) => a.id.localeCompare(b.id)),
                ),
              ),
          })
          .pipe(Effect.orElseSucceed((): readonly GepetoModel[] => []))
        return { connection, value }
      }),
    })

    yield* ctx.integration.transform((integrations) => {
      integrations.update(integrationID, (integration) => (integration.name = "Gepeto"))
      integrations.method.update({ integrationID, method: { type: "key" } })
      integrations.method.update({ integrationID, method: { type: "env", names: ["GEPETO_API_KEY"] } })
    })

    // `GepetoLockPlugin` sets the package and base URL last, so config cannot point Gepeto elsewhere.
    yield* ctx.provider.transform((providers) => {
      providers.update(providerID, (provider) => {
        provider.name = "Gepeto"
        provider.integrationID = integrationID
      })
      for (const item of discovered.current) {
        providers.models.update(providerID, item.id, (model) => {
          model.modelID = Model.ID.make(item.id)
          model.name = item.name
          // Open WebUI does not report tool support; a coding agent needs it, so assume the backend handles it.
          model.capabilities = { tools: true, input: ["text", ...(item.vision ? ["image"] : [])], output: ["text"] }
          // Open WebUI does not report context windows either; config can override per model.
          model.limit = { context: 128_000, output: 8_192 }
        })
      }
    })
  }),
} satisfies PluginInternal.InternalPlugin)

/**
 * Runs after every config and external plugin, so nothing can add another provider back or point Gepeto's models
 * at another endpoint: removes each provider that is not Gepeto and pins Gepeto's package and base URL.
 */
export const GepetoLockPlugin = define({
  id: "podarcis.provider.lock",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.provider.transform((providers) => {
      for (const record of providers.list()) {
        if (record.provider.id !== providerID) providers.remove(record.provider.id)
      }
      providers.update(providerID, (provider) => {
        provider.package = providerPackage
        provider.settings = { ...provider.settings, baseURL, provider: providerID }
      })
      for (const model of providers.get(providerID)?.models.values() ?? []) {
        if (model.package === undefined && model.settings?.baseURL === undefined) continue
        providers.models.update(providerID, model.id, (draft) => {
          delete draft.package
          delete draft.settings?.baseURL
        })
      }
    })
  }),
} satisfies PluginInternal.InternalPlugin)
