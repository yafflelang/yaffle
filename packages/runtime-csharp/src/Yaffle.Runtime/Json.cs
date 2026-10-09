using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Yaffle.Runtime;

/// <summary>A JSON Pointer (RFC 6901) built lazily from its segments.</summary>
public sealed class JPath
{
    public static readonly JPath Root = new(null, null);

    private readonly JPath? parent;
    private readonly object? segment;
    private string? text;

    private JPath(JPath? parent, object? segment)
    {
        this.parent = parent;
        this.segment = segment;
        if (parent is null) text = "";
    }

    public JPath Field(string name) => new(this, name);

    public JPath Index(long i) => new(this, i);

    public override string ToString()
    {
        if (text is not null) return text;
        var segs = new List<object>();
        for (var p = this; p.parent is not null; p = p.parent) segs.Add(p.segment!);
        var sb = new StringBuilder();
        for (int i = segs.Count - 1; i >= 0; i--)
        {
            sb.Append('/');
            if (segs[i] is string s) sb.Append(s.Replace("~", "~0").Replace("/", "~1"));
            else sb.Append(Convert.ToString(segs[i], CultureInfo.InvariantCulture));
        }
        return text = sb.ToString();
    }
}

/// <summary>State for ToJson: where each object was first written, for <c>$ref</c>s.</summary>
public sealed class ToJsonCtx
{
    private readonly Dictionary<object, JPath> seen = new(ReferenceEqualityComparer.Instance);

    /// <summary>The <c>$ref</c> to emit if <paramref name="v"/> was already written; otherwise records it and returns null.</summary>
    public JsonNode? Ref(object? v, JPath path)
    {
        // Only objects and non-empty, non-byte arrays are shared (bytes and empty arrays are values).
        if (v is null || v is byte[] || v is string) return null;
        if (v is ICollection c && c.Count == 0) return null;
        if (seen.TryGetValue(v, out var prev)) return new JsonObject { ["$ref"] = prev.ToString() };
        seen[v] = path;
        return null;
    }

    /// <summary>An array (a <c>$ref</c> when it was written before).</summary>
    public JsonNode Arr<T>(List<T>? list, JPath path, Func<T, JPath, JsonNode?> f)
    {
        if (list is null) throw new YaffleException(ErrorCode.INPUT, "expected an array, got null");
        var r = Ref(list, path);
        if (r is not null) return r;
        var a = new JsonArray();
        for (int i = 0; i < list.Count; i++) a.Add(f(list[i], path.Index(i)));
        return a;
    }

    /// <summary>A struct (a <c>$ref</c> when it was written before).</summary>
    public JsonNode Struct<T>(T? v, JPath path, Func<T, ToJsonCtx, JPath, JsonObject> f) where T : class
    {
        if (v is null) throw new YaffleException(ErrorCode.INPUT, "expected an object, got null");
        return Ref(v, path) ?? f(v, this, path);
    }
}

/// <summary>State for FromJson: values by JSON pointer, to restore identity from <c>$ref</c>s.</summary>
public sealed class FromJsonCtx
{
    private readonly Dictionary<string, object> byPath = new();

    /// <summary>True if the document contains any <c>$ref</c> (registration is skipped otherwise).</summary>
    public bool HasRefs { get; }

    public FromJsonCtx(JsonNode? root) => HasRefs = ContainsRef(root);

    private static bool ContainsRef(JsonNode? j)
    {
        switch (j)
        {
            case JsonObject o:
                foreach (var kv in o)
                {
                    if (kv.Key == "$ref") return true;
                    if (ContainsRef(kv.Value)) return true;
                }
                return false;
            case JsonArray a:
                foreach (var x in a) if (ContainsRef(x)) return true;
                return false;
            default:
                return false;
        }
    }

    /// <summary>If <paramref name="j"/> is a <c>{ "$ref": … }</c> object, the referenced (earlier) value.</summary>
    public bool Deref(JsonNode? j, out object? value)
    {
        value = null;
        if (!HasRefs || j is not JsonObject o || o.Count != 1) return false;
        if (!o.TryGetPropertyValue("$ref", out var t) || t is not JsonValue tv || tv.GetValueKind() != JsonValueKind.String) return false;
        var target = tv.GetValue<string>();
        if (!byPath.TryGetValue(target, out value))
            throw new YaffleException(ErrorCode.INPUT, $"$ref {target} does not point at an earlier value");
        return true;
    }

