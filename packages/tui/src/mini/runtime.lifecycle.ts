// Lifecycle management for the split-footer renderer.
//
// Creates the OpenTUI CliRenderer in split-footer mode, resolves the theme
// from the terminal palette, writes the entry splash to scrollback, and
// constructs the RunFooter. Returns a Lifecycle handle whose close() writes
// the exit splash and tears everything down in the right order:
// footer.close → footer.destroy → renderer shutdown.
//
// Also wires SIGINT so Ctrl-c clears a live prompt draft first, then falls
// back to the usual two-press exit sequence through RunFooter.requestExit().
import path from "path"
import { appendFileSync, readFileSync, statSync, writeFileSync, writeSync } from "fs"
import {
  CliRenderEvents,
  buildKittyKeyboardFlags,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
  type ScrollbackWriter,
} from "@opentui/core"
import { isFallbackTitle } from "@opencode/util/session-title-fallback"
import { monoSnapshot } from "./mono"
import { entrySplash, exitSplash } from "./splash"
import { resolveRunTheme } from "./theme"
import type {
  FooterApi,
  FormCancel,
  FormReply,
  MiniSettingChange,
  MiniSettings,
  MiniHost,
  PermissionReply,
  QueuedPromptAction,
  FooterShellRow,
  RunAgent,
  RunInput,
  RunPrompt,
  RunReference,
  RunSkill,
  RunTuiConfig,
} from "./types"
import { resolveMiniSettings } from "./runtime.boot"
import { formatModelLabel } from "./variant.shared"

const FOOTER_HEIGHT = 4

type SplashState = {
  entry: boolean
  exit: boolean
}

type CycleResult = {
  modelLabel?: string
  status?: string
  variant?: string | undefined
  variants?: string[]
}

export type LifecycleInput = {
  host: MiniHost
  getDirectory: () => string
  findFiles: (query: string) => Promise<string[]>
  agents: RunAgent[]
  references: RunReference[]
  skills: RunSkill[]
  sessionID: string
  sessionTitle?: string
  getSessionID?: () => string | undefined
  first: boolean
  history: RunPrompt[]
  agent: string | undefined
  model: RunInput["model"]
  variant: string | undefined
  leader?: string
  tuiConfig: RunTuiConfig | Promise<RunTuiConfig>
  // Resolved settings, including the fork-owned status-line name that does not
  // come from tuiConfig (see settings.store.ts). Read after tuiConfig lands.
  getMiniSettings?: () => MiniSettings
  onMiniSettingChange?: (change: MiniSettingChange) => Promise<MiniSettings>
  onPermissionReply: (input: PermissionReply) => void | Promise<void>
  onFormReply: (input: FormReply) => void | Promise<void>
  onFormCancel: (input: FormCancel) => void | Promise<void>
  onCycleVariant?: () => CycleResult | void
  onAgentSelect?: (agent: string) => void
  onModelSelect?: (model: NonNullable<RunInput["model"]>) => CycleResult | void | Promise<CycleResult | void>
  onVariantSelect?: (variant: string | undefined) => CycleResult | void | Promise<CycleResult | void>
  onInterrupt?: () => void
  onBackground?: () => void
  onQueuedPromptAction?: (action: QueuedPromptAction, inboxID: string) => Promise<void>
  listShells?: () => Promise<FooterShellRow[]>
  killShell?: (id: string) => Promise<void>
  onSubagentSelect?: (sessionID: string | undefined) => void
  onSubagentInterrupt?: (sessionID: string) => void
}

export type Lifecycle = {
  footer: FooterApi
  onResize(fn: () => void): () => void
  refreshTheme(): void
  setTitle(title?: string): void
  resetForReplay(splash?: boolean): Promise<void>
  close(input: { showExit: boolean; sessionTitle?: string; sessionID?: string; history?: RunPrompt[] }): Promise<void>
}

// Gracefully tears down the renderer. Order matters: switch external output
// back to passthrough before leaving split-footer mode, so pending stdout
// doesn't get captured into the now-dead scrollback pipeline.
function shutdown(renderer: CliRenderer): void {
  if (renderer.isDestroyed) {
    return
  }

  if (renderer.externalOutputMode === "capture-stdout") {
    renderer.externalOutputMode = "passthrough"
  }

  if (renderer.screenMode === "split-footer") {
    renderer.screenMode = "main-screen"
  }

  if (!renderer.isDestroyed) {
    renderer.destroy()
  }
}

function splashTitle(title: string | undefined, history: RunPrompt[]) {
  if (title && !isFallbackTitle(title)) return title
  return history.find((item) => item.text.trim().length > 0)?.text ?? title
}

function directoryLabel(directory: string, home: string) {
  const resolved = path.resolve(directory)
  const display =
    resolved === home ? "~" : resolved.startsWith(`${home}${path.sep}`) ? resolved.replace(home, "~") : resolved
  return display.replaceAll("\\", "/")
}

