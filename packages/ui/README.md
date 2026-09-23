# @applets/ui

The shared design system. See "The design system" in `docs/architecture.md` for how a page uses it.

- `src/globals.css` is the theme: Tailwind, shadcn's tokens with a tweakcn theme, and `@source` so any importer's build scans these components
- `src/components/ui/` are shadcn components on Base UI, added with `vpx shadcn@latest add <name>` (style `base-vega`)
- `src/vite.ts` exports `ui()`, the Vite plugin list every page spreads in
- `components.json` tells the shadcn CLI to write imports as `@applets/ui/...`, so files work unchanged from any package
