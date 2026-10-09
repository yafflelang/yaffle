/**
 * Filesystem access for the server: reading files the editor hasn't opened (imports, yaffle.json,
 * sample files). Injectable so tests can run against an in-memory tree in either path flavour.
 */
import * as fs from "node:fs";
import type { ConfigHost } from "./config.ts";
import { pathApi, pathKey, type Platform } from "./uri.ts";

export interface FileSystem {
  /** Text contents (UTF-8), or undefined when missing or unreadable. */
  readFile(path: string): string | undefined;
  /** Raw bytes, or undefined when missing or unreadable. */
  readBinary(path: string): Uint8Array | undefined;
  /** Whether a regular file exists. */
  fileExists(path: string): boolean;
  /** Entry names of a directory (directories get a trailing "/"), or undefined. */
  readDirectory(path: string): string[] | undefined;
}

/** Text files as the editor sees them: unsaved contents of open documents over `fs`. */
export function withOverlay(
  fs: FileSystem,
  overlay: (path: string) => string | undefined
): ConfigHost {
  return {
    readFile: path => overlay(path) ?? fs.readFile(path),
    fileExists: path => overlay(path) !== undefined || fs.fileExists(path)
  };
}

export const nodeFileSystem: FileSystem = {
  readFile(path) {
    try {
      return fs.readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  readBinary(path) {
    try {
      return new Uint8Array(fs.readFileSync(path));
    } catch {
      return undefined;
    }
  },
  fileExists(path) {
    try {
      return fs.statSync(path).isFile();
    } catch {
      return false;
    }
  },
  readDirectory(path) {
    try {
      return fs
        .readdirSync(path, { withFileTypes: true })
        .map(e => (e.isDirectory() ? `${e.name}/` : e.name));
    } catch {
      return undefined;
    }
  }
};

/**
 * An in-memory filesystem (for tests and embedders). Paths are absolute in the given platform's
 * flavour; lookups are case-insensitive on win32.
 */
export class MemoryFileSystem implements FileSystem {
  readonly platform: Platform;
  private readonly files = new Map<string, { path: string; data: Uint8Array }>();

  constructor(platform: Platform, files: Record<string, string | Uint8Array> = {}) {
    this.platform = platform;
    for (const [path, data] of Object.entries(files)) this.write(path, data);
  }

  private key(path: string): string {
    return pathKey(pathApi(this.platform).normalize(path), this.platform);
  }

  write(path: string, data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.files.set(this.key(path), { path: pathApi(this.platform).normalize(path), data: bytes });
  }

  delete(path: string): void {
    this.files.delete(this.key(path));
  }

  readFile(path: string): string | undefined {
    const entry = this.files.get(this.key(path));
    return entry ? new TextDecoder().decode(entry.data) : undefined;
  }

  readBinary(path: string): Uint8Array | undefined {
    return this.files.get(this.key(path))?.data;
  }

  fileExists(path: string): boolean {
    return this.files.has(this.key(path));
  }

  readDirectory(path: string): string[] | undefined {
    const api = pathApi(this.platform);
    const dir = this.key(path);
    const names = new Set<string>();
    for (const [key, entry] of this.files) {
      const rel = api.relative(dir, key);
      if (rel === "" || rel.startsWith("..") || api.isAbsolute(rel)) continue;
      // Names in the spelling they were written with, not the case-folded key's.
      const first = api.relative(api.normalize(path), entry.path).split(api.sep)[0]!;
      names.add(rel.includes(api.sep) ? `${first}/` : first);
    }
    return names.size > 0 ? [...names].sort() : undefined;
  }
}