    public T Register<T>(JPath path, T v)
    {
        if (HasRefs && v is not null) byPath[path.ToString()] = v;
        return v;
    }

    /// <summary>An array (or a <c>$ref</c> to one). Element errors get the index in their path.</summary>
    public List<T> Arr<T>(JsonNode? j, JPath path, Func<JsonNode?, JPath, T> f)
    {
        if (Deref(j, out var d)) return d as List<T> ?? throw new YaffleException(ErrorCode.INPUT, "$ref points at a value of another type");
        var a = Json.Arr(j);
        var out_ = new List<T>(a.Count);
        Register(path, out_);
        for (int i = 0; i < a.Count; i++)
        {
            try
            {
                out_.Add(f(a[i], path.Index(i)));
            }
            catch (YaffleException e)
            {
                e.Prefix("", i);
                throw;
            }
        }
        return out_;
    }

    /// <summary>A struct (or a <c>$ref</c> to one); <paramref name="f"/> registers the new object itself.</summary>
    public T Obj<T>(JsonNode? j, JPath path, Func<JsonNode?, JPath, T> f) where T : class
    {
        if (Deref(j, out var d)) return d as T ?? throw new YaffleException(ErrorCode.INPUT, "$ref points at a value of another type");
        return f(j, path);
    }
}

/// <summary>Canonical JSON conversions (docs/CONFORMANCE.md §3).</summary>
public static class Json
{
    public static string Describe(JsonNode? j) => j switch
    {
        null => "null",
        JsonObject => "object",
        JsonArray a => $"array({a.Count})",
        JsonValue v => v.GetValueKind() switch
        {
            JsonValueKind.String => "\"" + v.GetValue<string>() + "\"",
            _ => v.ToJsonString()
        },
        _ => "?"
    };

    private static YaffleException Input(string want, JsonNode? j) => new(ErrorCode.INPUT, $"expected {want}, got {Describe(j)}");

    private static bool TryNumber(JsonNode? j, out double d)
    {
        d = 0;
        if (j is not JsonValue v) return false;
        if (v.TryGetValue<JsonElement>(out var el))
        {
            if (el.ValueKind != JsonValueKind.Number) return false;
            d = el.GetDouble();
            return true;
        }
        if (v.TryGetValue<double>(out d)) return true;
        if (v.TryGetValue<long>(out var l)) { d = l; return true; }
        if (v.TryGetValue<ulong>(out var ul)) { d = ul; return true; }
        if (v.TryGetValue<int>(out var i)) { d = i; return true; }
        if (v.TryGetValue<uint>(out var ui)) { d = ui; return true; }
        if (v.TryGetValue<float>(out var f)) { d = f; return true; }
        if (v.TryGetValue<short>(out var s)) { d = s; return true; }
        if (v.TryGetValue<ushort>(out var us)) { d = us; return true; }
        if (v.TryGetValue<byte>(out var b)) { d = b; return true; }
        if (v.TryGetValue<sbyte>(out var sb)) { d = sb; return true; }
        return false;
    }

    private static bool TryString(JsonNode? j, out string s)
    {
        s = "";
        if (j is not JsonValue v) return false;
        if (v.TryGetValue<JsonElement>(out var el))
        {
            if (el.ValueKind != JsonValueKind.String) return false;
            s = el.GetString()!;
            return true;
        }
        if (v.TryGetValue<string>(out var str))
        {
            s = str;
            return true;
        }
        return false;
    }

    // ── from JSON ─────────────────────────────────────────────────────────────

    /// <summary>Integers of up to 48 bits: JSON numbers (a non-integer is RANGE, other types INPUT).</summary>
    public static long Int(JsonNode? j)
    {
        if (!TryNumber(j, out var d)) throw Input("an integer", j);
        if (Math.Floor(d) != d) throw new YaffleException(ErrorCode.RANGE, $"{d.ToString(CultureInfo.InvariantCulture)} is not an integer");
        if (d < -9.2233720368547758E18 || d >= 9.2233720368547758E18)
            throw new YaffleException(ErrorCode.RANGE, $"{d.ToString(CultureInfo.InvariantCulture)} is out of range");
        return (long)d;
    }

    /// <summary>56/64-bit integers: decimal strings.</summary>
    public static Int128 Big(JsonNode? j)
    {
        if (TryString(j, out var s) && IsDecimal(s))
        {
            if (s.Length > 30) throw new YaffleException(ErrorCode.RANGE, $"{s} is out of range");
            return Int128.Parse(s, CultureInfo.InvariantCulture);
        }
        throw Input("a decimal integer string", j);
    }

