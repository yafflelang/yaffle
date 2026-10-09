// `extern type VarInt(u8 maxBytes) : u64`: unsigned LEB128, at most maxBytes bytes.
// Size: the index after the first byte below 0x80; null if the bytes end first (need more); an
// error if no terminating byte is found within maxBytes. Write: the shortest encoding; an error if
// it needs more than maxBytes bytes.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;
using Yaffle.Runtime;

public sealed class VarInt : IExternType<ulong>
{
    private static int Max(object[] args) => Convert.ToInt32(args[0], CultureInfo.InvariantCulture);

    public int? Size(ReadOnlySpan<byte> bytes, object[] args)
    {
        int max = Max(args);
        for (int i = 0; i < Math.Min(bytes.Length, max); i++) if (bytes[i] < 0x80) return i + 1;
        if (bytes.Length < max) return null;
        throw new InvalidOperationException($"VarInt: longer than {max} bytes");
    }

    public ulong Read(ReadOnlySpan<byte> bytes, object[] args)
    {
        int max = Max(args);
        BigInteger v = 0;
        for (int i = 0; i < bytes.Length && i < max; i++)
        {
            v |= (BigInteger)(bytes[i] & 0x7f) << (7 * i);
            if (bytes[i] < 0x80)
            {
                if (v > ulong.MaxValue) throw new InvalidOperationException("VarInt: value exceeds u64");
                return (ulong)v;
            }
        }
        throw new InvalidOperationException("VarInt: unterminated");
    }

    public byte[] Write(ulong value, object[] args)
    {
        int max = Max(args);
        var out_ = new List<byte>();
        ulong v = value;
        do
        {
            byte b = (byte)(v & 0x7f);
            v >>= 7;
            out_.Add(v == 0 ? b : (byte)(b | 0x80));
        } while (v != 0);
        if (out_.Count > max) throw new InvalidOperationException($"VarInt: {value} needs {out_.Count} bytes, more than {max}");
        return out_.ToArray();
    }
}
