# Upstream provenance

- source: `https://github.com/dmmulroy/anti-slop`
- revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- source path: `skills/install-anti-slop/assets/anti-slop/`
- installed path: `tools/oxlint/anti-slop/`

The generic plugin is enabled in `vite.config.ts`. The optional Effect plugin
is vendored but disabled because no workspace package directly depends on
Effect.

## Local additions

- `rules/require-sync-comment-for-use-effect.ts`: not upstream. Every effect
  hook needs a `SYNC:` comment naming the outside system it keeps in sync.
