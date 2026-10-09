// `extern codec xor(u8 key) @ranged`: every byte XOR key. Its own inverse, and position
// independent, so any slice decodes on its own.
using System;
using Yaffle.Runtime;

public sealed class Xor : ICodec
{
    internal static byte[] Apply(ReadOnlySpan<byte> input, CodecContext ctx)
    {
        int key = ctx.Arg<int>(0);
        if (key < 0 || key > 255) throw new ArgumentException($"codec key must be a u8, got {key}");
        var out_ = new byte[input.Length];
        for (int i = 0; i < input.Length; i++) out_[i] = (byte)(input[i] ^ key);
        return out_;
    }

    public byte[] Decode(ReadOnlyMemory<byte> input, CodecContext ctx)
    {
        var out_ = Apply(input.Span, ctx);
        if (ctx.OutputSize is int n && n != out_.Length)
            throw new InvalidOperationException($"xor: decoded {out_.Length} bytes, expected {n}");
        return out_;
    }

    public byte[] Encode(ReadOnlyMemory<byte> input, CodecContext ctx) => Apply(input.Span, ctx);
}
