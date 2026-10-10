using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;
using System.Text;

namespace Yaffle.Runtime;

/// <summary>
/// Derived arrays: <c>map</c>, <c>filter</c>, <c>indicesWhere</c>, <c>sortedBy</c>,
/// <c>unique</c> and <c>concat</c> in computed fields and checks, and the conversions that store
/// their results in typed fields.
/// </summary>
public static class Arrays
{
    private static IReadOnlyList<T> Items<T>(IReadOnlyList<T>? xs) =>
        xs ?? throw new YaffleException(ErrorCode.INPUT, "expected an array, got null");

    /// <summary><c>map(arr, x => expr)</c>.</summary>
    public static List<TOut> Map<TIn, TOut>(IReadOnlyList<TIn>? xs, Func<TIn, TOut> f)
    {
        var a = Items(xs);
        var out_ = new List<TOut>(a.Count);
        foreach (var x in a) out_.Add(f(x));
        return out_;
    }

    /// <summary><c>filter(arr, x => bool)</c>: the matching elements, in order.</summary>
    public static List<T> Filter<T>(IReadOnlyList<T>? xs, Func<T, bool> f)
    {
        var a = Items(xs);
        var out_ = new List<T>();
        foreach (var x in a) if (f(x)) out_.Add(x);
        return out_;
    }

    /// <summary><c>indicesWhere(arr, x => bool)</c>: the indices of the matching elements.</summary>
    public static List<Int128> IndicesWhere<T>(IReadOnlyList<T>? xs, Func<T, bool> f)
    {
        var a = Items(xs);
        var out_ = new List<Int128>();
        for (int i = 0; i < a.Count; i++) if (f(a[i])) out_.Add(i);
        return out_;
    }

    /// <summary><c>sortedBy(arr, x => key)</c>: a stable sort by key (<see cref="CompareKeys"/>).</summary>
    public static List<T> SortedBy<T, TKey>(IReadOnlyList<T>? xs, Func<T, TKey> key)
    {
        var a = Items(xs);
        var keyed = new List<(TKey Key, int Index, T Value)>(a.Count);
        for (int i = 0; i < a.Count; i++) keyed.Add((key(a[i]), i, a[i]));
        keyed.Sort((x, y) =>
        {
            int c = CompareKeys(x.Key, y.Key);
            return c != 0 ? c : x.Index.CompareTo(y.Index);
        });
        var out_ = new List<T>(a.Count);
        foreach (var k in keyed) out_.Add(k.Value);
        return out_;
    }

    /// <summary>
    /// Order of sort keys: numbers numerically, strings by code point, bytes lexicographically,
    /// false before true. Other keys are an INPUT error.
    /// </summary>
    public static int CompareKeys(object? a, object? b)
    {
        if (IsInt(a) && IsInt(b)) return ToInt128(a!).CompareTo(ToInt128(b!));
        if (IsNumber(a) && IsNumber(b)) return ToDouble(a!).CompareTo(ToDouble(b!));
        if (a is string sa && b is string sb) return CompareCodePoints(sa, sb);
        if (a is bool ba && b is bool bb) return ba.CompareTo(bb);
        if (a is byte[] xa && b is byte[] xb) return xa.AsSpan().SequenceCompareTo(xb);
        throw new YaffleException(ErrorCode.INPUT, $"cannot compare sort keys {Err.Describe(a)} and {Err.Describe(b)}");
    }

    /// <summary>Compares strings by Unicode code point (not UTF-16 code unit).</summary>
    public static int CompareCodePoints(string a, string b)
    {
        var ea = a.EnumerateRunes();
        var eb = b.EnumerateRunes();
        while (true)
        {
            bool ha = ea.MoveNext(), hb = eb.MoveNext();
            if (!ha || !hb) return ha == hb ? 0 : ha ? 1 : -1;
            int c = ea.Current.Value.CompareTo(eb.Current.Value);
            if (c != 0) return c;
        }
    }

