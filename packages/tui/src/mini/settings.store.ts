// mini 自己的设置：上游 tui 配置里没有的键（目前只有状态行名字槽位）。
//
// 这些键不写进 ~/.config/opencode 的共享配置。stock 进程读同一份文件：
// 它的 schema 不认识这些键，解码时忽略（packages/core/src/config.ts 的
// onExcessProperty: "ignore"），但它写回配置时按自己的模型重写，fork 的键
// 会无声消失；反过来上游哪天给同名键赋予别的含义，就是一次静默碰撞。
// 落在这里的键由 fork 独占，stock 既不读也不写。
//
// 位置与 mini-draft.json 同家：channel 隔离的 state 目录
// (~/.local/state/opencode/<channel>)，stock 用另一个 channel 目录。
import path from "node:path"
import { readJson, writeJsonAtomic } from "../util/persistence"
import type { MiniStatusName } from "./types"

const VERSION = 1
const FILE = "mini-settings.json"

type StoredSettings = {
  version: number
  status_name?: MiniStatusName
}

export type MiniSettingsStore = {
  load(): Promise<{ status_name?: MiniStatusName }>
  saveStatusName(value: MiniStatusName): Promise<void>
}

function isStatusName(value: unknown): value is MiniStatusName {
  return value === "agent" || value === "session"
}

export function createMiniSettingsStore(state: string): MiniSettingsStore {
  const file = path.join(state, FILE)
  return {
    async load() {
      // 读不到或内容坏了都当没有：这个文件是本进程自己写的，坏了不该拦住启动。
      const stored = await readJson<StoredSettings>(file).catch(() => undefined)
      return isStatusName(stored?.status_name) ? { status_name: stored.status_name } : {}
    },
    async saveStatusName(value) {
      await writeJsonAtomic(file, { version: VERSION, status_name: value } satisfies StoredSettings)
    },
  }
}
