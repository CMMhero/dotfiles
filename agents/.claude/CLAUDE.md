# Global Instructions (WSL)

> Wires Claude Code into my canonical global instructions. Single source of truth
> lives at `~/AGENTS.md` — keep them in sync.

@~/AGENTS.md

## Package manager preference

Use **pnpm** by default instead of `npm`/`npx` or `bun` for installing dependencies, running scripts, and managing Node/TypeScript projects. Prefer `pnpm add`, `pnpm install`, `pnpm run`, and `pnpm dlx` over their npm/bun equivalents. In Vite+ projects prefer the `vp` wrappers (`vp install`, `vp add`, `vp dev`, `vp check`, `vp test`, `vp build`, `vp run`). Only fall back to npm/bun when a project explicitly requires it.

## Skills

- **unslop**: Use this skill for any non-code writing (docs, READMEs, blog posts, prose) to remove AI writing patterns and give text a natural, human voice. Invoke it when asked to humanize or clean up writing, or when producing user-facing prose.
- **herdr**: Use this skill to control Herdr (terminal multiplexer) — inspecting or managing panes, tabs, workspaces, and coding agents — but only when the user explicitly mentions Herdr or asks to use it. Don't reach for it just because background work is needed. Requires `HERDR_ENV=1`.
