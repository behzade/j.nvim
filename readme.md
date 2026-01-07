# j.nvim

Personal journal CLI (`j`) plus a Neovim helper for search/tag/extract workflows.

## CLI

Run:
- `bun run dev`

Build + install:
- `bun run build` (writes `dist/j`)
- `bun run install:local` (installs `dist/j` to `~/.local/bin/j`)

Common usage:
- `j` opens today's entry (creates if missing)
- `j -3` or `j --offset=3` opens the entry from 3 days ago
- `j --date` / `-d` browse entries with fzf (optionally `--tag=work`)
- `j --search <text>` / `-s <text>` search by content (rg + fzf)
- `j --search <text> --json` JSON search results for scripts/plugins
- `j --timeline` / `-l` browse a timeline with previews (optionally `--tag=work`)
- `j --continue` / `-c` open the most recently opened entry or note
- `j --tag=work` browse entries for that tag
- `j --note=slug` / `-n slug` open a note
- `j --sections <source>` list sections for extraction
- `j --extract <source> --sections=1,3 --slug <target>` extract sections to a note
- `--json` output structured JSON and skip fzf/nvim (used by the plugin)
- `--limit <n>` cap JSON list/search results (default 200 for `--search --json`)

Source/section notes:
- `source` can be a date (`YYYY-MM-DD`), a note slug, `notes/<slug>`, or an absolute path.
- Sections are blocks separated by blank lines or separator lines (`---`, `***`, `___`).
- Tag matching looks only at line 2, either `tags:` or hashtags (e.g. `#work`).

External tools used by the CLI:
- `nvim` (opens with `+ZenMode` and sets `g:journal_mode=1`)
- `fzf` (interactive selection)
- `rg` (search)
- `bat` (preview, optional; falls back to `cat`)
- `sh`, `sed`, `tail`, `head` (preview helpers)

Data locations:
- Journal entries: `~/journal/YYYY-MM-DD.md`
- Notes: `~/journal/notes/*.md`
- State: `${XDG_STATE_HOME:-~/.local/state}/lm/j-state.json`

## Neovim plugin (lazy.nvim)

```lua
{
  "behzade/j.nvim",
  dependencies = {
    "folke/snacks.nvim",
    "folke/zen-mode.nvim",
  },
  config = function()
    require("journal").setup()
  end,
}
```

Keymaps:
- `<leader>jl` live search (shows latest 20 entries, narrows as you type)
- `<leader>jt` browse tags
- `<leader>jx` extract sections to a note

The plugin expects the `j` CLI to be available on PATH and uses `snacks.nvim` pickers.
