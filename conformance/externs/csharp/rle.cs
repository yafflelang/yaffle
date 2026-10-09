// `extern codec rle`: run-length encoding as (count, byte) pairs with count 1..255.
// decode: an odd input length or a zero count is an error; so is a decoded length that differs
// from OutputSize when one is given. encode: greedy, runs of at most 255.
using System;
using System.Collections.Generic;
using Yaffle.Runtime;

public sealed class Rle : ICodec
{
    internal static byte[] DecodePairs(ReadOnlySpan<byte> input)
    {
        if (input.Length % 2 != 0) throw new InvalidOperationException($"rle: odd input length {input.Length}");
        var out_ = new List<byte>();
        for (int i = 0; i < input.Length; i += 2)
        {
            int n = input[i];
            if (n == 0) throw new InvalidOperationException($"rle: zero run length at {i}");
            for (int k = 0; k < n; k++) out_.Add(input[i + 1]);
        }
        return out_.ToArray();
    }

    internal static byte[] EncodePairs(ReadOnlySpan<byte> input)
    {
        var out_ = new List<byte>();
        int i = 0;
        while (i < input.Length)
        {
            byte b = input[i];
            int n = 1;
            while (i + n < input.Length && input[i + n] == b && n < 255) n++;
            out_.Add((byte)n);
            out_.Add(b);
            i += n;
        }
        return out_.ToArray();
    }

    public byte[] Decode(ReadOnlyMemory<byte> input, CodecContext ctx)
    {
        var out_ = DecodePairs(input.Span);
        if (ctx.OutputSize is int n && n != out_.Length)
            throw new InvalidOperationException($"rle: decoded {out_.Length} bytes, expected {n}");
        return out_;
    }

    public byte[] Encode(ReadOnlyMemory<byte> input, CodecContext ctx) => EncodePairs(input.Span);
}
