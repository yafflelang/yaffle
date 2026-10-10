using System;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;

namespace Yaffle.Runtime;

/// <summary>Primitive kinds (docs/IR.md §2.3).</summary>
public enum Prim
{
    U8, U16, U24, U32, U40, U48, U56, U64,
    I8, I16, I24, I32, I40, I48, I56, I64,
    F16, F32, F64
}

/// <summary>Endianness of a value: the IR's <c>$endian</c>.</summary>
public enum Endian
{
    /// <summary>Little endian (the default at the root).</summary>
    Le,
    /// <summary>Big endian.</summary>
    Be
}

/// <summary>Facts about primitive kinds.</summary>
public static class Prims
{
    public static int Size(Prim p) => p switch
    {
        Prim.U8 or Prim.I8 => 1,
        Prim.U16 or Prim.I16 or Prim.F16 => 2,
        Prim.U24 or Prim.I24 => 3,
        Prim.U32 or Prim.I32 or Prim.F32 => 4,
        Prim.U40 or Prim.I40 => 5,
        Prim.U48 or Prim.I48 => 6,
        Prim.U56 or Prim.I56 => 7,
        _ => 8
    };

    public static bool Signed(Prim p) => p >= Prim.I8 && p <= Prim.I64;

    public static Int128 Min(Prim p) => Signed(p) ? -(Int128.One << (Size(p) * 8 - 1)) : Int128.Zero;

    public static Int128 Max(Prim p) =>
        Signed(p) ? (Int128.One << (Size(p) * 8 - 1)) - 1 : (Int128.One << (Size(p) * 8)) - 1;

    public static string Name(Prim p) => p.ToString().ToLowerInvariant();
}

/// <summary>
/// Integer semantics of generated expressions (docs/IR.md §6): exact arithmetic (the generator
/// picks long, Int128 or BigInteger from interval analysis), truncating division, <c>%</c> with
/// the dividend's sign, shift counts 0..63 and rounding half away from zero.
/// </summary>
public static class Num
{
    private static YaffleException DivisionByZero() => new(ErrorCode.RANGE, "division by zero");

    public static long Div(long a, long b)
    {
        if (b == 0) throw DivisionByZero();
        // long.MinValue / -1 throws in C#.
        return b == -1 ? -a : a / b;
    }

    public static Int128 Div(Int128 a, Int128 b) => b == 0 ? throw DivisionByZero() : a / b;

    public static BigInteger Div(BigInteger a, BigInteger b) => b.IsZero ? throw DivisionByZero() : BigInteger.Divide(a, b);

    public static long Mod(long a, long b)
    {
        if (b == 0) throw DivisionByZero();
        return b == -1 ? 0 : a % b;
    }

    public static Int128 Mod(Int128 a, Int128 b) => b == 0 ? throw DivisionByZero() : a % b;

    public static BigInteger Mod(BigInteger a, BigInteger b) => b.IsZero ? throw DivisionByZero() : BigInteger.Remainder(a, b);

    private static int ShiftCount(long n) =>
        n is >= 0 and <= 63 ? (int)n : throw new YaffleException(ErrorCode.RANGE, $"shift count {n} is not in 0..63");

    public static long Shl(long a, long n) => a << ShiftCount(n);
    public static Int128 Shl(Int128 a, long n) => a << ShiftCount(n);
    public static BigInteger Shl(BigInteger a, long n) => a << ShiftCount(n);
    public static long Shr(long a, long n) => a >> ShiftCount(n);
    public static Int128 Shr(Int128 a, long n) => a >> ShiftCount(n);
    public static BigInteger Shr(BigInteger a, long n) => a >> ShiftCount(n);

    /// <summary>Rounds half away from zero (RANGE for NaN, infinities and values outside 64 bits).</summary>
    public static long Round(double x) => ToLong(x, Math.Round(x, MidpointRounding.AwayFromZero), "round");

    /// <summary>Float to integer conversion (truncation), RANGE outside the 64-bit range.</summary>
    public static long Trunc(double x) => ToLong(x, Math.Truncate(x), "convert");