    public static double Float(JsonNode? j)
    {
        if (TryNumber(j, out var d)) return d;
        if (TryString(j, out var s))
        {
            switch (s)
            {
                case "NaN": return double.NaN;
                case "Infinity": return double.PositiveInfinity;
                case "-Infinity": return double.NegativeInfinity;
                case "-0": return -0.0;
            }
        }
        throw Input("a number", j);
    }

    public static bool Bool(JsonNode? j)
    {
        if (j is JsonValue v)
        {
            var k = v.GetValueKind();
            if (k == JsonValueKind.True) return true;
            if (k == JsonValueKind.False) return false;
        }
        throw Input("a boolean", j);
    }

    public static string Str(JsonNode? j) => TryString(j, out var s) ? s : throw Input("a string", j);

    public static byte[] Bytes(JsonNode? j) => TryString(j, out var s) ? Hex.Decode(s) : throw Input("a hex string", j);

    public static JsonArray Arr(JsonNode? j) => j as JsonArray ?? throw Input("an array", j);

    public static JsonObject Obj(JsonNode? j) => j as JsonObject ?? throw Input("an object", j);

    public static Endian Endian(JsonNode? j) => Str(j) switch
    {
        "le" => Runtime.Endian.Le,
        "be" => Runtime.Endian.Be,
        var s => throw new YaffleException(ErrorCode.INPUT, $"expected \"le\" or \"be\", got \"{s}\"")
    };

    /// <summary>
    /// An open enum's unknown value: a number, or a decimal string for 56/64-bit storage. Returns
    /// false when <paramref name="j"/> is not a number.
    /// </summary>
    public static bool TryOpenEnumValue(JsonNode? j, out Int128 value)
    {
        value = 0;
        if (TryNumber(j, out var d))
        {
            if (Math.Floor(d) != d) return false;
            value = (Int128)d;
            return true;
        }
        if (TryString(j, out var s) && IsDecimal(s) && s.Length <= 30)
        {
            value = Int128.Parse(s, CultureInfo.InvariantCulture);
            return true;
        }
        return false;
    }

    /// <summary>An optional minus sign followed by one or more ASCII digits.</summary>
    private static bool IsDecimal(string s)
    {
        int start = s.StartsWith('-') ? 1 : 0;
        return s.Length > start && !s.AsSpan(start).ContainsAnyExceptInRange('0', '9');
    }

    /// <summary>The member name of a JSON enum value, or null if it is not a string.</summary>
    public static string? EnumName(JsonNode? j) => TryString(j, out var s) ? s : null;

    // ── to JSON ───────────────────────────────────────────────────────────────

    public static JsonNode Num(long v) => JsonValue.Create(v);

    public static JsonNode Num(ulong v) => JsonValue.Create(v);

    /// <summary>56/64-bit integers as decimal strings.</summary>
    public static JsonNode BigStr(long v) => JsonValue.Create(v.ToString(CultureInfo.InvariantCulture));

    public static JsonNode BigStr(ulong v) => JsonValue.Create(v.ToString(CultureInfo.InvariantCulture));

    public static JsonNode BigStr(Int128 v) => JsonValue.Create(v.ToString(CultureInfo.InvariantCulture));

    public static JsonNode FloatJson(double x)
    {
        if (double.IsNaN(x)) return JsonValue.Create("NaN");
        if (double.IsPositiveInfinity(x)) return JsonValue.Create("Infinity");
        if (double.IsNegativeInfinity(x)) return JsonValue.Create("-Infinity");
        if (x == 0 && double.IsNegative(x)) return JsonValue.Create("-0");
        return JsonValue.Create(x);
    }

    public static JsonNode FloatJson(float x) => FloatJson((double)x);

    public static JsonNode FloatJson(Half x) => FloatJson(HalfBits.ToDouble(x));

    public static JsonNode OfBool(bool b) => JsonValue.Create(b);

    public static JsonNode OfStr(string s) => JsonValue.Create(s);

    public static JsonNode OfHex(byte[] b) => JsonValue.Create(Runtime.Hex.Encode(b));

    /// <summary>A union value <c>{ "type": …, "value": … }</c>.</summary>
    public static JsonNode Union(string type, JsonNode? value) => new JsonObject { ["type"] = type, ["value"] = value };

