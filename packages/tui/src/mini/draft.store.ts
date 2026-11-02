// 输入草稿的跨召唤持久化。
//
// ctrl+x 把 mini 整个退掉（干净退出，不留停止的作业），输入框里没送出的内容会
// 随之消失；下次召唤是冷启动，草稿只能从别处找回来。这里把它落到 state 目录：
//
// - 文本、附件描述与 shell 模式进 JSON；
// - 图片这类 `data:` base64 大块按内容摘要写成旁路文件，JSON 里只留引用。挂着
//   base64 的话每敲一个键都要把整张图重写一遍。
//
// 每次保存都按「当前草稿引用到的文件」回收其余旁路文件，所以 ctrl+c 清空、提交
// 成功、换掉一张图都会自然回收，不需要在那些地方另外挂删除钩子。
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { readdir, rm } from "node:fs/promises"
import path from "node:path"
import { readJson, readText, writeJsonAtomic, writeText } from "../util/persistence"
import type { RunPrompt, RunPromptPart } from "./types"

const VERSION = 1
const FILE = "mini-draft.json"
const BLOB_DIR = "mini-draft"
const BLOB_PREFIX = "blob-"
const BLOB_SCHEME = "zom-draft-blob:"
const DATA_URI = /^data:([^;,]+);base64,(.*)$/s

type StoredDraft = { version: number; draft: RunPrompt }

export type DraftStore = {
  load(): Promise<RunPrompt | undefined>
  save(draft: RunPrompt): Promise<void>
  saveSync(draft: RunPrompt): void
}

function blobName(uri: string) {
  return `${BLOB_PREFIX}${createHash("sha256").update(uri).digest("hex").slice(0, 16)}`
}

function empty(draft: RunPrompt) {
  return draft.text.length === 0 && draft.parts.length === 0
}

// 内容摘要式的同一性判据：图片旁路化之后，判据里带的是摘要而不是整张图。
function draftKey(draft: RunPrompt) {
  return [
    draft.text,
    draft.mode ?? "",
    draft.command?.name ?? "",
    draft.command?.arguments ?? "",
    draft.parts
      .map((part) =>
        part.type === "file" ? part.url : part.type === "agent" ? `agent:${part.name}` : `skill:${part.id}`,
      )
      .join("\u0001"),
  ].join("\u0000")
}

function referenced(draft: RunPrompt) {
  const names = new Set<string>()
  for (const part of draft.parts) {
    if (part.type === "file" && part.url.startsWith(BLOB_SCHEME)) {
      names.add(part.url.slice(BLOB_SCHEME.length))
    }
  }
  return names
}

// 把 data: URI 换成旁路引用，同时交出要落盘的内容。
function shrink(part: RunPromptPart, blobs: Map<string, string>) {
  if (part.type !== "file") return part
  const match = DATA_URI.exec(part.url)
  if (!match) return part
  const name = blobName(part.url)
  blobs.set(name, match[2] ?? "")
  return { ...part, url: `${BLOB_SCHEME}${name}` }
}

async function expand(dir: string, part: RunPromptPart) {
  if (part.type !== "file" || !part.url.startsWith(BLOB_SCHEME)) return part
  const payload = await readText(path.join(dir, part.url.slice(BLOB_SCHEME.length))).catch(() => undefined)
  // 旁路文件没了就丢掉这个附件；剩下的草稿照常可用。
  if (payload === undefined) return undefined
  return { ...part, url: `data:${part.mime ?? "application/octet-stream"};base64,${payload}` }
}

export function createDraftStore(state: string): DraftStore {
  const file = path.join(state, FILE)
  const dir = path.join(state, BLOB_DIR)
  let last: string | undefined
  // 已经在磁盘上的旁路文件，避免每次保存重写同一张图。
  const held = new Set<string>()

  function split(draft: RunPrompt) {
    const blobs = new Map<string, string>()
    const parts = draft.parts.map((part) => shrink(part, blobs))
    return { blobs, next: { ...draft, parts } satisfies RunPrompt }
  }

  async function write(next: RunPrompt, blobs: Map<string, string>) {
    for (const [name, payload] of blobs) {
      if (held.has(name)) continue
      // 只在写成功后才记进 held，否则写失败就再也不会重试。
      await writeText(path.join(dir, name), payload)
        .then(() => held.add(name))
        .catch(() => undefined)
    }
    await writeJsonAtomic(file, { version: VERSION, draft: next } satisfies StoredDraft)
    const keep = referenced(next)
    await Promise.all(
      (await readdir(dir).catch(() => [] as string[]))
        .filter((name) => name.startsWith(BLOB_PREFIX) && !keep.has(name))
        .map((name) => {
          held.delete(name)
          return rm(path.join(dir, name), { force: true }).catch(() => undefined)
        }),
    )
  }

  function writeSync(next: RunPrompt, blobs: Map<string, string>) {
    try {
      mkdirSync(dir, { recursive: true })
      for (const [name, payload] of blobs) {
        if (held.has(name)) continue
        writeFileSync(path.join(dir, name), payload)
        held.add(name)
      }
      writeFileSync(file, JSON.stringify({ version: VERSION, draft: next } satisfies StoredDraft))
      const keep = referenced(next)
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(BLOB_PREFIX) || keep.has(name)) continue
        rmSync(path.join(dir, name), { force: true })
        held.delete(name)
      }
    } catch {
      // 退出路径上的兜底：写不进去就算了，不能因此绊住退出。
    }
  }

  async function wipe() {
    last = undefined
    held.clear()
    await rm(file, { force: true }).catch(() => undefined)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }

  function wipeSync() {
    last = undefined
    held.clear()
    try {
      rmSync(file, { force: true })
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 同上，清理失败不影响退出。
    }
  }

  return {
    async load() {
      const stored = await readJson<StoredDraft>(file).catch(() => undefined)
      if (!stored || stored.version !== VERSION || !stored.draft || typeof stored.draft.text !== "string") {
        return undefined
      }

      for (const name of await readdir(dir).catch(() => [] as string[])) held.add(name)
      const parts: RunPromptPart[] = []
      for (const part of stored.draft.parts ?? []) {
        const expanded = await expand(dir, part)
        if (expanded) parts.push(expanded)
      }

      const draft: RunPrompt = { ...stored.draft, parts }
      if (empty(draft)) {
        await wipe()
        return undefined
      }

      last = draftKey(stored.draft)
      // 用落盘那份（旁路引用）去清扫孤儿文件；换回 data: 那份会把它们全判成孤儿。
      await write(stored.draft, new Map())
      return draft
    },
    async save(draft) {
      if (empty(draft)) {
        if (last === undefined) return
        await wipe()
        return
      }
      const { blobs, next } = split(draft)
      const key = draftKey(next)
      if (key === last) return
      last = key
      await write(next, blobs)
    },
    saveSync(draft) {
      if (empty(draft)) {
        if (last === undefined) return
        wipeSync()
        return
      }
      const { blobs, next } = split(draft)
      const key = draftKey(next)
      if (key === last) return
      last = key
      writeSync(next, blobs)
    },
  }
}
