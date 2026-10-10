using System;

namespace Yaffle.Runtime;

/// <summary>Built-in checksums (docs/IR.md §5): CRC-32 (IEEE 802.3, reflected) and Adler-32.</summary>
public static class Checksum
{
    private static readonly uint[] Table = MakeTable();

    private static uint[] MakeTable()
    {
        var t = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            uint c = n;
            for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xedb88320 ^ (c >> 1) : c >> 1;
            t[n] = c;
        }
        return t;
    }

    /// <summary>CRC-32 of <paramref name="data"/>; <paramref name="prev"/> continues a running checksum.</summary>
    public static uint Crc32(ReadOnlySpan<byte> data, uint prev = 0)
    {
        uint c = prev ^ 0xffffffff;
        foreach (var b in data) c = Table[(c ^ b) & 0xff] ^ (c >> 8);
        return c ^ 0xffffffff;
    }

    /// <summary>Adler-32 of <paramref name="data"/>; <paramref name="prev"/> continues a running checksum (default 1).</summary>
    public static uint Adler32(ReadOnlySpan<byte> data, uint prev = 1)
    {
        uint a = prev & 0xffff;
        uint b = (prev >> 16) & 0xffff;
        const uint Mod = 65521;
        int i = 0;
        while (i < data.Length)
        {
            // Reduce before the sums can overflow 32 bits.
            int end = Math.Min(data.Length, i + 3800);
            for (; i < end; i++)
            {
                a += data[i];
                b += a;
            }
            a %= Mod;
            b %= Mod;
        }
        return (b << 16) | a;
    }
}

/// <summary>Lowercase hex encoding of bytes (canonical JSON).</summary>
public static class Hex
{
    public static string Encode(ReadOnlySpan<byte> b) =>
#if NET9_0_OR_GREATER
        Convert.ToHexStringLower(b);
#else
        Convert.ToHexString(b).ToLowerInvariant(); // ToHexStringLower is .NET 9+
#endif

    /// <summary>Decodes hex (whitespace allowed); invalid input is an INPUT error.</summary>
    public static byte[] Decode(string s)
    {
        string clean = s;
        if (clean.Length > 0 && (char.IsWhiteSpace(clean[0]) || clean.AsSpan().IndexOfAny(" \t\r\n") >= 0))
        {
            var sb = new System.Text.StringBuilder(s.Length);
            foreach (var ch in s) if (!char.IsWhiteSpace(ch)) sb.Append(ch);
            clean = sb.ToString();
        }
        if (clean.Length % 2 != 0) throw new YaffleException(ErrorCode.INPUT, $"invalid hex string {Err.Describe(s)}");
        foreach (var ch in clean)
        {
            if (!char.IsAsciiHexDigit(ch)) throw new YaffleException(ErrorCode.INPUT, $"invalid hex string {Err.Describe(s)}");
        }
        return Convert.FromHexString(clean);
    }
}
