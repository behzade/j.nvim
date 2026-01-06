# j.nvim

Personal journal CLI (`j`) plus a Neovim plugin for browsing notes.

## CLI

Runtime options:
- Bun: `bun run src/j/index.bun.ts`
- Node: `node --loader tsx src/j/index.node.ts`

Build outputs:
- Bun binary: `npm run build:bun` (writes `dist/j`)
- Node JS CLI: `npm run build:node` (writes `dist/index.node.js`)

Install to `~/.local/bin` (Node build):
- `npm run install:local`

External tools used by the CLI:
- `nvim` (to open entries)
- `fzf` (interactive selection)
- `rg` (search)
- `bat` (preview, optional; falls back to `cat`)

Data locations:
- Journal entries: `~/journal/YYYY-MM-DD.md`
- Notes: `~/journal/notes/*.md`
- State: `${XDG_STATE_HOME:-~/.local/state}/lm/j-state.json`

## Neovim plugin (lazy.nvim)

```lua
{
  "behzade/j.nvim",
  dependencies = {
    "folke/zen-mode.nvim",
    "folke/snacks.nvim",
  },
  config = function()
    require("journal").setup()
  end,
}
```

The plugin expects the `j` CLI to be available on PATH.
