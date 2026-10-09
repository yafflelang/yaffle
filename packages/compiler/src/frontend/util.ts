/** Small shared helpers. */

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[n]!;
}

/** The closest candidate within a reasonable edit distance. */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  const max = Math.max(name.length >= 3 ? 2 : 1, Math.floor(name.length / 3));
  for (const c of candidates) {
    if (!c || c === name) continue;
    const d = c.toLowerCase() === name.toLowerCase() ? 0.5 : levenshtein(name, c);
    if (d < bestD && d <= max && d < name.length) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

export function sanitizeIdent(s: string): string {
  let out = s.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!out) out = "_";
  if (/^[0-9]/.test(out)) out = "_" + out;
  return out;
}

/*
 * Paths. The compiler works with the path strings it is given: POSIX paths, win32 paths with a
 * (lowercased) drive letter and `\` or `/` separators, and the language server's virtual paths
 * (`/__yaffle_virtual__/…`, `\\yaffle-virtual\…`). These helpers keep a path's own separator
 * style and only resolve `.` and `..` segments, so an already-clean path is returned unchanged.
 */

/** The root of an absolute path (`/`, `c:/`, `c:\`, `\\server\share\`), or "" if relative. */
function rootOf(p: string): string {
  const m = /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)|[\\/])/.exec(p);
  return m ? m[0] : "";
}

function sepOf(p: string): string {
  return p.includes("\\") && !p.includes("/") ? "\\" : "/";
}

function isAbsolutePath(p: string): boolean {
  return rootOf(p) !== "";
}

export function normalizePath(p: string): string {
  const root = rootOf(p);
  const sep = sepOf(p);
  const parts: string[] = [];
  for (const seg of p.slice(root.length).split(/[\\/]/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!root) parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  const out = root + parts.join(sep);
  return out || (root ? root : ".");
}

export function dirname(p: string): string {
  const root = rootOf(p);
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i < root.length) return root || ".";
  return p.slice(0, i);
}

export function joinPath(dir: string, rel: string): string {
  if (isAbsolutePath(rel)) return normalizePath(rel);
  const sep = sepOf(dir);
  const r = sep === "\\" ? rel.replace(/\//g, "\\") : rel;
  return normalizePath(dir.endsWith("/") || dir.endsWith("\\") ? dir + r : `${dir}${sep}${r}`);
}

/** A relative path from directory `from` to `to`, always with `/` separators. */
export function relativePath(from: string, to: string): string {
  const a = normalizePath(from).split(/[\\/]/).filter(Boolean);
  const b = normalizePath(to).split(/[\\/]/).filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => "..");
  const rest = b.slice(i);
  const parts = [...up, ...rest];
  return parts.length ? parts.join("/") : ".";
}

export function commonDir(paths: string[]): string {
  if (!paths.length) return "/";
  const first = dirname(paths[0]!);
  const root = rootOf(first);
  const sep = sepOf(first);
  let parts = first.slice(root.length).split(/[\\/]/).filter(Boolean);
  for (const p of paths.slice(1)) {
    const d = dirname(p);
    if (rootOf(d) !== root) return root || "/";
    const q = d.slice(root.length).split(/[\\/]/).filter(Boolean);
    let i = 0;
    while (i < parts.length && i < q.length && parts[i] === q[i]) i++;
    parts = parts.slice(0, i);
  }
  return root + parts.join(sep) || "/";
}

/** Converts a glob (`**`, `*`, `?`, `{a,b}`) to a regex over `/`-separated relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  while (i < g.length) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "{") {
      const close = g.indexOf("}", i);
      if (close < 0) {
        re += "\\{";
        i++;
      } else {
        re +=
          "(?:" +
          g
            .slice(i + 1, close)
            .split(",")
            .map(s => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
            .join("|") +
          ")";
        i = close + 1;
      }
    } else {
      re += /[.+^$()|[\]\\]/.test(c) ? "\\" + c : c;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Expands `sources` globs below `rootDir` using a directory lister (entry names, directories with a
 * trailing `/`). Skips `node_modules` and dot-directories.
 */
export function expandGlobs(
  rootDir: string,
  patterns: string[],
  readDirectory: (path: string) => string[] | undefined
): string[] {
  const regexes = patterns.map(globToRegExp);
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 32) return;
    const entries = readDirectory(dir);
    if (!entries) return;
    for (const e of entries) {
      const isDir = e.endsWith("/");
      const name = isDir ? e.slice(0, -1) : e;
      const r = rel ? `${rel}/${name}` : name;
      if (isDir) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        walk(joinPath(dir, name), r, depth + 1);
      } else if (regexes.some(x => x.test(r))) out.push(joinPath(dir, name));
    }
  };
  walk(rootDir, "", 0);
  return out.sort();
}
