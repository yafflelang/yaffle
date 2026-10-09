// `extern type Bcd16 : u16 @size(2)`: four BCD digits, most significant first (`12 34` → 1234).
// Fixed size, so generated code never calls Size. A nibble above 9 is an error on read; a value
// above 9999 is an error on write.
using System;
using Yaffle.Runtime;

public sealed class Bcd16 : IExternType<ushort>
{
    public int? Size(ReadOnlySpan<byte> bytes, object[] args) => 2;

    public ushort Read(ReadOnlySpan<byte> bytes, object[] args)
    {
        int v = 0;
        for (int i = 0; i < 2; i++)
        {
            int hi = bytes[i] >> 4;
            int lo = bytes[i] & 0x0f;
            if (hi > 9 || lo > 9) throw new InvalidOperationException($"Bcd16: invalid digit in 0x{bytes[i]:x}");
            v = v * 100 + hi * 10 + lo;
        }
        return (ushort)v;
    }

    public byte[] Write(ushort value, object[] args)
    {
        if (value > 9999) throw new InvalidOperationException($"Bcd16: {value} out of range");
        int d0 = value / 1000 % 10, d1 = value / 100 % 10, d2 = value / 10 % 10, d3 = value % 10;
        return new[] { (byte)((d0 << 4) | d1), (byte)((d2 << 4) | d3) };
    }
}
