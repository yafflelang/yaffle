// `extern codec xorpos(u8 key) @ranged`: byte i of the encoded region is XORed with
// (key + i) & 0xff, where i counts from the start of the whole region. A slice decodes on its
// own only when it is given its position (ctx.Position).
using System;
using Yaffle.Runtime;

public sealed class Xorpos : ICodec
{
    private static byte[] Apply(ReadOnlySpan<byte> input, CodecContext ctx)
    {
        int key = ctx.Arg<int>(0);
        if (key < 0 || key > 255) throw new ArgumentException($"codec key must be a u8, got {key}");
        long pos = ctx.Position ?? 0;
        var out_ = new byte[input.Length];
        for (int i = 0; i < input.Length; i++) out_[i] = (byte)(input[i] ^ ((key + pos + i) & 0xff));
        return out_;
    }

    public byte[] Decode(ReadOnlyMemory<byte> input, CodecContext ctx) => Apply(input.Span, ctx);

    public byte[] Encode(ReadOnlyMemory<byte> input, CodecContext ctx) => Apply(input.Span, ctx);
}
