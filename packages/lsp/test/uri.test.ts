import { describe, expect, it } from "vitest";
import {
  fileUriToPath,
  isPathInside,
  normalizePath,
  pathKey,
  pathToFileUri,
  UriMapper,
  uriScheme
} from "../src/uri.ts";

describe("fileUriToPath (posix)", () => {
  it.each([
    ["file:///home/me/a.yfl", "/home/me/a.yfl"],
    ["file:///home/me/My%20Formats/a%2Bb.yfl", "/home/me/My Formats/a+b.yfl"],
    ["file:///home/me/%F0%9F%90%A6.yfl", "/home/me/🐦.yfl"],
    ["file://localhost/etc/x.yfl", "/etc/x.yfl"],
    ["file:///a/./b/../c.yfl", "/a/c.yfl"],
    ["file:///a/b.yfl?query#frag", "/a/b.yfl"],
    ["FILE:///a/b.yfl", "/a/b.yfl"],
    ["file:/a/b.yfl", "/a/b.yfl"],
    ["file:///bad%zzescape.yfl", "/bad%zzescape.yfl"],
    ["file://server/share/x.yfl", "//server/share/x.yfl"]
  ])("%s → %s", (uri, path) => {
    expect(fileUriToPath(uri, "posix")).toBe(path);
  });

  it("returns undefined for other schemes", () => {
    expect(fileUriToPath("untitled:Untitled-1", "posix")).toBeUndefined();
    expect(fileUriToPath("vscode-notebook-cell:/x", "posix")).toBeUndefined();
  });
});

describe("fileUriToPath (win32)", () => {
  it.each([
    ["file:///c%3A/Users/me/a.yfl", "c:\\Users\\me\\a.yfl"],
    ["file:///C:/Users/me/a.yfl", "c:\\Users\\me\\a.yfl"],
    ["file:///c:/Users/me/My%20Formats/a.yfl", "c:\\Users\\me\\My Formats\\a.yfl"],
    ["file:///D%3A", "d:\\"],
    ["file:///d:/", "d:\\"],
    ["file://server/share/dir/a.yfl", "\\\\server\\share\\dir\\a.yfl"],
    ["file://localhost/c:/x.yfl", "c:\\x.yfl"],
    ["file:///c:/a/../b.yfl", "c:\\b.yfl"]
  ])("%s → %s", (uri, path) => {
    expect(fileUriToPath(uri, "win32")).toBe(path);
  });
});

describe("pathToFileUri", () => {
  it.each([
    ["/home/me/a.yfl", "file:///home/me/a.yfl"],
    ["/home/me/My Formats/a+b.yfl", "file:///home/me/My%20Formats/a%2Bb.yfl"],
    ["/home/me/(x)!*'.yfl", "file:///home/me/%28x%29%21%2A%27.yfl"],
    ["/home/me/🐦.yfl", "file:///home/me/%F0%9F%90%A6.yfl"],
    ["/a/b#c?d.yfl", "file:///a/b%23c%3Fd.yfl"]
  ])("posix %s → %s", (path, uri) => {
    expect(pathToFileUri(path, "posix")).toBe(uri);
  });

  it.each([
    ["c:\\Users\\me\\a.yfl", "file:///c%3A/Users/me/a.yfl"],
    ["C:\\Users\\me\\a.yfl", "file:///c%3A/Users/me/a.yfl"],
    ["c:\\My Formats\\a.yfl", "file:///c%3A/My%20Formats/a.yfl"],
    ["d:", "file:///d%3A/"],
    ["\\\\Server\\share\\a.yfl", "file://server/share/a.yfl"],
    ["c:/forward/slashes.yfl", "file:///c%3A/forward/slashes.yfl"]
  ])("win32 %s → %s", (path, uri) => {
    expect(pathToFileUri(path, "win32")).toBe(uri);
  });

  it("round-trips", () => {
    for (const path of ["/a b/c%d/é.yfl", "/x/y/z.yfl", "/🐦/[1].yfl"]) {
      expect(fileUriToPath(pathToFileUri(path, "posix"), "posix")).toBe(path);
    }
    for (const path of ["c:\\a b\\c%d\\é.yfl", "\\\\srv\\share\\x.yfl", "z:\\"]) {
      expect(fileUriToPath(pathToFileUri(path, "win32"), "win32")).toBe(path);
    }
  });
});

describe("helpers", () => {
  it("uriScheme", () => {
    expect(uriScheme("file:///x")).toBe("file");
    expect(uriScheme("Untitled:Untitled-1")).toBe("untitled");
    expect(uriScheme("/no/scheme")).toBeUndefined();
  });

  it("normalizePath", () => {
    expect(normalizePath("/a/b/../c/", "posix")).toBe("/a/c");
    expect(normalizePath("/", "posix")).toBe("/");
    expect(normalizePath("C:\\A\\.\\b\\", "win32")).toBe("c:\\A\\b");
    expect(normalizePath("c:\\", "win32")).toBe("c:\\");
  });

  it("pathKey is case-insensitive on win32 only", () => {
    expect(pathKey("C:\\A", "win32")).toBe(pathKey("c:\\a", "win32"));
    expect(pathKey("/A", "posix")).not.toBe(pathKey("/a", "posix"));
  });

  it("isPathInside", () => {
    expect(isPathInside("/ws/a/b.yfl", "/ws", "posix")).toBe(true);
    expect(isPathInside("/ws", "/ws", "posix")).toBe(true);
    expect(isPathInside("/wsx/a.yfl", "/ws", "posix")).toBe(false);
    expect(isPathInside("/a.yfl", "/ws", "posix")).toBe(false);
    expect(isPathInside("C:\\WS\\a.yfl", "c:\\ws", "win32")).toBe(true);
    expect(isPathInside("d:\\ws\\a.yfl", "c:\\ws", "win32")).toBe(false);
  });
});

describe("UriMapper", () => {
  it("remembers the client's spelling for open documents", () => {
    const m = new UriMapper("win32");
    const path = m.remember("file:///C:/Work/a.yfl");
    expect(path).toBe("c:\\Work\\a.yfl");
    expect(m.toUri("c:\\work\\A.yfl")).toBe("file:///C:/Work/a.yfl");
    m.forget("file:///C:/Work/a.yfl");
    expect(m.toUri("c:\\Work\\a.yfl")).toBe("file:///c%3A/Work/a.yfl");
  });

  it("maps non-file URIs to stable virtual paths and back", () => {
    for (const platform of ["posix", "win32"] as const) {
      const m = new UriMapper(platform);
      const path = m.remember("untitled:Untitled-1");
      expect(m.isVirtual(path)).toBe(true);
      expect(m.toPath("untitled:Untitled-1")).toBe(path);
      expect(m.toUri(path)).toBe("untitled:Untitled-1");
      // Virtual mappings survive close (diagnostics may still be cleared for them).
      m.forget("untitled:Untitled-1");
      expect(m.toUri(path)).toBe("untitled:Untitled-1");
      expect(m.isVirtual("/home/x.yfl")).toBe(false);
    }
    expect(new UriMapper("posix").toPath("untitled:Untitled-1")).toBe(
      "/__yaffle_virtual__/untitled/Untitled-1"
    );
    expect(new UriMapper("win32").toPath("vscode-vfs://github/x/y.yfl")).toBe(
      "\\\\yaffle-virtual\\vscode-vfs\\github_x_y.yfl"
    );
  });
});