    private static long ToLong(double x, double r, string verb)
    {
        if (double.IsNaN(x) || double.IsInfinity(x)) throw new YaffleException(ErrorCode.RANGE, $"cannot {verb} {x} to an integer");
        if (r < -9.2233720368547758E18 || r >= 9.2233720368547758E18)
            throw new YaffleException(ErrorCode.RANGE, $"{x} is out of the integer range");
        return (long)r;
    }

    public static Int128 Abs(Int128 x) => x < 0 ? -x : x;
    public static BigInteger Abs(BigInteger x) => BigInteger.Abs(x);
    public static long Abs(long x) => x == long.MinValue ? throw new YaffleException(ErrorCode.RANGE, "abs overflow") : Math.Abs(x);

    public static BigInteger ParseBig(string s) => BigInteger.Parse(s, CultureInfo.InvariantCulture);
    public static Int128 ParseI128(string s) => Int128.Parse(s, CultureInfo.InvariantCulture);
}

/// <summary>
/// Range-checked conversions into typed locations (field values, lengths, offsets, arguments).
/// Out of range is a RANGE error (docs/IR.md §6).
/// </summary>
public static class Ck
{
    private static YaffleException Range(IFormattable v, string what, string type) =>
        new(ErrorCode.RANGE, $"{what} {v.ToString(null, CultureInfo.InvariantCulture)} is out of range for {type}");

    /// <summary>The value as an Int128 when it fits the primitive's range (RANGE otherwise).</summary>
    private static Int128 Fit<T>(T v, Prim kind, string what) where T : IBinaryInteger<T>
    {
        var x = Int128.CreateSaturating(v);
        return x >= Prims.Min(kind) && x <= Prims.Max(kind) ? x : throw Range(v, what, Prims.Name(kind));
    }

    public static byte U8<T>(T v, string what = "value") where T : IBinaryInteger<T> => (byte)Fit(v, Runtime.Prim.U8, what);
    public static sbyte I8<T>(T v, string what = "value") where T : IBinaryInteger<T> => (sbyte)Fit(v, Runtime.Prim.I8, what);
    public static ushort U16<T>(T v, string what = "value") where T : IBinaryInteger<T> => (ushort)Fit(v, Runtime.Prim.U16, what);
    public static short I16<T>(T v, string what = "value") where T : IBinaryInteger<T> => (short)Fit(v, Runtime.Prim.I16, what);
    public static uint U24<T>(T v, string what = "value") where T : IBinaryInteger<T> => (uint)Fit(v, Runtime.Prim.U24, what);
    public static int I24<T>(T v, string what = "value") where T : IBinaryInteger<T> => (int)Fit(v, Runtime.Prim.I24, what);
    public static uint U32<T>(T v, string what = "value") where T : IBinaryInteger<T> => (uint)Fit(v, Runtime.Prim.U32, what);
    public static int I32<T>(T v, string what = "value") where T : IBinaryInteger<T> => (int)Fit(v, Runtime.Prim.I32, what);
    public static ulong U40<T>(T v, string what = "value") where T : IBinaryInteger<T> => (ulong)Fit(v, Runtime.Prim.U40, what);
    public static long I40<T>(T v, string what = "value") where T : IBinaryInteger<T> => (long)Fit(v, Runtime.Prim.I40, what);
    public static ulong U48<T>(T v, string what = "value") where T : IBinaryInteger<T> => (ulong)Fit(v, Runtime.Prim.U48, what);
    public static long I48<T>(T v, string what = "value") where T : IBinaryInteger<T> => (long)Fit(v, Runtime.Prim.I48, what);
    public static ulong U56<T>(T v, string what = "value") where T : IBinaryInteger<T> => (ulong)Fit(v, Runtime.Prim.U56, what);
    public static long I56<T>(T v, string what = "value") where T : IBinaryInteger<T> => (long)Fit(v, Runtime.Prim.I56, what);
    public static ulong U64<T>(T v, string what = "value") where T : IBinaryInteger<T> => (ulong)Fit(v, Runtime.Prim.U64, what);
    public static long I64<T>(T v, string what = "value") where T : IBinaryInteger<T> => (long)Fit(v, Runtime.Prim.I64, what);

