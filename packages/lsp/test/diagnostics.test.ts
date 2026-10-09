import { afterEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./harness.ts";

let t: TestServer;
afterEach(() => t?.dispose());

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("push diagnostics", () => {
  it("publishes converted diagnostics with version, code, source and related info", async () => {
    t = await startTestServer({ workspaceFolders: ["/ws"] });
    const uri = await t.open("/ws/a.yfl", "struct A {\n  u32 ERROR\n  u8 HINT\n}\n", 7);
    const p = await t.waitForDiagnostics(uri, d => d.diagnostics.length > 0);
    expect(p.version).toBe(7);
    expect(p.diagnostics).toEqual([
      {
        range: { start: { line: 1, character: 6 }, end: { line: 1, character: 11 } },
        severity: 1,
        source: "yaffle",
        code: "fake-error",
        message: "Fake error on line 2",
        relatedInformation: [
          {
            location: {
              uri,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
            },
            message: "first line"
          }
        ]
      },
      {
        range: { start: { line: 2, character: 5 }, end: { line: 2, character: 9 } },
        severity: 4,
        source: "yaffle",
        code: "fake-hint",
        message: "Fake hint",
        tags: [1]
      }
    ]);
  });

  it("debounces rapid edits into one pass", async () => {
    t = await startTestServer({ delay: 80 });
    const uri = await t.open("/ws/a.yfl", "struct A {}\n");
    await t.settle();
    const fake = t.fakes[0]!;
    const before = fake.callsTo("getDiagnostics").length;
    const publishedBefore = t.published.length;
    for (let i = 1; i <= 6; i++) {
      await t.change("/ws/a.yfl", `struct A { ${"x".repeat(i)} }\n`);
      await sleep(5);
    }
    await t.change("/ws/a.yfl", "struct A { ERROR }\n");
    const p = await t.waitForDiagnostics(uri, d => d.diagnostics.length === 1);
    expect(p.version).toBe(8);
    await t.settle();
    expect(fake.callsTo("getDiagnostics").length - before).toBe(1);
    expect(t.published.length - publishedBefore).toBe(1);
    // Every edit still reached the service immediately (requests see fresh text).
    expect(fake.callsTo("updateFile").length).toBe(8);
  });

  it("doesn't re-publish unchanged diagnostics", async () => {
    t = await startTestServer();
    const uri = await t.open("/ws/a.yfl", "ERROR\n");
    await t.waitForDiagnostics(uri, d => d.diagnostics.length === 1);
    const count = t.publishedFor(uri).length;
    await t.change("/ws/a.yfl", "ERROR\n\n");
    await t.settle();
    expect(t.publishedFor(uri).length).toBe(count);
  });

  it("updates importers when an imported file changes (cross-file)", async () => {
    t = await startTestServer({ workspaceFolders: ["/ws"] });
    const a = await t.open("/ws/a.yfl", 'import { B } from "./b.yfl"\nstruct A {}\n');
    const b = await t.open("/ws/b.yfl", "struct B {}\n");
    await t.settle();
    expect(t.diagnostics(a)?.diagnostics ?? []).toEqual([]);

    await t.change("/ws/b.yfl", "struct B { ERROR }\n");
    const pa = await t.waitForDiagnostics(a, d => d.diagnostics.length === 1);
    expect(pa.diagnostics[0]!.code).toBe("import-has-errors");
    expect(pa.diagnostics[0]!.relatedInformation?.[0]?.location.uri).toBe(b);
    expect(
      (await t.waitForDiagnostics(b, d => d.diagnostics.length === 1)).diagnostics[0]!.code
    ).toBe("fake-error");

    await t.change("/ws/b.yfl", "struct B {}\n");
    await t.waitForDiagnostics(a, d => d.diagnostics.length === 0);
    await t.waitForDiagnostics(b, d => d.diagnostics.length === 0);
  });

  it("re-checks importers when an import closes and falls back to disk", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: { "/ws/b.yfl": "struct B { ERROR }\n" }
    });
    const a = await t.open("/ws/a.yfl", 'import { B } from "./b.yfl"\n');
    await t.waitForDiagnostics(a, d => d.diagnostics[0]?.code === "import-has-errors");
    await t.open("/ws/b.yfl", "struct B {}\n");
    await t.waitForDiagnostics(a, d => d.diagnostics.length === 0);
    await t.close("/ws/b.yfl");
    await t.waitForDiagnostics(a, d => d.diagnostics[0]?.code === "import-has-errors");
  });

  it("publishes diagnostics the service reports for other files, and clears them", async () => {
    t = await startTestServer();
    await t.open("/ws/a.yfl", "ELSEWHERE /ws/other.yfl\n");
    const p = await t.waitForDiagnostics("/ws/other.yfl", d => d.diagnostics.length === 1);
    expect(p.version).toBeUndefined();
    expect(p.diagnostics[0]).toMatchObject({
      code: "elsewhere",
      severity: 3,
      message: "Reported from /ws/a.yfl"
    });
    await t.change("/ws/a.yfl", "nothing\n");
    await t.waitForDiagnostics("/ws/other.yfl", d => d.diagnostics.length === 0);
  });

  it("clears a file's diagnostics when it closes", async () => {
    t = await startTestServer();
    const uri = await t.open("/ws/a.yfl", "ERROR\n");
    await t.waitForDiagnostics(uri, d => d.diagnostics.length === 1);
    await t.close("/ws/a.yfl");
    await t.waitForDiagnostics(uri, d => d.diagnostics.length === 0);
  });

  it("aborts a stale pass when an edit arrives mid-pass", async () => {
    t = await startTestServer({ delay: 5 });
    const paths = ["a", "b", "c", "d", "e", "f"].map(n => `/ws/${n}.yfl`);
    for (const p of paths) await t.open(p, "struct X {}\n");
    await t.settle();
    const fake = t.fakes[0]!;
    fake.diagnosticsDelayMs = 30;
    const before = fake.callsTo("getDiagnostics").length;
    await t.change("/ws/a.yfl", "struct X { y }\n");
    await sleep(50); // the pass is now busy in one of the first files
    await t.change("/ws/a.yfl", "ERROR\n");
    await t.waitForDiagnostics("/ws/a.yfl", d => d.diagnostics.length === 1, 5000);
    await t.settle();
    const calls = fake.callsTo("getDiagnostics").length - before;
    // Without aborting: 2 full passes = 12 calls.
    expect(calls).toBeLessThan(12);
    expect(calls).toBeGreaterThanOrEqual(6);
  });

  it("maps diagnostics of untitled documents back to their URI", async () => {
    t = await startTestServer();
    const uri = await t.open("untitled:Untitled-1", "ERROR\n");
    const p = await t.waitForDiagnostics(uri, d => d.diagnostics.length === 1);
    expect(p.uri).toBe("untitled:Untitled-1");
    const path = t.fakes[0]!.callsTo("updateFile")[0]!.args[0] as string;
    expect(path).toBe("/__yaffle_virtual__/untitled/Untitled-1");
  });

  it("publishes in the client's URI spelling", async () => {
    t = await startTestServer({ platform: "win32" });
    const uri = "file:///C:/Work/Formats/a.yfl";
    await t.open(uri, "ERROR\n");
    const p = await t.waitForDiagnostics(uri, d => d.diagnostics.length === 1);
    expect(p.uri).toBe(uri);
    expect(t.fakes[0]!.callsTo("updateFile")[0]!.args[0]).toBe("c:\\Work\\Formats\\a.yfl");
  });

  it("respects the configured delay from settings", async () => {
    t = await startTestServer({ delay: 10, configuration: { diagnostics: { delay: 300 } } });
    expect(t.server.currentSettings.diagnostics.delay).toBe(300);
    const uri = await t.open("/ws/a.yfl", "x\n");
    await t.settle();
    const start = Date.now();
    await t.change("/ws/a.yfl", "ERROR\n");
    await t.waitForDiagnostics(uri, d => d.diagnostics.length === 1);
    expect(Date.now() - start).toBeGreaterThanOrEqual(250);
  });
});