    /// <summary><c>unique(arr)</c>: without later duplicates (value equality; the first occurrence is kept).</summary>
    public static List<T> Unique<T>(IReadOnlyList<T>? xs)
    {
        var a = Items(xs);
        var out_ = new List<T>();
        HashSet<T>? seen = typeof(T).IsValueType || typeof(T) == typeof(string) ? new HashSet<T>() : null;
        foreach (var x in a)
        {
            if (seen is not null)
            {
                if (seen.Add(x)) out_.Add(x);
                continue;
            }
            bool dup = false;
            foreach (var y in out_)
            {
                if (Values.Eq(x, y))
                {
                    dup = true;
                    break;
                }
            }
            if (!dup) out_.Add(x);
        }
        return out_;
    }

    /// <summary><c>concat(a, b, …)</c>: arrays joined in order.</summary>
    public static List<T> Concat<T>(params IReadOnlyList<T>?[] xs)
    {
        var out_ = new List<T>();
        foreach (var x in xs) out_.AddRange(Items(x));
        return out_;
    }

    /// <summary>A derived array of integers stored in a <c>u8[]</c> field (RANGE for a value that is not a byte).</summary>
    public static byte[] ToBytes<T>(IReadOnlyList<T>? xs)
    {
        if (xs is byte[] b) return b;
        var a = Items(xs);
        var out_ = new byte[a.Count];
        for (int i = 0; i < a.Count; i++)
        {
            object? x = a[i];
            if (!IsInt(x)) throw new YaffleException(ErrorCode.INPUT, $"element {i} is not an integer: {Err.Describe(x)}");
            var v = ToInt128(x!);
            if (v < 0 || v > 255) throw new YaffleException(ErrorCode.RANGE, $"{v} is not a byte (element {i})");
            out_[i] = (byte)v;
        }
        return out_;
    }

    /// <summary>A derived array of integers stored in an integer array field (RANGE per element).</summary>
    public static List<T> CastInts<T>(IEnumerable? xs) where T : IBinaryInteger<T>
    {
        if (xs is null) throw new YaffleException(ErrorCode.INPUT, "expected an array, got null");
        if (xs is List<T> same) return same;
        var out_ = new List<T>();
        foreach (var x in xs)
        {
            if (!IsInt(x)) throw new YaffleException(ErrorCode.INPUT, $"expected an integer, got {Err.Describe(x)}");
            var v = ToInt128(x!);
            try
            {
                out_.Add(T.CreateChecked(v));
            }
            catch (OverflowException)
            {
                throw new YaffleException(ErrorCode.RANGE, $"{v} is out of range for {typeof(T).Name}");
            }
        }
        return out_;
    }

    /// <summary>An array of values as a list of <typeparamref name="T"/> (elements of another static type).</summary>
    public static List<T> Cast<T>(IEnumerable? xs)
    {
        if (xs is null) throw new YaffleException(ErrorCode.INPUT, "expected an array, got null");
        if (xs is List<T> same) return same;
        var out_ = new List<T>();
        foreach (var x in xs) out_.Add(x is T t ? t : Values.As<T>(x));
        return out_;
    }

    private static bool IsInt(object? o) =>
        o is byte or sbyte or ushort or short or uint or int or ulong or long or Int128 or BigInteger;

    private static bool IsNumber(object? o) => IsInt(o) || o is double or float or Half;

    private static Int128 ToInt128(object o) => o switch
    {
        byte x => x,
        sbyte x => x,
        ushort x => x,
        short x => x,
        uint x => x,
        int x => x,
        ulong x => x,
        long x => x,
        Int128 x => x,
        BigInteger x => (Int128)x,
        _ => throw new YaffleException(ErrorCode.INPUT, $"expected an integer, got {Err.Describe(o)}")
    };

    private static double ToDouble(object o) => o switch
    {
        double d => d,
        float f => f,
        Half h => (double)h,
        _ => (double)ToInt128(o)
    };
}