function queueSplash(
  renderer: Pick<CliRenderer, "writeToScrollback" | "requestRender">,
  state: SplashState,
  phase: keyof SplashState,
  write: ScrollbackWriter | undefined,
): boolean {
  if (state[phase]) {
    return false
  }

  if (!write) {
    return false
  }

  state[phase] = true
  renderer.writeToScrollback(write)
  renderer.requestRender()
  return true
}

// Boots the split-footer renderer and constructs the RunFooter.
//
// The renderer starts in split-footer mode with captured stdout so that
// scrollback commits and footer repaints happen in the same frame. After
// the entry splash, RunFooter takes over the footer region.
export async function createRuntimeLifecycle(input: LifecycleInput): Promise<Lifecycle> {
  const footerTask = import("./footer")
  const tuiConfig = await input.tuiConfig
  const miniSettings = input.getMiniSettings?.() ?? resolveMiniSettings(tuiConfig)
  const mono = miniSettings.mono
  const renderer = await createCliRenderer({
    stdin: input.host.terminal.stdin,
    targetFps: 30,
    maxFps: 60,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
    exitOnCtrlC: false,
    useKittyKeyboard: mono
      ? { disambiguate: false, alternateKeys: false, events: false, allKeysAsEscapes: false, reportText: false }
      : { events: input.host.platform === "win32" },
    screenMode: "split-footer",
    footerHeight: FOOTER_HEIGHT,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    clearOnShutdown: false,
  })
  if (mono) renderer.on(CliRenderEvents.EXTERNAL_OUTPUT, monoSnapshot)
  let mounted: { setSessionTitle(title: string | undefined): void } | undefined
  const setTitle = (title?: string) => {
    mounted?.setSessionTitle(title)
    if (input.host.platform !== "linux") return
    if (!title || isFallbackTitle(title)) return renderer.setTerminalTitle("OpenCode")
    renderer.setTerminalTitle(`OC | ${title.length > 40 ? title.slice(0, 37) + "…" : title}`)
  }
  const theme = await resolveRunTheme(renderer, tuiConfig.theme, mono)
  renderer.setBackgroundColor(theme.background)
  const state: SplashState = {
    entry: false,
    exit: false,
  }
  const startup =
    miniSettings.splash === "show" && !mono && tuiConfig.animations !== false
      ? { version: input.host.version, detail: directoryLabel(input.getDirectory(), input.host.paths.home) }
      : undefined
  queueSplash(
    renderer,
    state,
    "entry",
    miniSettings.splash === "show" && !startup
      ? entrySplash({
          version: input.host.version,
          theme: theme.splash,
          detail: directoryLabel(input.getDirectory(), input.host.paths.home),
          mono,
        })
      : undefined,
  )
  await renderer.idle().catch(() => {})
  if (mono) renderer.off(CliRenderEvents.EXTERNAL_OUTPUT, monoSnapshot)

  const { RunFooter } = await footerTask
  let closed = false
  let sigintRegistered = false
  let detachSigintListener: (() => void) | undefined

  const footer = new RunFooter(renderer, {
    directory: input.getDirectory,
    findFiles: input.findFiles,
    agents: input.agents,
    references: input.references,
    skills: input.skills,
    agent: input.agent,
    modelLabel: input.model ? formatModelLabel(input.model, input.variant) : "Default model",
    model: input.model,
    variant: input.variant,
    first: input.first,
    history: input.history,
    theme,
    // The transcript always starts one row below the terminal's prior output,
    // even when the entry splash itself is hidden.
    wrote: true,
    startup,
    tuiConfig,
    leader: input.leader,
    miniSettings: {
      current: miniSettings,
      update: input.onMiniSettingChange,
    },
    onMonoChange: (mono) => {
      if (mono) {
        renderer.disableKittyKeyboard()
        return
      }
      renderer.enableKittyKeyboard(buildKittyKeyboardFlags({ events: input.host.platform === "win32" }))
    },
    onPermissionReply: input.onPermissionReply,
    onFormReply: input.onFormReply,
    onFormCancel: input.onFormCancel,
    onCycleVariant: input.onCycleVariant,
    onAgentSelect: input.onAgentSelect,
    onModelSelect: input.onModelSelect,
    onVariantSelect: input.onVariantSelect,
    onInterrupt: input.onInterrupt,
    onBackground: input.onBackground,
    onQueuedPromptAction: input.onQueuedPromptAction,
    listShells: input.listShells,
    killShell: input.killShell,
    onEditorOpen: async ({ value }) => {
      if (closed || renderer.isDestroyed) {
        return
      }

      await renderer.idle().catch(() => {})
      detachSigint()
      const detachIgnore = input.host.signals.sigint.subscribe(() => {})
      try {
        return await input.host.editor.open({
          value,
          cwd: input.getDirectory(),
          renderer,
          stdin: input.host.terminal.stdin,
        })
      } finally {
        detachIgnore()
        attachSigint()
      }
    },
    subscribeThemeSignal: input.host.signals.sigusr2.subscribe,
    onSubagentSelect: input.onSubagentSelect,
    onSubagentInterrupt: input.onSubagentInterrupt,
  })

  // The footer is the first sink that can hold the title; seed it with the
  // session's current one, then every later setTitle keeps both in step.
  mounted = footer
  setTitle(input.sessionTitle)

  const sigint = () => {
    footer.requestExit()
  }

  const attachSigint = () => {
    if (closed || sigintRegistered) {
      return
    }

    detachSigintListener = input.host.signals.sigint.subscribe(sigint)
    sigintRegistered = true
  }

  const detachSigint = () => {
    if (!sigintRegistered) {
      return
    }

    detachSigintListener?.()
    detachSigintListener = undefined
    sigintRegistered = false
  }

  attachSigint()

  // ctrl+z that reaches the process as a signal (cooked-mode tty VSUSP)
  // becomes a clean exit, never a stopped process: a stopped mini keeps its
  // pane hostage (terminal kill confirmation) and its renderer would repaint
  // at a stale anchor. In raw mode ctrl+z arrives as a key event and is
  // handled by the keymap layer instead; this handler covers the rest.
  const onTstpSignal = () => {
    footer.close()
  }
  process.on("SIGTSTP", onTstpSignal)

  // Unclaimed keys (zom fork): a key event that survives the keymap (no
  // defaultPrevented / propagationStopped) and is not printable composer
  // input used to be handed to the shell by writing its raw bytes to
  // ZOM_PASSTHROUGH_FILE and closing mini. That made every unbound key a
  // trapdoor — with the kitty keyboard protocol enabled, perfectly ordinary
  // keys arrive as CSI u sequences mini does not bind, and pressing one
  // killed the composer mid-edit.
  //
  // New default: unclaimed keys never close mini. Each one is appended to a
  // rolling log (ZOM_UNCLAIMED_LOG, default "${ZOM_PASSTHROUGH_FILE}.keys.log"
  // when the widget sets the passthrough file) with its stroke, source and
  // raw bytes hex, so a swallowed key is diagnosable after the fact. The log
  // is capped at ZOM_UNCLAIMED_LOG_CAP bytes (default 64 KiB) by keeping the
  // newest tail.
  //
  // The old exit-and-replay path survives only as an explicit allowlist:
  // ZOM_PASSTHROUGH_KEYS="ctrl+r,ctrl+q" makes exactly those strokes write
  // their raw bytes to ZOM_PASSTHROUGH_FILE and close mini, for users who
  // want a key to take effect in the shell instead.
  const passthroughFile = process.env.ZOM_PASSTHROUGH_FILE
  const unclaimedLog = process.env.ZOM_UNCLAIMED_LOG ?? (passthroughFile ? `${passthroughFile}.keys.log` : undefined)
  const unclaimedLogCap = Number(process.env.ZOM_UNCLAIMED_LOG_CAP ?? 65536) || 65536
  const passthroughKeys = new Set(
    (process.env.ZOM_PASSTHROUGH_KEYS ?? "")
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean),
  )
  let detachPassthrough: (() => void) | undefined
  if (unclaimedLog || (passthroughFile && passthroughKeys.size > 0)) {
    const strokeOf = (event: KeyEvent) => {
      const parts: string[] = []
      if (event.ctrl) parts.push("ctrl")
      if (event.shift) parts.push("shift")
      if (event.meta || event.option) parts.push("meta")
      if (event.super) parts.push("super")
      if (event.hyper) parts.push("hyper")
      parts.push(event.name === " " ? "space" : event.name.toLowerCase())
      return parts.join("+")
    }
    const logUnclaimed = (event: KeyEvent, stroke: string) => {
      if (!unclaimedLog) return
      const line = JSON.stringify({
        at: new Date().toISOString(),
        stroke,
        source: event.source ?? "unknown",
        raw: Buffer.from(event.raw ?? "", "binary").toString("hex"),
      })
      try {
        appendFileSync(unclaimedLog, line + "\n")
        const size = statSync(unclaimedLog).size
        if (size > unclaimedLogCap) {
          const keep = readFileSync(unclaimedLog).subarray(-Math.floor(unclaimedLogCap / 2))
          writeFileSync(unclaimedLog, keep)
        }
      } catch {
        // An unwritable log must never disturb the composer.
      }
    }
    const onPassthroughKey = (event: KeyEvent) => {
      if (event.defaultPrevented || event.propagationStopped) {
        return
      }
      const printable =
        (event.name.length === 1 || event.name === "space") &&
        !event.ctrl &&
        !event.meta &&
        !event.option &&
        !event.super
      if (printable) {
        return
      }
      // Escape participates in pending-sequence handling and modal dismissal;
      // with nothing pending it is unclaimed by design. Never log or forward
      // it — a stray Esc is routine, not a lost key.
      if (event.name === "escape") {
        return
      }
      // Component useKeyboard handlers (permission dialog enter/arrows, the
      // command palette, forms) sit on this same keyInput bus but register
      // later, so their preventDefault() has not run yet when this listener
      // fires. Decide only after the dispatch settles: a key a dialog claims
      // must never be treated as unclaimed.
      const stroke = strokeOf(event)
      setImmediate(() => {
        if (event.defaultPrevented || event.propagationStopped) {
          return
        }
        logUnclaimed(event, stroke)
        if (passthroughFile && passthroughKeys.has(stroke)) {
          try {
            appendFileSync(passthroughFile, Buffer.from(event.raw ?? "", "binary"))
          } catch {
            // Unwritable passthrough target must not block the exit path.
          }
          footer.close()
        }
      })
    }
    renderer.keyInput.on("keypress", onPassthroughKey)
    detachPassthrough = () => {
      renderer.keyInput.off("keypress", onPassthroughKey)
    }
  }

  const close = async (next: {
    showExit: boolean
    sessionTitle?: string
    sessionID?: string
    history?: RunPrompt[]
  }) => {
    if (closed) {
      return
    }

    closed = true
    detachSigint()
    detachPassthrough?.()
    process.off("SIGTSTP", onTstpSignal)
    // Startup queries the kitty keyboard protocol (CSI ? u); WezTerm treats
    // the query as protocol detection and starts encoding keys kitty-style
    // until it sees the pop (CSI < u). opentui never pops — destroy resets
    // modifyOtherKeys, bracketed paste, and mode 2031 but leaves kitty and
    // mode 2027 on, so ctrl combos land in the shell as literal "20;5u".
    // Write the pops in the process exit hook: stdout is back to direct
    // writes by then, and an empty pop stack is ignored per spec.
    try {
      if (process.stdout.isTTY) {
        process.once("exit", () => {
          try {
            writeSync(1, "\x1b[<u\x1b[?2027l")
          } catch {
            // Terminal already gone.
          }
        })
      }
    } catch {
      // Non-TTY contexts (tests, pipes) need nothing.
    }
    let wroteExit = false

    try {
      footer.finishStartup()
      await footer.idle().catch(() => {})

      if (!renderer.isDestroyed && next.showExit && footer.currentMiniSettings().splash === "show") {
        const sessionID = next.sessionID || input.getSessionID?.() || input.sessionID
        wroteExit = queueSplash(
          renderer,
          state,
          "exit",
          exitSplash({
            title: splashTitle(next.sessionTitle ?? input.sessionTitle, next.history ?? input.history),
            session_id: sessionID,
            theme: footer.currentTheme().splash,
            mono: footer.currentMiniSettings().mono,
          }),
        )
        await renderer.idle().catch(() => {})
      }
    } finally {
      footer.close()
      await footer.idle().catch(() => {})
      footer.destroy()
      if (input.host.platform === "linux") renderer.setTerminalTitle("")
      shutdown(renderer)
      if (!wroteExit) {
        input.host.stdout.write("\n")
      }
    }
  }

  return {
    footer,
    refreshTheme() {
      footer.refreshTheme()
    },
    setTitle,
    onResize(fn) {
      let width = renderer.terminalWidth
      let height = renderer.terminalHeight
      const resize = () => {
        if (width === renderer.terminalWidth && height === renderer.terminalHeight) {
          return
        }

        width = renderer.terminalWidth
        height = renderer.terminalHeight
        fn()
      }
      renderer.on(CliRenderEvents.RESIZE, resize)
      return () => renderer.off(CliRenderEvents.RESIZE, resize)
    },
    async resetForReplay(splash = true) {
      if (closed || renderer.isDestroyed || footer.isClosed) {
        throw new Error("runtime closed")
      }

      await footer.idle()
      if (closed || renderer.isDestroyed || footer.isClosed) {
        throw new Error("runtime closed")
      }

      footer.resetForReplay(true)
      renderer.resetSplitFooterForReplay({ clearSavedLines: true })
      // 手动重灌（ctrl+l）不重印启动图：那会把每次清屏都变成一次「重新开张」。
      if (splash) {
        renderer.writeToScrollback(
          entrySplash({
            version: input.host.version,
            theme: footer.currentTheme().splash,
            detail: directoryLabel(input.getDirectory(), input.host.paths.home),
            mono: footer.currentMiniSettings().mono,
          }),
        )
      }
      renderer.requestRender()
      await renderer.idle().catch(() => {})
    },
    close,
  }
}
