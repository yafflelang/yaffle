using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Yaffle.Runtime;

/// <summary>Stable error codes (docs/CONFORMANCE.md §4).</summary>
public enum ErrorCode
{
    /// <summary>Not enough bytes.</summary>
    EOF,
    /// <summary>A check failed (constant, <c>in</c>, <c>where</c>, strict padding, bool, enum, encoding, switch).</summary>
    CHECK,
    /// <summary>An integer out of range for its destination, division by zero, a negative length.</summary>
    RANGE,
    /// <summary>No union variant matched.</summary>
    UNION,
    /// <summary>A codec, extern type or extern function failed.</summary>
    CODEC,
    /// <summary>Invalid input value on write.</summary>
    INPUT,
    /// <summary>A derived value contradicts the data.</summary>
    DERIVE,
    /// <summary>A <c>@ref</c> pointer has no equal placed value.</summary>
    REF,
    /// <summary>Fixed placements overlap, or a stream piece doesn't fit its block.</summary>
    OVERLAP
}

/// <summary>
/// Every failure the runtime or generated code reports: a stable <see cref="Code"/>, the
/// <see cref="Path"/> from the root (field names and array indices) and an absolute byte
/// <see cref="Offset"/> (-1 on write).
/// </summary>
public sealed class YaffleException : Exception
{
    private readonly List<object> path;

    /// <summary>The error code.</summary>
    public ErrorCode Code { get; }

    /// <summary>Field names (<see cref="string"/>) and array indices (<see cref="long"/>) from the root.</summary>
    public IReadOnlyList<object> Path => path;

    /// <summary>Absolute byte offset for read errors, -1 for write errors.</summary>
    public long Offset { get; }

    /// <summary>The message without path and offset decoration.</summary>
    public string Detail { get; }

    /// <summary>For <see cref="ErrorCode.UNION"/>: the error of every variant, in order.</summary>
    public IReadOnlyList<YaffleException>? Causes { get; }

    /// <summary>The path is complete (errors raised after layout know their full path).</summary>
    private bool sealed_;

    public YaffleException(ErrorCode code, string detail, long offset = -1, IEnumerable<object>? path = null,
        IReadOnlyList<YaffleException>? causes = null)
        : base(detail)
    {
        Code = code;
        Detail = detail;
        Offset = offset;
        this.path = path is null ? new List<object>() : new List<object>(path);
        Causes = causes;
    }

    /// <summary>Renders <c>CODE at a.b[3] (offset 0x10): detail</c>.</summary>
    public override string Message
    {
        get
        {
            var sb = new StringBuilder();
            sb.Append(Code.ToString());
            if (path.Count > 0) sb.Append(" at ").Append(FormatPath(path));
            if (Offset >= 0) sb.Append(" (offset 0x").Append(Offset.ToString("x", CultureInfo.InvariantCulture)).Append(')');
            sb.Append(": ").Append(Detail);
            return sb.ToString();
        }
    }

    /// <summary>Formats a path as <c>a.b[3].c</c>.</summary>
    public static string FormatPath(IEnumerable<object> path)
    {
        var sb = new StringBuilder();
        foreach (var seg in path)
        {
            if (seg is string s)
            {
                if (sb.Length > 0) sb.Append('.');
                sb.Append(s);
            }
            else sb.Append('[').Append(Convert.ToString(seg, CultureInfo.InvariantCulture)).Append(']');
        }
        return sb.ToString();
    }

    /// <summary>
    /// Prepends a frame's segments: a field, then the indices of the arrays being read inside it
    /// (outermost first). Returns false, so generated code can call it from exception filters.
    /// </summary>
    public bool Prefix(string field, params long[] indices)
    {
        if (sealed_) return false;
        var segs = new List<object>(1 + indices.Length) { field };
        foreach (var i in indices) segs.Add(i);
        path.InsertRange(0, Segments(segs));
        return false;
    }

    /// <summary>Prepends a complete path and seals it (no further prefixes are added).</summary>
    internal void SealWith(IEnumerable<object> fullPath)
    {
        if (sealed_) return;
        path.InsertRange(0, Segments(fullPath));
        sealed_ = true;
    }

    /// <summary>The real segments of a path: empty field names and negative indices mean "none".</summary>
    internal static List<object> Segments(IEnumerable<object> raw)
    {
        var out_ = new List<object>();
        foreach (var s in raw)
        {
            if (s is string str && str.Length == 0) continue;
            if (s is long l && l < 0) continue;
            out_.Add(s);
        }
        return out_;
    }
}

/// <summary>Helpers that create or throw <see cref="YaffleException"/>s.</summary>
public static class Err
{
    /// <summary>Throws and is typed as any value (for use in expressions).</summary>
    public static T Fail<T>(ErrorCode code, string detail, long offset = -1) => throw new YaffleException(code, detail, offset);

    /// <summary>A missing required input field: INPUT with the field as its path.</summary>
    public static YaffleException Missing(string field) =>
        new(ErrorCode.INPUT, $"missing required field {field}", -1, new object[] { field });

    /// <summary>
    /// Wraps a host failure (codec, extern type, extern fn) as CODEC, unless it already is a
    /// <see cref="YaffleException"/> or an internal control signal.
    /// </summary>
    public static Exception Host(Exception e, string what, long offset = -1)
    {
        if (e is YaffleException || e is ControlSignal) return e;
        return new YaffleException(ErrorCode.CODEC, $"{what}: {e.Message}", offset);
    }

    /// <summary>A short description of a value for messages.</summary>
    public static string Describe(object? v)
    {
        switch (v)
        {
            case null: return "null";
            case string s: return "\"" + (s.Length > 40 ? s[..40] + "…" : s) + "\"";
            case byte[] b: return $"bytes({b.Length})";
            case System.Collections.ICollection c: return $"array({c.Count})";
            case IFormattable f: return f.ToString(null, CultureInfo.InvariantCulture);
            default: return v.ToString() ?? "object";
        }
    }
}

/// <summary>Internal control-flow exceptions that must never be converted into errors.</summary>
public abstract class ControlSignal : Exception
{
    protected ControlSignal(string message) : base(message) { }
}

/// <summary>The result of a safe parse: a value or an error.</summary>
public readonly struct SafeResult<T>
{
    public bool Ok { get; }
    public T? Value { get; }
    public YaffleException? Error { get; }

    private SafeResult(bool ok, T? value, YaffleException? error)
    {
        Ok = ok;
        Value = value;
        Error = error;
    }

    public static SafeResult<T> Success(T value) => new(true, value, null);
    public static SafeResult<T> Failure(YaffleException error) => new(false, default, error);
}
