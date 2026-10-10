using System;
using System.Collections.Generic;
using System.Globalization;

namespace Yaffle.Runtime;

/// <summary>Write-side validation and other small helpers called by generated code.</summary>
public static class Check
{
    /// <summary>An array written with <paramref name="actual"/> elements whose length expression says <paramref name="expected"/>: DERIVE.</summary>
    public static void Length(long actual, long expected)
    {
        if (actual != expected)
            throw new YaffleException(ErrorCode.DERIVE, $"{actual} elements given, the length expression says {expected}");
    }

    /// <summary>A placed field whose read-side offset expression disagrees with where it was placed: DERIVE.</summary>
    public static void Placement(long offset, Placeable p, string name)
    {
        // An empty target reads back the same wherever its offset points.
        if (p.Block.Size == 0) return;
        if (offset != p.Block.Pos)
            throw new YaffleException(ErrorCode.DERIVE, $"{name} was placed at {p.Block.Pos} but its offset expression gives {offset}");
    }

    /// <summary>A virtual field's read expression must give the input value back (DERIVE).</summary>
    public static void Virtual<T>(T v, T back, string name)
    {
        if (!Values.Eq(v, back))
            throw new YaffleException(ErrorCode.DERIVE, $"virtual field {name} = {Err.Describe(v)} reads back as {Err.Describe(back)} from the fields it is made of");
    }

    /// <summary><c>read(write(v))</c> must give <c>v</c> back (integers and other exact values).</summary>
    public static void RoundTrip<T>(T v, T back)
    {
        if (!Values.Eq(v, back))
            throw new YaffleException(ErrorCode.INPUT, $"value {Err.Describe(v)} does not survive the transform (reads back as {Err.Describe(back)})");
    }

    /// <summary>Float transforms: the value must be within half a storage step of what reads back.</summary>
    public static void FloatRoundTrip(double v, double back, double next)
    {
        if (double.IsNaN(v) && double.IsNaN(back)) return;
        double half = Math.Abs(next - back) / 2;
        if (!(Math.Abs(v - back) <= half * (1 + 1e-9)))
            throw new YaffleException(ErrorCode.INPUT, $"value {v.ToString(CultureInfo.InvariantCulture)} does not survive the transform (reads back as {back.ToString(CultureInfo.InvariantCulture)})");
    }

    /// <summary>A required input value (INPUT naming the field when null).</summary>
    public static T Req<T>(T? v, string field) where T : class => v ?? throw Err.Missing(field);

    public static T ReqV<T>(T? v, string field) where T : struct => v ?? throw Err.Missing(field);

    /// <summary><c>@nullable(empty)</c>: an empty (or null) array, bytes or string value is written as the null value.</summary>
    public static bool IsEmpty(object? v) => v switch
    {
        null => true,
        string s => s.Length == 0,
        byte[] b => b.Length == 0,
        System.Collections.ICollection c => c.Count == 0,
        _ => false
    };

    /// <summary>An input union value must be present.</summary>
    public static UnionValue Union(UnionValue? v) => v ?? throw new YaffleException(ErrorCode.INPUT, "expected a union value { type, value }, got null");

    /// <summary>The value of a union variant as <typeparamref name="T"/> (INPUT if it holds something else).</summary>
    public static T Variant<T>(UnionValue u)
    {
        if (u.Value is T t) return t;
        throw new YaffleException(ErrorCode.INPUT, $"union variant {u.Type} holds {Err.Describe(u.Value)}");
    }

    /// <summary>An input array must be present.</summary>
    public static List<T> Array<T>(List<T>? v) => v ?? throw new YaffleException(ErrorCode.INPUT, "expected an array, got null");

    public static byte[] Bytes(byte[]? v) => v ?? throw new YaffleException(ErrorCode.INPUT, "expected bytes, got null");

    /// <summary>Calls a host function (extern fn); host failures are CODEC errors.</summary>
    public static T Host<T>(Func<T> call, string name)
    {
        try
        {
            return call();
        }
        catch (Exception e) when (e is not YaffleException && e is not ControlSignal)
        {
            throw new YaffleException(ErrorCode.CODEC, $"extern {name}: {e.Message}");
        }
    }

    /// <summary>Sign-extends the low <paramref name="width"/> bits.</summary>
    public static long SignExtend(ulong v, int width)
    {
        int shift = 64 - width;
        return ((long)(v << shift)) >> shift;
    }
}

