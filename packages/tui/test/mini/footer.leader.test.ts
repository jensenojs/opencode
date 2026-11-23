import { expect, test } from "bun:test"
import { createBindingLookup } from "@opentui/keymap/extras"
import { TuiKeybind } from "../../src/config/keybind"
import { leaderConflicts } from "../../src/mini/footer"

// The leader is matched as a resolved key, so the check runs against the same
// lookup the keymap provider uses.
const config = {
  keybinds: createBindingLookup(TuiKeybind.toBindingConfig(TuiKeybind.parse({})), {
    bindingDefaults: TuiKeybind.bindingDefaults(),
  }),
} as never

test("leader 与已绑定的键冲突时报告该命令", () => {
  // mini binds ctrl+x to "hide back to the shell"; using it as the leader
  // would swallow every <leader>x combination.
  expect(leaderConflicts(config, "ctrl+x")).toContain("zom.dismiss")
})

test("默认 leader 无冲突", () => {
  expect(leaderConflicts(config, "ctrl+g")).toEqual([])
  expect(leaderConflicts(config, "ctrl+m")).toEqual([])
})

test("大小写与 control 拼写归一", () => {
  expect(leaderConflicts(config, "Control+X")).toContain("zom.dismiss")
})
