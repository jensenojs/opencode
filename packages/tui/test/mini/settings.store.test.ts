import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createMiniSettingsStore } from "../../src/mini/settings.store"

const state = () => mkdtempSync(path.join(tmpdir(), "zom-mini-settings-"))

test("status-line name survives a restart through the fork-owned state file", async () => {
  const dir = state()
  expect(await createMiniSettingsStore(dir).load()).toEqual({})
  await createMiniSettingsStore(dir).saveStatusName("session")
  // A fresh store instance is what the next boot sees.
  expect(await createMiniSettingsStore(dir).load()).toEqual({ status_name: "session" })
})

test("a corrupt or unexpected file falls back to defaults instead of failing boot", async () => {
  const corrupt = state()
  writeFileSync(path.join(corrupt, "mini-settings.json"), "{not json")
  expect(await createMiniSettingsStore(corrupt).load()).toEqual({})

  const unknown = state()
  writeFileSync(path.join(unknown, "mini-settings.json"), JSON.stringify({ status_name: "workspace" }))
  expect(await createMiniSettingsStore(unknown).load()).toEqual({})
})