/// <summary>Write side of joined streams (<c>T x from arr[*].piece</c>).</summary>
public static class StreamSplit
{
    /// <summary>
    /// Splits the encoded stream into the elements' piece field. Piece sizes given in the input win;
    /// otherwise the <c>fit</c> policy picks, for element k, the longest piece whose encoded element
    /// fits before element k+1's offset. A piece equal to the element's original keeps that array,
    /// so codec reuse still recognizes it.
    /// </summary>
    public static List<T> Split<T>(
        IReadOnlyList<T>? elements,
        byte[] data,
        Func<T, byte[]?> getPiece,
        Action<T, byte[]> setPiece,
        Func<T, long?>? getSize,
        Action<T>? clearSize,
        Func<T> create,
        Func<T, T> clone,
        Func<long, long>? fitOffset,
        Func<T, long>? fitSize) where T : class
    {
        bool fit = fitOffset is not null && fitSize is not null;
        if (elements is not null && getSize is not null)
        {
            var sizes = GivenSizes(elements, getSize);
            if (sizes is not null && (elements.Count > 0 || !fit)) return Into(elements, data, sizes, getPiece, setPiece, clone);
            if (!fit) throw new YaffleException(ErrorCode.INPUT, "split policy \"sizes\" needs every piece's size in the input");
        }
        if (!fit) throw new YaffleException(ErrorCode.INPUT, "cannot split the stream: give every piece's size in the input");
        var out_ = new List<T>();
        int pos = 0;
        for (int k = 0; pos < data.Length; k++)
        {
            T Base()
            {
                var b = elements is not null && k < elements.Count ? clone(elements[k]) : create();
                clearSize?.Invoke(b);
                return b;
            }
            long cap = fitOffset!(k + 1) - fitOffset(k);
            int left = data.Length - pos;
            bool Fits(int n)
            {
                try
                {
                    var b = Base();
                    setPiece(b, data.AsSpan(pos, n).ToArray());
                    return fitSize!(b) <= cap;
                }
                catch (YaffleException e) when (e.Code == ErrorCode.RANGE)
                {
                    // A piece too large for one of the element's fields does not fit either.
                    return false;
                }
            }
            int n;
            if (Fits(left)) n = left;
            else
            {
                int lo = 0, hi = left;
                while (hi - lo > 1)
                {
                    int mid = (lo + hi) >>> 1;
                    if (Fits(mid)) lo = mid;
                    else hi = mid;
                }
                n = lo;
            }
            if (n == 0) throw new YaffleException(ErrorCode.OVERLAP, $"stream piece {k} does not fit its block of {cap} bytes");
            var piece = data.AsSpan(pos, n).ToArray();
            var el = Base();
            var orig = elements is not null && k < elements.Count ? getPiece(elements[k]) : null;
            setPiece(el, orig is not null && orig.AsSpan().SequenceEqual(piece) ? orig : piece);
            out_.Add(el);
            pos += n;
        }
        return out_;
    }

    /// <summary>Every element's piece size from the input, or null when one is missing (negative is INPUT).</summary>
    private static List<long>? GivenSizes<T>(IReadOnlyList<T> elements, Func<T, long?> getSize)
    {
        var sizes = new List<long>(elements.Count);
        foreach (var e in elements)
        {
            if (getSize(e) is not long n) return null;
            if (n < 0) throw new YaffleException(ErrorCode.INPUT, "split policy \"sizes\" needs every piece's size in the input");
            sizes.Add(n);
        }
        return sizes;
    }

    private static List<T> Into<T>(IReadOnlyList<T> elements, byte[] data, IReadOnlyList<long> sizes,
        Func<T, byte[]?> getPiece, Action<T, byte[]> setPiece, Func<T, T> clone)
    {
        var pieces = Codecs.SplitBySizes(data, sizes);
        var out_ = new List<T>(elements.Count);
        for (int i = 0; i < elements.Count; i++)
        {
            var e = elements[i] ?? throw new YaffleException(ErrorCode.INPUT, "expected an object, got null");
            var orig = getPiece(e);
            var c = clone(e);
            setPiece(c, orig is not null && orig.AsSpan().SequenceEqual(pieces[i]) ? orig : pieces[i]);
            out_.Add(c);
        }
        return out_;
    }
}