    // Lengths, counts and offsets (long in generated code)
    public static long Len(long v, string what = "length") =>
        v >= 0 ? v : throw new YaffleException(ErrorCode.RANGE, $"{what} {v} is negative");
    public static long Len(ulong v, string what = "length") =>
        v <= long.MaxValue ? (long)v : throw new YaffleException(ErrorCode.RANGE, $"{what} {v} is too large");
    public static long Len(Int128 v, string what = "length")
    {
        if (v < 0) throw new YaffleException(ErrorCode.RANGE, $"{what} {v} is negative");
        if (v > long.MaxValue) throw new YaffleException(ErrorCode.RANGE, $"{what} {v} is too large");
        return (long)v;
    }
    public static long Len(BigInteger v, string what = "length")
    {
        if (v.Sign < 0) throw new YaffleException(ErrorCode.RANGE, $"{what} {v} is negative");
        if (v > long.MaxValue) throw new YaffleException(ErrorCode.RANGE, $"{what} {v} is too large");
        return (long)v;
    }
    public static long Off(long v) => v;
    public static long Off(ulong v, string what = "offset") =>
        v <= long.MaxValue ? (long)v : throw new YaffleException(ErrorCode.RANGE, $"{what} {v} is too large");
    public static long Off(Int128 v, string what = "offset") =>
        v >= long.MinValue && v <= long.MaxValue ? (long)v : throw new YaffleException(ErrorCode.RANGE, $"{what} {v} is too large");
    public static long Off(BigInteger v, string what = "offset") =>
        v >= long.MinValue && v <= long.MaxValue ? (long)v : throw new YaffleException(ErrorCode.RANGE, $"{what} {v} is too large");

    /// <summary>Checks an integer for a primitive's range (deferred fixups); returns it.</summary>
    public static Int128 Prim(Int128 v, Prim kind, string? what = null)
    {
        if (v < Prims.Min(kind) || v > Prims.Max(kind))
            throw new YaffleException(ErrorCode.RANGE, $"{what ?? "value"} {v} is out of range for {Prims.Name(kind)}");
        return v;
    }

    /// <summary>A bitfield value as unsigned bits of <paramref name="width"/> (signed values in two's complement).</summary>
    public static ulong Bits(Int128 v, int width, bool signed)
    {
        Int128 lo = signed ? -(Int128.One << (width - 1)) : 0;
        Int128 hi = signed ? (Int128.One << (width - 1)) - 1 : (Int128.One << width) - 1;
        if (v < lo || v > hi) throw new YaffleException(ErrorCode.RANGE, $"{v} does not fit in {width} bits");
        return (ulong)(v < 0 ? v + (Int128.One << width) : v);
    }

    public static ulong Bits(bool v) => v ? 1UL : 0UL;
}

/// <summary>IEEE 754 binary16 conversions with exact rounding (ties to even).</summary>
public static class HalfBits
{
    public static double ToDouble(ushort h)
    {
        bool neg = (h & 0x8000) != 0;
        int exp = (h >> 10) & 0x1f;
        int frac = h & 0x3ff;
        double m;
        if (exp == 0) m = frac * Math.Pow(2, -24);
        else if (exp == 0x1f) return frac != 0 ? double.NaN : neg ? double.NegativeInfinity : double.PositiveInfinity;
        else m = (1 + frac / 1024.0) * Math.Pow(2, exp - 15);
        return neg ? -m : m;
    }

    public static ushort FromDouble(double v)
    {
        if (double.IsNaN(v)) return 0x7e00;
        int sign = v < 0 || (v == 0 && double.IsNegative(v)) ? 0x8000 : 0;
        double a = Math.Abs(v);
        if (a == 0) return (ushort)sign;
        if (double.IsInfinity(a)) return (ushort)(sign | 0x7c00);
        int e = (int)Math.Floor(Math.Log2(a));
        if (Math.Pow(2, e) > a) e--;
        else if (Math.Pow(2, e + 1) <= a) e++;
        if (e < -14) return (ushort)(sign | (int)RoundHalfEven(a * Math.Pow(2, 24)));
        double q = RoundHalfEven(a / Math.Pow(2, e - 10));
        if (q == 2048)
        {
            q = 1024;
            e++;
        }
        if (e > 15) return (ushort)(sign | 0x7c00);
        return (ushort)(sign | ((e + 15) << 10) | ((int)q - 1024));
    }

