import { expect, test } from "bun:test"
import { permissionPresentation } from "../../src/util/permission"

test("preserves permission roots and self-contained metadata", () => {
  expect(permissionPresentation({ action: "external_directory", resources: ["/*"] }).title).toBe(
    "Access external directory /",
  )
  expect(permissionPresentation({ action: "external_directory", resources: ["C:/*"] }).title).toBe(
    "Access external directory C:/",
  )
  expect(
    permissionPresentation({ action: "webfetch", resources: [], metadata: { url: "https://example.com" } }),
  ).toMatchObject({
    title: "WebFetch https://example.com",
    lines: ["URL: https://example.com"],
  })
  expect(permissionPresentation({ action: "websearch", resources: [], metadata: { query: "releases" } })).toMatchObject(
    {
      title: 'Web Search "releases"',
      lines: ["Query: releases"],
    },
  )
})

test("shows the card of an A2A agent the model proposes to add", () => {
  expect(
    permissionPresentation({
      action: "a2a_add",
      resources: ["https://agents.internal/translator"],
      metadata: {
        name: "translator",
        card: "Translator",
        url: "https://agents.internal/translator",
        endpoint: "https://agents.internal/translator/rpc",
        skills: ["Translate"],
        environment: ["A2A_TRANSLATOR_TOKEN"],
      },
    }),
  ).toEqual({
    icon: "+",
    title: "Add A2A agent translator",
    lines: [
      "Card name: Translator",
      "Card: https://agents.internal/translator",
      "Endpoint: https://agents.internal/translator/rpc",
      "Skills: Translate",
      "Authentication: set A2A_TRANSLATOR_TOKEN",
      "It will be added to your global config.",
    ],
  })
})
