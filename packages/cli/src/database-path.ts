import path from "node:path"

// One session store. Upstream derives the database name from the build channel, so
// every build — and every branch-name fallback — gets its own opencode-<channel>.db,
// and whichever process starts the background service first decides which store the
// whole machine reads. Here the name is fixed; OPENCODE_DB still overrides the path
// for throwaway work such as exporting an archived store.
export function databasePath(data: string) {
  const filename = process.env.OPENCODE_DB ?? "opencode.db"
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
