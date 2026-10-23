// openslimedit v2 — token compression for opencode v2
// Port of ASidorenkoCode/openslimedit v1.0.4 to the v2 plugin API.
// Features: slim tool descriptions, line-range edit, result compaction.
//
// 2026-09-25 (opencode 2.0.16 rework): the old design wrapped
// event.tools[...].execute from the session "context" event. In 2.0.16
// context-event tools are bare definitions ({description, input}) with no
// execute function, so that silently no-oped (and it also checked v1's
// `filePath` field — v2 edit uses `path`). Line-range conversion now runs
// in ctx.tool.hook("execute.before"), which exists in both 2.0.12 and
// 2.0.16 and mutates a.input before the tool executes.
// Description slimming via event.tools mutation still works in 2.0.16
// (verified: the slimmed descriptions reach the model — e.g. the edit tool
// advertises the line-range form only because of this plugin).
//
// 2026-10-13: result compaction RE-ENABLED. v1 upstream compacted
// "Edit applied successfully." -> "OK", relativized <path> tags in read
// output, and stripped <type> tags + "(End of file - total N lines)"
// footers. v2.0.x results never use those v1 markers (results are plain
// text), so the original regexes were dead — that is why the drop happened.
// ctx.tool.hook("execute.after") has existed since 2.0.12 (the event carries
// event.tool and a mutable event.result; for built-in tools
// result.output is the exact string the model sees), so the v1 semantics
// are re-added as v2-format-aware rewrites:
//   - edit: "Edited <path> (N replacement)" -> "OK"   (v1: -> "OK"; the
//     model already knows which file it edited)
//   - read: "Read file <abs path>, lines X-Y" header -> relative path
//     (v1's headline feature; only for paths under the session directory —
//     v2 reads routinely target files outside the project, where "../.."
//     chains would be less readable than the absolute path)
// v1's type-tag / EOF-footer stripping has no v2 counterpart (those markers
// do not exist in v2 result text).
//
// 2026-10-13 (cont.): description slimming now also covers v2-native `shell`
// and `webfetch` — v1's bash/fetch entries were dead (v2.0.x has no tools by
// those names; apply_patch and list likewise). Dead v1 names removed; the map
// now holds exactly the built-in tools v2.0.27 exposes that have v1
// equivalents. (websearch: no v1 counterpart — intentionally unslimmed.)

import * as fs from "fs";
import * as path from "path";

const LINE_RANGE_RE = /^(\d+)(?:\s*-\s*(\d+))?$/;

const SLIM_DESC = {
  read: "Read file content.",
  edit: "Edit file. oldString can be line range '55-64'.",
  write: "Write file.",
  shell: "Run shell command.",
  glob: "Find files.",
  grep: "Search in files.",
  webfetch: "Fetch URL.",
};

export default {
  id: "openslimedit-v2",
  setup: async (ctx) => {
    // Kill switch (bench support): OPENSLIMEDIT_DISABLED=1 disables the whole
    // plugin at load time — used for plugin-OFF baseline token measurements.
    if (process.env.OPENSLIMEDIT_DISABLED === "1") return;

    const directory = ctx.location?.directory || process.cwd();

    function resolvePath(filePath) {
      if (path.isAbsolute(filePath)) return path.normalize(filePath);
      return path.resolve(directory, filePath);
    }

    // 1. Slim tool descriptions: 2.0.x context-event tools are plain
    //    {description, input} definitions; assigning .description reaches the
    //    model. (The no-op ctx.tool.transform placeholder from the v1 port is
    //    gone — the editor there cannot modify existing tools.)
    ctx.session.hook("context", async (event) => {
      const tools = event.tools;
      if (!tools || typeof tools !== "object") return;
      for (const name of Object.keys(tools)) {
        if (SLIM_DESC[name] && tools[name].description) {
          tools[name].description = SLIM_DESC[name];
        }
      }
    });

    if (typeof ctx.tool?.hook === "function") {
      // 2. Line-range edit: oldString "55-64" (or a single line "55") is
      //    replaced with the file's actual text before the edit runs. No-op
      //    when the literal text already exists (v1 semantics).
      await ctx.tool.hook("execute.before", async (a) => {
        if (a.tool !== "edit") return;
        const oldString = a.input?.oldString;
        const file = a.input?.path ?? a.input?.filePath; // v2: path; v1: filePath
        if (typeof oldString !== "string" || !oldString.trim() || typeof file !== "string") return;
        try {
          const content = fs.readFileSync(resolvePath(file), "utf-8");
          if (content.includes(oldString)) return; // literal match — leave as-is
          const match = oldString.trim().match(LINE_RANGE_RE);
          if (!match) return;
          const lines = content.split("\n");
          const startLine = parseInt(match[1], 10);
          const endLine = match[2] ? parseInt(match[2], 10) : startLine;
          if (startLine >= 1 && startLine <= endLine && endLine <= lines.length) {
            a.input = { ...a.input, oldString: lines.slice(startLine - 1, endLine).join("\n") };
          }
        } catch { /* file not readable — leave as-is */ }
      });

      // 3. Result compaction — v2-format-aware port of v1's "tool.execute.after".
      //    v2 results carry the model-visible text in result.content[0].text
      //    (result.output is a structured object, and v1-era markers like
      //    "Edit applied successfully." / <path> tags / EOF footers never
      //    appear in 2.0.x — that is why the original regexes were dead).
      //    v1 semantics mapped onto v2 shapes:
      //      edit "Edited <path> (N replacement)" (single line) -> "OK"
      //      read  "Read file <abs>" -> relative path when under `directory`
      //    Compaction is wrapped in try/catch: a bug here can never break
      //    tool results.
      await ctx.tool.hook("execute.after", async (event) => {
        try {
          if (event.status !== "completed") return;
          const r = event.result;
          if (!r || !Array.isArray(r.content) || r.content.length === 0) return;
          const part = r.content[0];
          if (!part || part.type !== "text" || typeof part.text !== "string" || !part.text) return;
          const out = part.text;
          let next = null;

          if (event.tool === "edit") {
            // v1: "Edit applied successfully. *" -> "OK" (single-line confirmation).
            if (!out.includes("\n") && /^Edited \S+ \(\d+ replacement/.test(out)) {
              next = "OK";
            }
          } else if (event.tool === "read") {
            // v1: relativize <path>; only shorten paths under `directory`
            // ("../.." chains for out-of-project reads stay absolute).
            const m = out.match(/^Read file (\S+)/);
            if (m && path.isAbsolute(m[1])) {
              const rel = path.relative(directory, path.normalize(m[1]));
              if (rel && !rel.startsWith("..")) {
                next = out.replace(m[1], rel, 1);
              }
            }
          }

          if (next !== null) {
            event.result = { ...r, content: [{ type: "text", text: next }, ...r.content.slice(1)] };
          }
        } catch { /* compaction bug must never break tool results */ }
      });
    } else {
      console.warn("[openslimedit] tool.hook API unavailable — line-range edit and result compaction disabled");
    }
  },
};
