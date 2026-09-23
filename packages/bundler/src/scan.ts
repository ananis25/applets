/**
 * What the bundler reads out of an applet's source before esbuild sees it:
 * the exports of `main.ts`, the `npm:` specifiers, and the import rules
 * between server, client and shared code. Only static imports are scanned.
 */
import { parse } from "es-module-lexer/js";

export type Scan = {
  readonly exports: ReadonlyArray<string>;
  readonly dependencies: Record<string, string>;
  readonly clientEntry: string | undefined;
};

export type ScanResult = Scan | { readonly errors: ReadonlyArray<string> };

const sourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

export const isSourceFile = (path: string): boolean =>
  sourceExtensions.some((extension) => path.endsWith(extension));

const clientEntries = ["client/main.tsx", "client/main.ts"];

/** The fallback for JSX and TSX, which es-module-lexer cannot read. */
const staticImport = /^([ \t]*(?:(?:import|export)\b[^'"]*?\bfrom|import)\s*)(['"])([^'"]+)\2/gm;

const namedExport =
  /^[ \t]*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

const listExport = /^[ \t]*export\s*\{([^}]*)\}/gm;

/** Parses `npm:@scope/name@^1.2/sub`; a missing range reads as `*` and a missing subpath as `""`. */
export function parseNpmSpecifier(
  specifier: string,
): { name: string; range: string; subpath: string } | undefined {
  if (!specifier.startsWith("npm:")) return undefined;

  const body = specifier.slice("npm:".length);
  const segments = body.split("/");
  const scoped = body.startsWith("@");
  const head = scoped ? segments.slice(0, 2).join("/") : segments[0];

  if (head === undefined || (scoped && segments.length < 2)) return undefined;

  const separator = head.lastIndexOf("@");
  const name = separator > 0 ? head.slice(0, separator) : head;
  const range = separator > 0 ? head.slice(separator + 1) : "*";

  if (name === "" || name === "@" || range === "") return undefined;

  return { name, range, subpath: body.slice(head.length) };
}

type Import = { readonly specifier: string; readonly start: number; readonly end: number };

/** Static imports and export-from specifiers, with source positions for rewriting. */
function importsOf(text: string): Array<Import> {
  try {
    const [imports] = parse(text);

    return imports.flatMap((entry): Array<Import> =>
      entry.d === -1 && entry.n !== undefined
        ? [{ specifier: entry.n, start: entry.s, end: entry.e }]
        : [],
    );
  } catch {
    return [...text.matchAll(staticImport)].flatMap((match): Array<Import> => {
      const [, prefix, quote, specifier] = match;

      if (prefix === undefined || quote === undefined || specifier === undefined) return [];

      const start = (match.index ?? 0) + prefix.length + quote.length;

      return [{ specifier, start, end: start + specifier.length }];
    });
  }
}

const specifiersOf = (text: string): Array<string> => [
  ...new Set(importsOf(text).map((entry) => entry.specifier)),
];

function exportsOf(text: string): Array<string> {
  const found = new Set<string>();

  for (const match of text.matchAll(namedExport)) if (match[1] !== undefined) found.add(match[1]);

  for (const match of text.matchAll(listExport)) {
    for (const item of (match[1] ?? "").split(",")) {
      const exported = item
        .trim()
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();

      if (exported) found.add(exported);
    }
  }

  return [...found];
}

const isClientPath = (path: string): boolean => path === "client" || path.startsWith("client/");

const isStd = (specifier: string): boolean => specifier === "@std";

const isRelative = (specifier: string): boolean =>
  specifier.startsWith("./") || specifier.startsWith("../");

/** Where a relative specifier lands, as a path relative to the applet directory. */
function resolveRelative(fromPath: string, specifier: string): string {
  const segments = fromPath.split("/").slice(0, -1);

  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    else if (segment === "..") segments.pop();
    else segments.push(segment);
  }

  return segments.join("/");
}

const isBuiltin = (specifier: string): boolean =>
  specifier.startsWith("node:") || specifier.startsWith("cloudflare:");

/** Rewrites `npm:zod@3/v4` to `zod/v4` and `@std` to the bundled copy, leaving everything else untouched. */
export function rewriteSpecifiers(path: string, text: string, stdModule: string): string {
  const depth = path.split("/").length - 1;
  const stdPath = `${depth === 0 ? "./" : "../".repeat(depth)}${stdModule}`;

  const bare = (specifier: string): string => {
    if (isStd(specifier)) return stdPath;

    const npm = parseNpmSpecifier(specifier);

    return npm === undefined ? specifier : `${npm.name}${npm.subpath}`;
  };

  let rewritten = text;

  for (const entry of importsOf(text).reverse()) {
    const replacement = bare(entry.specifier);

    if (replacement !== entry.specifier)
      rewritten = `${rewritten.slice(0, entry.start)}${replacement}${rewritten.slice(entry.end)}`;
  }

  return rewritten;
}

/** Reads the exports, the dependency map and the client entry, or the list of rule violations. */
export function scan(files: Record<string, string>): ScanResult {
  const errors: Array<string> = [];
  const dependencies: Record<string, string> = {};
  const main = files["main.ts"];

  if (main === undefined) return { errors: ["main.ts is missing"] };

  const exports = exportsOf(main);

  if (!exports.includes("fetch")) errors.push("main.ts must export fetch");

  for (const [path, text] of Object.entries(files)) {
    if (!isSourceFile(path)) continue;

    const inClient = isClientPath(path);

    for (const specifier of specifiersOf(text)) {
      if (inClient && isStd(specifier)) {
        errors.push(
          `${path}: client code must not import "@std". Put anything both sides need in "shared/".`,
        );
        continue;
      }

      if (!inClient && isRelative(specifier) && isClientPath(resolveRelative(path, specifier))) {
        errors.push(
          `${path}: server code must not import "${specifier}" from "client/". Put anything both sides need in "shared/".`,
        );
        continue;
      }

      if (isRelative(specifier) || isStd(specifier) || isBuiltin(specifier)) continue;

      if (specifier.startsWith("http:") || specifier.startsWith("https:")) {
        errors.push(`${path}: URL import "${specifier}" is not allowed. Use an "npm:" specifier.`);
        continue;
      }

      const npm = parseNpmSpecifier(specifier);

      if (npm === undefined) {
        errors.push(
          specifier.startsWith("npm:")
            ? `${path}: import "${specifier}" is not a valid "npm:" specifier.`
            : `${path}: import "${specifier}" must carry the "npm:" prefix.`,
        );
        continue;
      }

      const seen = dependencies[npm.name];

      if (seen !== undefined && seen !== npm.range) {
        errors.push(
          `${path}: import "${specifier}" asks for "${npm.name}@${npm.range}" but "${seen}" is already required elsewhere.`,
        );
        continue;
      }

      dependencies[npm.name] = npm.range;
    }
  }

  if (errors.length > 0) return { errors };

  return {
    exports,
    dependencies,
    clientEntry: clientEntries.find((entry) => entry in files),
  };
}
