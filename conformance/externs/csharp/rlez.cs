// `extern codec rlez @streaming`: `rle` pairs followed by a single 0x00 terminator. It finds its
// own end: DecodeStreaming reports how many bytes it consumed (terminator included). A missing
// terminator is an error. Self-contained (does not depend on rle.cs).
using System;
using System.Collections.Generic;
using Yaffle.Runtime;

public sealed class Rlez : IStreamingCodec
{
    private static byte[] DecodePairs(ReadOnlySpan<byte> input)
    {
        if (input.Length % 2 != 0) throw new InvalidOperationException($"rlez: odd input length {input.Length}");
        var out_ = new List<byte>();
        for (int i = 0; i < input.Length; i += 2)
        {
            int n = input[i];
            if (n == 0) throw new InvalidOperationException($"rlez: zero run length at {i}");
            for (int k = 0; k < n; k++) out_.Add(input[i + 1]);
        }
        return out_.ToArray();
    }

    public CodecResult DecodeStreaming(ReadOnlyMemory<byte> input, CodecContext ctx)
    {
        var s = input.Span;
        int i = 0;
        while (i < s.Length && s[i] != 0) i += 2;
        if (i >= s.Length) throw new InvalidOperationException("rlez: missing terminator");
        var output = DecodePairs(s[..i]);
        if (ctx.OutputSize is int n && n != output.Length)
            throw new InvalidOperationException($"rlez: decoded {output.Length} bytes, expected {n}");
        return new CodecResult(output, i + 1);
    }

    public byte[] Encode(ReadOnlyMemory<byte> input, CodecContext ctx)
    {
        var s = input.Span;
        var out_ = new List<byte>();
        int i = 0;
        while (i < s.Length)
        {
            byte b = s[i];
            int n = 1;
            while (i + n < s.Length && s[i + n] == b && n < 255) n++;
            out_.Add((byte)n);
            out_.Add(b);
            i += n;
        }
        out_.Add(0);
        return out_.ToArray();
    }
}
