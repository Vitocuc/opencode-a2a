import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { GepetoPlugin, providerID } from "@opencode/core/plugin/provider/gepeto"
import { drain } from "../lib/clock"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const integrationID = Integration.ID.make("gepeto")

const install = Effect.fn(function* (...plugins: (typeof GepetoPlugin)[]) {
  const requests: HttpClientRequest.HttpClientRequest[] = []
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request)
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          data: [
            { id: "qwen-coder", name: "Qwen Coder", owned_by: "openai" },
            { id: "llava", name: "LLaVA", owned_by: "ollama", info: { meta: { capabilities: { vision: true } } } },
          ],
        }),
      )
    }),
  )
  const host = yield* PluginHost.make(yield* Plugin.Service, "test")
  for (const plugin of plugins) yield* plugin.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, http))
  yield* drain
  return requests
})

describe("GepetoPlugin", () => {
  test("is registered next to the other provider plugins", () => {
    expect(ProviderPlugins).toContain(GepetoPlugin)
    expect(ProviderPlugins.length).toBeGreaterThan(1)
  })

  it.effect("discovers models from Gepeto with the stored API key", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const models = yield* Model.Service
      const integrations = yield* Integration.Service
      yield* credentials.create({ integrationID, value: { type: "key", key: "sk-gepeto" } })
      const requests = yield* install(GepetoPlugin)

      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
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
      expect(yield* install(GepetoPlugin)).toHaveLength(0)
    }),
  )
})
