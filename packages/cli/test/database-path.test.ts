import { expect, test } from "bun:test"
import path from "node:path"
import { databasePath } from "../src/database-path"

// The session store is one file for every channel. Upstream would name it after the
// build channel, which is how two builds end up reading two different histories.
test("one store: the database name does not follow the channel", () => {
  expect(databasePath("/data")).toBe(path.resolve("/data/opencode.db"))
})

test("OPENCODE_DB overrides the path for archive work", () => {
  const previous = process.env.OPENCODE_DB
  process.env.OPENCODE_DB = "opencode-zom.db"
  try {
    expect(databasePath("/data")).toBe(path.resolve("/data/opencode-zom.db"))
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_DB
    else process.env.OPENCODE_DB = previous
  }
})

test(":memory: is not resolved to a file", () => {
  const previous = process.env.OPENCODE_DB
  process.env.OPENCODE_DB = ":memory:"
  try {
    expect(databasePath("/data")).toBe(":memory:")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_DB
    else process.env.OPENCODE_DB = previous
  }
})
