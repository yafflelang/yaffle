// The C# conformance host: a long-running process that compiles each case directory's generated
// code (plus its externs and harness) in memory with Roslyn, loads it into a collectible
// AssemblyLoadContext and runs its cases. One JSON request per stdin line, one JSON response per
// stdout line. Started and fed by packages/compiler/src/backends/csharp/conformance.ts.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Yaffle.Harness;

public static class Host
{
    private static List<MetadataReference>? references;

    private static List<MetadataReference> References()
    {
        if (references is not null) return references;
        var tpa = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator);
        references = tpa.Where(p => p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();
        // The runner and the runtime, in case they are not in the trusted platform assemblies.
        foreach (var a in new[] { typeof(Runner).Assembly, typeof(Yaffle.Runtime.Reader).Assembly })
        {
            if (!tpa.Contains(a.Location)) references.Add(MetadataReference.CreateFromFile(a.Location));
        }
        return references;
    }

    public static int Main()
    {
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.InvariantCulture;
        var stdout = Console.Out;
        Console.SetOut(Console.Error);
        string? line;
        while ((line = Console.In.ReadLine()) is not null)
        {
            if (line.Length == 0) continue;
            JsonObject resp;
            int id = -1;
            try
            {
                var req = JsonNode.Parse(line)!.AsObject();
                id = req["id"]!.GetValue<int>();
                resp = Handle(req);
            }
            catch (Exception e)
            {
                resp = new JsonObject { ["ok"] = false, ["error"] = e.ToString() };
            }
            resp["id"] = id;
            stdout.WriteLine(resp.ToJsonString());
            stdout.Flush();
        }
        return 0;
    }

    private static JsonObject Handle(JsonObject req)
    {
        var sources = req["sources"]!.AsArray().Select(s => s!.GetValue<string>()).ToList();
        var entry = req["entry"]!.GetValue<string>();
        var casesFile = req["cases"]!.GetValue<string>();
        var resultsDir = req["results"]!.GetValue<string>();
        var mode = req["mode"]!.GetValue<string>();
        var parse = new CSharpParseOptions(LanguageVersion.CSharp13);
        var trees = sources.Select(p => CSharpSyntaxTree.ParseText(File.ReadAllText(p), parse, p)).ToList();
        var options = new CSharpCompilationOptions(
            OutputKind.DynamicallyLinkedLibrary,
            nullableContextOptions: NullableContextOptions.Enable,
            optimizationLevel: OptimizationLevel.Release,
            concurrentBuild: true);
        var comp = CSharpCompilation.Create($"YaffleCase{req["id"]}", trees, References(), options);
        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        if (!emit.Success)
        {
            var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Take(20).Select(d => d.ToString());
            return new JsonObject { ["ok"] = false, ["error"] = "compile errors:\n" + string.Join("\n", errors) };
        }
        ms.Position = 0;
        var alc = new AssemblyLoadContext($"case{req["id"]}", isCollectible: true);
        try
        {
            var asm = alc.LoadFromStream(ms);
            var type = asm.GetType(entry) ?? throw new InvalidOperationException($"no type {entry}");
            var run = type.GetMethod("Run", BindingFlags.Public | BindingFlags.Static) ?? throw new InvalidOperationException("no Run method");
            run.Invoke(null, new object[] { casesFile, resultsDir, mode });
        }
        catch (TargetInvocationException e)
        {
            return new JsonObject { ["ok"] = false, ["error"] = (e.InnerException ?? e).ToString() };
        }
        finally
        {
            alc.Unload();
        }
        return new JsonObject { ["ok"] = true };
    }
}
