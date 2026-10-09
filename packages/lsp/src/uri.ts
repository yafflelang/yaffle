/**
 * URI ↔ absolute path conversion. The language service identifies files by absolute filesystem
 * paths; LSP uses URIs. The conversion is written by hand (not `url.fileURLToPath`) so both path
 * flavours can be handled and tested on any OS:
 *
 * - `file:///c%3A/x/a.yfl` and `file:///C:/x/a.yfl` both become `c:\x\a.yfl` on win32 (drive
 *   letters are lowercased, as VS Code's `fsPath` does, so one file has one path).
 * - `file://server/share/a.yfl` becomes the UNC path `\\server\share\a.yfl` on win32.
 * - Paths become VS Code-style URIs: drive letter lowercase, `:` encoded as `%3A`, and everything
 *   outside `[A-Za-z0-9-._~/]` percent-encoded.
 *
 * Non-file URIs (`untitled:Untitled-1`, …) get a stable virtual path under a reserved root, and
 * map back to the original URI through {@link UriMapper}.
 */
import * as nodePath from "node:path";

export type Platform = "posix" | "win32";

export function currentPlatform(): Platform {
  return process.platform === "win32" ? "win32" : "posix";
}

export function pathApi(platform: Platform): typeof nodePath.posix {
  return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/** Decode %XX escapes; malformed escapes are kept as written instead of throwing. */
function percentDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/(%[0-9A-Fa-f]{2})+/g, run => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

/** Encode one path segment the way vscode-uri does (RFC 3986 unreserved characters stay). */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    c => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function encodePath(path: string): string {
  return path.split("/").map(encodeSegment).join("/");
}

/** The scheme of a URI (lowercased), or undefined when it has none. */
export function uriScheme(uri: string): string | undefined {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri);
  return match?.[1]?.toLowerCase();
}

/**
 * Convert a `file:` URI to an absolute path in the given platform's flavour. Returns undefined for
 * other schemes.
 */
export function fileUriToPath(uri: string, platform: Platform): string | undefined {
  if (uriScheme(uri) !== "file") return undefined;
  let rest = uri.slice("file:".length);
  const cut = rest.search(/[?#]/);
  if (cut >= 0) rest = rest.slice(0, cut);
  let authority = "";
  if (rest.startsWith("//")) [authority, rest] = splitAuthority(rest.slice(2));
  authority = percentDecode(authority);
  if (authority.toLowerCase() === "localhost") authority = "";
  let path = percentDecode(rest);
  if (path === "") path = "/";

  if (platform === "win32") {
    path = path.replace(/\\/g, "/");
    if (authority) {
      return nodePath.win32.normalize(`\\\\${authority}${path.replace(/\//g, "\\")}`);
    }
    const drive = /^\/?([A-Za-z]):(.*)$/.exec(path);
    if (drive) {
      const tail = drive[2] === "" ? "/" : drive[2]!;
      return nodePath.win32.normalize(`${drive[1]!.toLowerCase()}:${tail.replace(/\//g, "\\")}`);
    }
    return nodePath.win32.normalize(path.replace(/\//g, "\\"));
  }
  if (authority) return `//${authority}${nodePath.posix.normalize(path)}`;
  return nodePath.posix.normalize(path);
}

/** Convert an absolute path to a `file:` URI (VS Code style). */
export function pathToFileUri(path: string, platform: Platform): string {
  let p = path;
  if (platform === "win32") {
    const driveRoot = (_m: string, drive: string, tail: string) =>
      `/${drive.toLowerCase()}:${tail || "/"}`;
    p = p.replace(/\\/g, "/").replace(/^([A-Za-z]):(.*)$/, driveRoot);
  }
  if (!p.startsWith("/")) p = "/" + p;
  if (!p.startsWith("//")) return `file://${encodePath(p)}`;
  const [authority, tail] = splitAuthority(p.slice(2));
  const host = encodeSegment(authority);
  return `file://${platform === "win32" ? host.toLowerCase() : host}${encodePath(tail)}`;
}

/** Split what follows the `//` of a UNC path or URI into the authority and the path. */
function splitAuthority(rest: string): [authority: string, path: string] {
  const slash = rest.indexOf("/");
  return slash < 0 ? [rest, "/"] : [rest.slice(0, slash), rest.slice(slash)];
}

/** Normalize an absolute path: separators, `.`/`..`, and lowercase win32 drive letters. */
export function normalizePath(path: string, platform: Platform): string {
  const api = pathApi(platform);
  let p = api.normalize(path);
  if (platform === "win32") {
    p = p.replace(/^([A-Za-z]):/, (_m: string, d: string) => `${d.toLowerCase()}:`);
  }
  if (p.length > 1 && (p.endsWith("/") || (platform === "win32" && p.endsWith("\\")))) {
    // Keep roots ("/", "c:\", "\\server\share\") intact.
    if (api.dirname(p) !== p) p = p.slice(0, -1);
  }
  return p;
}

/** A key for comparing paths: case-insensitive on win32. */
export function pathKey(path: string, platform: Platform): string {
  return platform === "win32" ? path.toLowerCase() : path;
}

/** Whether `child` is `parent` or inside it. Both must be normalized. */
export function isPathInside(child: string, parent: string, platform: Platform): boolean {
  const api = pathApi(platform);
  const rel = api.relative(pathKey(parent, platform), pathKey(child, platform));
  return rel === "" || (!rel.startsWith("..") && !api.isAbsolute(rel));
}

/**
 * Bidirectional mapping between document URIs and service paths. Remembers the exact URI string
 * the client used for each path, so diagnostics and locations go back in the client's spelling
 * (`file:///C:/x` stays `file:///C:/x` even though the path is `c:\x`).
 */
export class UriMapper {
  readonly platform: Platform;
  private readonly known = new Map<string, string>();
  private readonly virtualRoot: string;

  constructor(platform: Platform) {
    this.platform = platform;
    this.virtualRoot = platform === "win32" ? "\\\\yaffle-virtual\\" : "/__yaffle_virtual__/";
  }

  /** The path for a URI. Non-file URIs get a virtual path. */
  toPath(uri: string): string {
    const filePath = fileUriToPath(uri, this.platform);
    if (filePath !== undefined) return normalizePath(filePath, this.platform);
    const scheme = uriScheme(uri) ?? "unknown";
    const rest = uri.slice(scheme.length + 1).replace(/^\/+/, "");
    const safe = percentDecode(rest).replace(/[^A-Za-z0-9._-]+/g, "_") || "document";
    const sep = this.platform === "win32" ? "\\" : "/";
    return `${this.virtualRoot}${scheme}${sep}${safe}`;
  }

  /** Remember the client's spelling of a URI (for open documents and other client-sent URIs). */
  remember(uri: string): string {
    const path = this.toPath(uri);
    this.known.set(this.key(path), uri);
    return path;
  }

  /** Forget a URI's spelling. Virtual paths keep theirs: it is the only way back to the URI. */
  forget(uri: string): void {
    const path = this.toPath(uri);
    const key = this.key(path);
    if (this.known.get(key) === uri && !this.isVirtual(path)) this.known.delete(key);
  }

  isVirtual(path: string): boolean {
    return this.key(path).startsWith(this.key(this.virtualRoot));
  }

  /** The URI for a service path: the remembered client spelling, else a canonical file URI. */
  toUri(path: string): string {
    return this.known.get(this.key(path)) ?? pathToFileUri(path, this.platform);
  }

  key(path: string): string {
    return pathKey(path, this.platform);
  }
}
