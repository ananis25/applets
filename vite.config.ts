import { defineConfig } from "vite-plus";

export default defineConfig({
  // The router imports `docs/*.md` as text, which wrangler does with a `Text` rule; this does the same for its tests.
  plugins: [
    {
      name: "markdown-as-text",
      transform: (code: string, id: string) =>
        id.endsWith(".md") ? `export default ${JSON.stringify(code)};` : undefined,
    },
  ],
  fmt: {
    ignorePatterns: [
      "README.md",
      "docs/**",
      "packages/ui/src/components/ui/**",
      "packages/editor/src/routeTree.gen.ts",
      "tools/**",
      ".vite-hooks/**",
      "**/*.config.{js,cjs,mjs,ts,cts,mts}",
      "**/{package,tsconfig,wrangler}.json*",
      "**/wrangler.local.jsonc",
    ],
  },
  lint: {
    ignorePatterns: [
      "examples/**",
      "packages/ui/src/components/ui/**",
      "packages/editor/src/routeTree.gen.ts",
      "tools/**",
      ".vite-hooks/**",
      "**/*.config.{js,cjs,mjs,ts,cts,mts}",
    ],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "anti-slop/require-sync-comment-for-use-effect": "error",
    },
    // React's rules only where React is: elsewhere Effect's `.use(...)` reads as the `use` hook.
    overrides: [
      {
        files: ["packages/editor/**", "packages/ui/**"],
        plugins: ["react"],
        rules: {
          "react/rules-of-hooks": "error",
          "react/exhaustive-deps": "error",
        },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
  staged: {
    "packages/**/*.{js,jsx,ts,tsx}": "vp check --fix",
  },
  // Scripts are not cached: most of them deploy, and a cache hit replays the output without running.
  run: {
    cache: { scripts: false },
  },
});