    private static double RoundHalfEven(double x)
    {
        double f = Math.Floor(x);
        double d = x - f;
        if (d > 0.5) return f + 1;
        if (d < 0.5) return f;
        return f % 2 == 0 ? f : f + 1;
    }

    public static Half ToHalf(double v) => BitConverter.UInt16BitsToHalf(FromDouble(v));
    public static double ToDouble(Half h) => ToDouble(BitConverter.HalfToUInt16Bits(h));
}

/// <summary>Aggregates (min/max/sum over arrays, lengths of nested arrays) and value helpers.</summary>
public static class Values
{
    /// <summary>Sum of an array of integers (0 for an empty array).</summary>
    public static Int128 Sum<T>(IEnumerable<T> xs) where T : IBinaryInteger<T>
    {
        Int128 s = 0;
        foreach (var x in xs) s += Int128.CreateChecked(x);
        return s;
    }

    /// <summary>Sum of an array of floats.</summary>
    public static double SumF<T>(IEnumerable<T> xs) where T : IFloatingPoint<T>
    {
        double s = 0;
        foreach (var x in xs) s += double.CreateChecked(x);
        return s;
    }

    public static T MinOf<T>(IReadOnlyList<T> xs) where T : IComparable<T> => Extreme(xs, -1, "min");

    public static T MaxOf<T>(IReadOnlyList<T> xs) where T : IComparable<T> => Extreme(xs, 1, "max");

    public static byte MinOf(byte[] xs) => Extreme<byte>(xs, -1, "min");

    public static byte MaxOf(byte[] xs) => Extreme<byte>(xs, 1, "max");

    private static T Extreme<T>(IReadOnlyList<T> xs, int sign, string what) where T : IComparable<T>
    {
        if (xs.Count == 0) throw new YaffleException(ErrorCode.RANGE, $"{what} of an empty array");
        var m = xs[0];
        for (int i = 1; i < xs.Count; i++) if (Math.Sign(xs[i].CompareTo(m)) == sign) m = xs[i];
        return m;
    }

    /// <summary>The element count of each element of an array of arrays (null counts as empty).</summary>
    public static List<long> Lengths<T>(IReadOnlyList<T> xs)
    {
        var out_ = new List<long>(xs.Count);
        foreach (var x in xs)
        {
            out_.Add(x switch
            {
                null => 0,
                byte[] b => b.Length,
                string s => s.Length,
                System.Collections.ICollection c => c.Count,
                _ => throw new YaffleException(ErrorCode.INPUT, "expected an array")
            });
        }
        return out_;
    }

    /// <summary>Array or bytes index with a bounds check (RANGE).</summary>
    public static T At<T>(IReadOnlyList<T> xs, long i)
    {
        if (i < 0 || i >= xs.Count) throw new YaffleException(ErrorCode.RANGE, $"index {i} is out of bounds (length {xs.Count})");
        return xs[(int)i];
    }

    public static byte At(byte[] xs, long i)
    {
        if (i < 0 || i >= xs.Length) throw new YaffleException(ErrorCode.RANGE, $"index {i} is out of bounds (length {xs.Length})");
        return xs[(int)i];
    }

    /// <summary><c>arr[*].field</c>: the array of a field over all elements.</summary>
    public static List<TOut> Map<TIn, TOut>(IReadOnlyList<TIn> xs, Func<TIn, TOut> f)
    {
        var out_ = new List<TOut>(xs.Count);
        foreach (var x in xs) out_.Add(f(x));
        return out_;
    }

    /// <summary><c>indexOf(array, value)</c> inverse lookup: a missing value is an INPUT error.</summary>
    public static long IndexOf<T>(IReadOnlyList<T> xs, object? v)
    {
        for (int i = 0; i < xs.Count; i++) if (Eq(xs[i], v)) return i;
        throw new YaffleException(ErrorCode.INPUT, $"value {Err.Describe(v)} is not in the table");
    }

