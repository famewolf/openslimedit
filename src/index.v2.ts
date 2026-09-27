// openslimedit v2 — port of the v1 plugin (src/index.ts) to the OpenCode 2.x plugin API.
// Default entry stays src/index.ts (v1); reference this entry on 2.x hosts (export "./v2").
// Verified on OpenCode 2.0.16. On pre-2.0 hosts the guards skip registration (no crash).
import * as fs from "fs"
import * as path from "path"

const LINE_RANGE_RE = /^(\d+)(?:\s*-\s*(\d+))?$/

const SLIM_DESC: Record<string, string> = {
  read: "Read file content.",
  edit: "Edit file. oldString can be line range '55-64'.",
  apply_patch: "Apply a patch to files.",
  write: "Write file.",
  bash: "Run shell command.",
  glob: "Find files.",
  grep: "Search in files.",
  list: "List directory.",
  fetch: "Fetch URL.",
}

export const OpenSlimeditV2Plugin = {
  id: "openslimedit-v2",
  setup: async (ctx: any) => {
    const directory = ctx?.location?.directory || process.cwd()

    function resolvePath(filePath: string): string {
      if (path.isAbsolute(filePath)) return path.normalize(filePath)
      return path.resolve(directory, filePath)
    }

    // 1. Slim tool descriptions (v2 context-event tools are {description, input}).
    if (ctx?.session && typeof ctx.session.hook === "function") {
      await ctx.session.hook("context", async (event: any) => {
        const tools = event?.tools
        if (!tools || typeof tools !== "object") return
        for (const name of Object.keys(tools)) {
          if (SLIM_DESC[name] && tools[name].description) {
            tools[name].description = SLIM_DESC[name]
          }
        }
      })
    }

    // 2. Line-range edit: rewrite oldString "55-64" -> real text before edit runs.
    if (ctx?.tool && typeof ctx.tool.hook === "function") {
      await ctx.tool.hook("execute.before", async (a: any) => {
        if (a.tool !== "edit") return
        const oldString = a.input?.oldString
        const file = a.input?.path ?? a.input?.filePath
        if (typeof oldString !== "string" || !oldString.trim() || typeof file !== "string") return
        try {
          const content = fs.readFileSync(resolvePath(file), "utf-8")
          if (content.includes(oldString)) return
          const match = oldString.trim().match(LINE_RANGE_RE)
          if (!match) return
          const lines = content.split("\n")
          const startLine = parseInt(match[1], 10)
          const endLine = match[2] ? parseInt(match[2], 10) : startLine
          if (startLine >= 1 && startLine <= endLine && endLine <= lines.length) {
            a.input = { ...a.input, oldString: lines.slice(startLine - 1, endLine).join("\n") }
          }
        } catch {
          // unreadable file — leave as-is
        }
      })
    } else {
      console.warn("[openslimedit] tool.hook API unavailable — line-range edit disabled")
    }
  },
}

export default OpenSlimeditV2Plugin
