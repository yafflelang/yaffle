using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Text;

namespace Yaffle.Runtime;

/// <summary>Text encodings of <c>char</c>, <c>char16</c> and <c>char32</c> data.</summary>
public enum TextEncoding
{
    Utf8,
    Ascii,
    Latin1,
    Utf16,
    Utf32
}

/// <summary>How a string's length is determined.</summary>
public enum StrMode
{
    /// <summary>A fixed number of code units, padded with NUL units.</summary>
    Count,
    /// <summary>NUL-terminated.</summary>
    Until,
    /// <summary>To the end of the region.</summary>
    Rest
}

/// <summary>
/// Text encodings: utf8 / ascii / latin1 (1-byte units), utf16 (2-byte units), utf32 (4-byte
/// units). Lengths count code units. Reading stops the value at the first NUL unit. Invalid input
/// on read is a CHECK error; text that cannot be encoded (or contains NUL, which would read back
/// differently) is an INPUT error on write.
/// </summary>
public static class Strings
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    private static int UnitOf(TextEncoding enc) => enc switch
    {
        TextEncoding.Utf16 => 2,
        TextEncoding.Utf32 => 4,
        _ => 1
    };

    /// <summary>Index (in units) of the first NUL unit in <c>[start, start + n*unit)</c>, or -1.</summary>
    public static int FindNulUnit(ReadOnlySpan<byte> b, int start, int nUnits, int unit)
    {
        if (unit == 1) return b.Slice(start, nUnits).IndexOf((byte)0);
        for (int i = 0; i < nUnits; i++)
        {
            if (!b.Slice(start + i * unit, unit).ContainsAnyExcept((byte)0)) return i;
        }
        return -1;
    }

    /// <summary>Decodes <paramref name="nUnits"/> code units at <paramref name="start"/>; <paramref name="at"/> is the offset for errors.</summary>
    public static string Decode(ReadOnlySpan<byte> b, int start, int nUnits, TextEncoding enc, bool le, long at)
    {
        switch (enc)
        {
            case TextEncoding.Latin1:
                return Encoding.Latin1.GetString(b.Slice(start, nUnits));
            case TextEncoding.Ascii:
                for (int i = 0; i < nUnits; i++)
                {
                    if (b[start + i] >= 0x80)
                        throw new YaffleException(ErrorCode.CHECK, $"byte 0x{b[start + i]:x} is not ASCII", at + i);
                }
                return Encoding.Latin1.GetString(b.Slice(start, nUnits));
            case TextEncoding.Utf8:
                try
                {
                    return StrictUtf8.GetString(b.Slice(start, nUnits));
                }
                catch (DecoderFallbackException)
                {
                    throw new YaffleException(ErrorCode.CHECK, "invalid UTF-8", at);
                }
            case TextEncoding.Utf16:
            {
                var chars = new char[nUnits];
                for (int i = 0; i < nUnits; i++)
                {
                    var s = b.Slice(start + i * 2, 2);
                    chars[i] = (char)(le ? BinaryPrimitives.ReadUInt16LittleEndian(s) : BinaryPrimitives.ReadUInt16BigEndian(s));
                }
                int bad = LoneSurrogate(chars);
                if (bad >= 0)
                {
                    var which = char.IsHighSurrogate(chars[bad]) ? "high" : "low";
                    throw new YaffleException(ErrorCode.CHECK, $"invalid UTF-16 (lone {which} surrogate)", at + bad * 2);
                }
                return new string(chars);
            }
            case TextEncoding.Utf32:
            {
                var sb = new StringBuilder(nUnits);
                for (int i = 0; i < nUnits; i++)
                {
                    var s = b.Slice(start + i * 4, 4);
                    uint cp = le ? BinaryPrimitives.ReadUInt32LittleEndian(s) : BinaryPrimitives.ReadUInt32BigEndian(s);
                    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
                        throw new YaffleException(ErrorCode.CHECK, $"invalid UTF-32 code point 0x{cp:x}", at + i * 4);
                    sb.Append(char.ConvertFromUtf32((int)cp));
                }
                return sb.ToString();
            }
        }
        throw new ArgumentOutOfRangeException(nameof(enc));
    }

    /// <summary>The index of the first lone surrogate, or -1.</summary>
    private static int LoneSurrogate(ReadOnlySpan<char> s)
    {
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 >= s.Length || !char.IsLowSurrogate(s[i + 1])) return i;
                i++;
            }
            else if (char.IsLowSurrogate(c)) return i;
        }
        return -1;
    }

    private static YaffleException ContainsNul() => new(ErrorCode.INPUT, "string contains NUL");

    private static void CheckWellFormed(string s)
    {
        if (LoneSurrogate(s) >= 0) throw new YaffleException(ErrorCode.INPUT, "string is not well-formed UTF-16 (lone surrogate)");
    }

    /// <summary>Encodes text without any terminator or padding.</summary>
    public static byte[] Encode(string? s, TextEncoding enc, bool le)
    {
        if (s is null) throw new YaffleException(ErrorCode.INPUT, "expected a string, got null");
        switch (enc)
        {
            case TextEncoding.Utf8:
                if (s.Contains('\0')) throw ContainsNul();
                CheckWellFormed(s);
                return Encoding.UTF8.GetBytes(s);
            case TextEncoding.Ascii:
            case TextEncoding.Latin1:
            {
                int lim = enc == TextEncoding.Ascii ? 0x80 : 0x100;
                var out_ = new byte[s.Length];
                for (int i = 0; i < s.Length; i++)
                {
                    int c = s[i];
                    if (c == 0) throw ContainsNul();
                    if (c >= lim)
                        throw new YaffleException(ErrorCode.INPUT, $"character U+{c:x4} is not {(enc == TextEncoding.Ascii ? "ascii" : "latin1")}");
                    out_[i] = (byte)c;
                }
                return out_;
            }
            case TextEncoding.Utf16:
            {
                CheckWellFormed(s);
                var out_ = new byte[s.Length * 2];
                for (int i = 0; i < s.Length; i++)
                {
                    char c = s[i];
                    if (c == 0) throw ContainsNul();
                    if (le) BinaryPrimitives.WriteUInt16LittleEndian(out_.AsSpan(i * 2), c);
                    else BinaryPrimitives.WriteUInt16BigEndian(out_.AsSpan(i * 2), c);
                }
                return out_;
            }
            case TextEncoding.Utf32:
            {
                CheckWellFormed(s);
                var cps = new List<int>(s.Length);
                for (int i = 0; i < s.Length; i++)
                {
                    int cp = char.ConvertToUtf32(s, i);
                    if (char.IsHighSurrogate(s[i])) i++;
                    if (cp == 0) throw ContainsNul();
                    cps.Add(cp);
                }
                var out_ = new byte[cps.Count * 4];
                for (int i = 0; i < cps.Count; i++)
                {
                    if (le) BinaryPrimitives.WriteUInt32LittleEndian(out_.AsSpan(i * 4), (uint)cps[i]);
                    else BinaryPrimitives.WriteUInt32BigEndian(out_.AsSpan(i * 4), (uint)cps[i]);
                }
                return out_;
            }
        }
        throw new ArgumentOutOfRangeException(nameof(enc));
    }

    /// <summary>Code units <paramref name="s"/> occupies in the given encoding (<c>len()</c> / <c>.length</c>).</summary>
    public static long CodeUnits(string? s, TextEncoding enc)
    {
        if (s is null) throw new YaffleException(ErrorCode.INPUT, "expected a string, got null");
        switch (enc)
        {
            case TextEncoding.Utf8:
                return Encoding.UTF8.GetByteCount(s);
            case TextEncoding.Utf32:
            {
                long n = 0;
                for (int i = 0; i < s.Length; i++)
                {
                    if (char.IsHighSurrogate(s[i]) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) i++;
                    n++;
                }
                return n;
            }
            default:
                return s.Length;
        }
    }

    /// <summary>Bytes <paramref name="s"/> occupies in the given encoding (the IR builtin <c>encodedLength</c>).</summary>
    public static long EncodedBytes(string? s, TextEncoding enc) => CodeUnits(s, enc) * UnitOf(enc);

    /// <summary>Encodes a string padded with NUL units to exactly <paramref name="n"/> bytes.</summary>
    public static byte[] EncodeFixed(string? s, long n, int unit, TextEncoding enc, bool le)
    {
        var b = Encode(s, enc, le);
        if (b.Length > n) throw new YaffleException(ErrorCode.INPUT, $"string of {b.Length / unit} units exceeds the length {n / unit}");
        var out_ = new byte[n];
        b.CopyTo(out_, 0);
        return out_;
    }
}