    /// <summary>
    /// An untyped field value (a field with different types in different branches) as the type
    /// the taken branch needs: the value itself, a converted number, or a converted JSON node.
    /// </summary>
    public static T As<T>(object? v)
    {
        if (v is T t) return t;
        if (v is null) throw new YaffleException(ErrorCode.INPUT, $"expected a {typeof(T).Name}, got null");
        object? converted = v is System.Text.Json.Nodes.JsonNode j ? FromJsonNode(j, typeof(T)) : v;
        if (converted is T t2) return t2;
        if (converted is IConvertible && typeof(IConvertible).IsAssignableFrom(typeof(T)))
        {
            try
            {
                return (T)Convert.ChangeType(converted, typeof(T), CultureInfo.InvariantCulture);
            }
            catch (OverflowException)
            {
                throw new YaffleException(ErrorCode.RANGE, $"{converted} is out of range for {typeof(T).Name}");
            }
        }
        throw new YaffleException(ErrorCode.INPUT, $"expected a {typeof(T).Name}, got {Err.Describe(v)}");
    }

    private static object? FromJsonNode(System.Text.Json.Nodes.JsonNode j, Type t)
    {
        if (t == typeof(string)) return Json.Str(j);
        if (t == typeof(bool)) return Json.Bool(j);
        if (t == typeof(byte[])) return Json.Bytes(j);
        if (t == typeof(double) || t == typeof(float)) return Json.Float(j);
        if (t == typeof(Half)) return HalfBits.ToHalf(Json.Float(j));
        if (t == typeof(ulong) || t == typeof(long))
        {
            Int128 i;
            try
            {
                i = Json.Big(j);
            }
            catch (YaffleException)
            {
                i = Json.Int(j);
            }
            return t == typeof(ulong) ? Ck.U64(i) : Ck.I64(i);
        }
        if (t.IsPrimitive) return Json.Int(j);
        return j;
    }

    /// <summary>True for objects with reference identity (not values or strings): pointer targets, codec origins.</summary>
    internal static bool HasIdentity(object? v) => v is not null && v is not string && !v.GetType().IsValueType;

    public static bool BytesEq(byte[]? a, byte[]? b)
    {
        if (ReferenceEquals(a, b)) return true;
        if (a is null || b is null) return false;
        return a.AsSpan().SequenceEqual(b);
    }

    /// <summary>Structural equality (terminators, switch cases, <c>in</c>, indexOf).</summary>
    public static bool Eq(object? a, object? b)
    {
        if (ReferenceEquals(a, b)) return true;
        if (a is null || b is null) return false;
        if (IsInt(a) && IsInt(b)) return ToInt128(a) == ToInt128(b);
        if (a is double da && b is double db) return da.Equals(db);
        if (a is float fa && b is float fb) return fa.Equals(fb);
        if (a is byte[] ba && b is byte[] bb) return BytesEq(ba, bb);
        if (a is string sa && b is string sb) return sa == sb;
        if (a is System.Collections.IList la && b is System.Collections.IList lb)
        {
            if (la.Count != lb.Count) return false;
            for (int i = 0; i < la.Count; i++) if (!Eq(la[i], lb[i])) return false;
            return true;
        }
        if (a is IStructValue sva && b is IStructValue svb) return sva.StructuralEquals(svb);
        return a.Equals(b);
    }

    private static bool IsInt(object o) =>
        o is byte or sbyte or ushort or short or uint or int or ulong or long or Int128 or Enum;

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
        Enum e => Convert.GetTypeCode(e) == TypeCode.UInt64 ? (Int128)Convert.ToUInt64(e, CultureInfo.InvariantCulture) : Convert.ToInt64(e, CultureInfo.InvariantCulture),
        _ => 0
    };
}

/// <summary>Implemented by generated struct classes: structural equality (<c>==</c> on struct values).</summary>
public interface IStructValue
{
    bool StructuralEquals(IStructValue other);
}