    /// <summary>A union from JSON: <c>{ type, value }</c>; errors in the value get the "value" segment.</summary>
    public static UnionValue UnionFrom(JsonNode? j, JPath path, Func<string, JsonNode?, JPath, object?> f)
    {
        var o = Obj(j);
        o.TryGetPropertyValue("type", out var t);
        if (!TryString(t, out var type)) throw new YaffleException(ErrorCode.INPUT, $"unknown union variant {Describe(t)}");
        o.TryGetPropertyValue("value", out var v);
        try
        {
            return new UnionValue(type, f(type, v, path.Field("value")));
        }
        catch (YaffleException e) when (!e.Detail.StartsWith("unknown union variant", StringComparison.Ordinal))
        {
            e.Prefix("value");
            throw;
        }
    }

    /// <summary>Best-effort JSON of an untyped value (fields whose type differs between branches).</summary>
    public static JsonNode? Any(object? v) => v switch
    {
        null => null,
        bool b => JsonValue.Create(b),
        string s => JsonValue.Create(s),
        byte[] b => OfHex(b),
        double d => FloatJson(d),
        float f => FloatJson(f),
        Half h => FloatJson(h),
        long l => JsonValue.Create(l),
        ulong u => JsonValue.Create(u),
        int i => JsonValue.Create(i),
        uint u => JsonValue.Create(u),
        short s => JsonValue.Create(s),
        ushort u => JsonValue.Create(u),
        byte b => JsonValue.Create(b),
        sbyte s => JsonValue.Create(s),
        JsonNode n => n.DeepClone(),
        _ => JsonValue.Create(v.ToString())
    };

    /// <summary>An untyped value from JSON (the JSON node itself).</summary>
    public static object? Any(JsonNode? j) => j?.DeepClone();

    // ── text ──────────────────────────────────────────────────────────────────

    private static readonly JsonSerializerOptions Compact = new()
    {
        WriteIndented = false,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    private static readonly JsonSerializerOptions Indented = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    /// <summary>Serializes a JSON value (compact by default).</summary>
    public static string Stringify(JsonNode? j, bool indented = false)
    {
        if (!indented)
        {
            var sw = new StringWriter(CultureInfo.InvariantCulture);
            WriteTo(j, sw);
            return sw.ToString();
        }
        return j is null ? "null" : j.ToJsonString(Indented);
    }

    /// <summary>
    /// Writes compact JSON text. Unlike System.Text.Json's writer, string values of any length are
    /// supported (hex of large byte fields), and lone surrogates are escaped as <c>\uXXXX</c>.
    /// </summary>
    public static void WriteTo(JsonNode? j, TextWriter w)
    {
        switch (j)
        {
            case null:
                w.Write("null");
                return;
            case JsonObject o:
            {
                w.Write('{');
                bool first = true;
                foreach (var kv in o)
                {
                    if (!first) w.Write(',');
                    first = false;
                    WriteString(kv.Key, w);
                    w.Write(':');
                    WriteTo(kv.Value, w);
                }
                w.Write('}');
                return;
            }
            case JsonArray a:
            {
                w.Write('[');
                for (int i = 0; i < a.Count; i++)
                {
                    if (i > 0) w.Write(',');
                    WriteTo(a[i], w);
                }
                w.Write(']');
                return;
            }
            default:
                if (TryString(j, out var s)) WriteString(s, w);
                else w.Write(j.ToJsonString(Compact));
                return;
        }
    }

    private static void WriteString(string s, TextWriter w)
    {
        w.Write('"');
        int run = 0;
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            bool plain = c >= 0x20 && c != '"' && c != '\\' && !char.IsSurrogate(c);
            if (!plain && char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
            {
                i++;
                continue;
            }
            if (plain) continue;
            w.Write(s.AsSpan(run, i - run));
            switch (c)
            {
                case '"': w.Write("\\\""); break;
                case '\\': w.Write("\\\\"); break;
                case '\n': w.Write("\\n"); break;
                case '\r': w.Write("\\r"); break;
                case '\t': w.Write("\\t"); break;
                default: w.Write($"\\u{(int)c:x4}"); break;
            }
            run = i + 1;
        }
        w.Write(s.AsSpan(run));
        w.Write('"');
    }

    /// <summary>Parses JSON text.</summary>
    public static JsonNode? Parse(string text) =>
        JsonNode.Parse(text, null, new JsonDocumentOptions { MaxDepth = 4096 });
}
