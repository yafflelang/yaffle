// `extern async codec axor(u8 key)`: the same transform as `xor`, but asynchronous: generated
// code awaits DecodeAsync/EncodeAsync (each yields before transforming).
using System;
using System.Threading.Tasks;
using Yaffle.Runtime;

public sealed class Axor : ICodec
{
    private static byte[] Apply(ReadOnlySpan<byte> input, CodecContext ctx)
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
            throw new InvalidOperationException($"axor: decoded {out_.Length} bytes, expected {n}");
        return out_;
    }

    public byte[] Encode(ReadOnlyMemory<byte> input, CodecContext ctx) => Apply(input.Span, ctx);

    public async ValueTask<byte[]> DecodeAsync(ReadOnlyMemory<byte> input, CodecContext ctx)
    {
        await Task.Yield();
        return Decode(input, ctx);
    }

    public async ValueTask<byte[]> EncodeAsync(ReadOnlyMemory<byte> input, CodecContext ctx)
    {
        await Task.Yield();
        return Encode(input, ctx);
    }
}
