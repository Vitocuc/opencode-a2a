import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { GepetoLockPlugin, GepetoPlugin } from "@opencode/core/plugin/provider/gepeto"
import { drain } from "../lib/clock"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const providerID = Provider.ID.make("gepeto")
const integrationID = Integration.ID.make("gepeto")

const fixture = Effect.gen(function* () {
  const remote = {
    requests: [] as HttpClientRequest.HttpClientRequest[],
    body: {
      data: [
        { id: "qwen-coder", name: "Qwen Coder", owned_by: "openai" },
        { id: "llava", name: "LLaVA", owned_by: "ollama", info: { meta: { capabilities: { vision: true } } } },
      ],
    } as unknown,
  }
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      remote.requests.push(request)
      return HttpClientResponse.fromWeb(request, Response.json(remote.body))
    }),
  )
  const install = (plugin: typeof GepetoPlugin) =>
    Effect.gen(function* () {
      const host = yield* PluginHost.make(yield* Plugin.Service, "test")
      yield* plugin.effect(host)
    }).pipe(Effect.provideService(HttpClient.HttpClient, http))
  return { remote, install }
})

describe("GepetoPlugin", () => {
  it.effect("is the only registered provider plugin", () =>
    Effect.sync(() => {
      expect(ProviderPlugins).toEqual([GepetoPlugin])
    }),
  )

  it.effect("discovers models from Gepeto with the stored API key", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const models = yield* Model.Service
      const integrations = yield* Integration.Service
      const setup = yield* fixture
      yield* credentials.create({ integrationID, value: { type: "key", key: "sk-gepeto" } })
      yield* setup.install(GepetoPlugin)
      yield* drain

      expect(setup.remote.requests).toHaveLength(1)
      expect(setup.remote.requests[0]).toMatchObject({
        method: "GET",
        url: "https://gepeto.bsc.es/api/models",
        headers: { authorization: "Bearer sk-gepeto" },
      })
      expect((yield* integrations.get(integrationID))?.methods).toEqual([
        { type: "key" },
        { type: "env", names: ["GEPETO_API_KEY"] },
      ])
      expect(yield* models.get(providerID, Model.ID.make("qwen-coder"))).toMatchObject({
        name: "Qwen Coder",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "https://gepeto.bsc.es/api" },
        capabilities: { tools: true, input: ["text"] },
      })
      expect(yield* models.get(providerID, Model.ID.make("llava"))).toMatchObject({
        capabilities: { input: ["text", "image"] },
      })
    }),
  )

  it.effect("does not call Gepeto without an API key", () =>
    Effect.gen(function* () {
      const setup = yield* fixture
      yield* setup.install(GepetoPlugin)
      yield* drain
      expect(setup.remote.requests).toHaveLength(0)
    }),
  )

  it.effect("the lock removes every provider except Gepeto", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      const setup = yield* fixture
      yield* providers.transform((draft) => {
        draft.update(Provider.ID.openai, (provider) => {
          provider.activation = "enabled"
          provider.package = "@opencode/ai/providers/openai"
        })
        draft.update(Provider.ID.make("custom"), (provider) => {
          provider.activation = "enabled"
          provider.package = "@opencode/ai/providers/openai-compatible"
        })
      })
      yield* setup.install(GepetoLockPlugin)
      yield* drain
      expect(yield* providers.get(Provider.ID.openai)).toBeUndefined()
      expect(yield* providers.get(Provider.ID.make("custom"))).toBeUndefined()
    }),
  )
})
