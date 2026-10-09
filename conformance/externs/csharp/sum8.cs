// `extern fn sum8(u8 data[]) -> u8`: the sum of the bytes, modulo 256.
public static partial class Externs
{
    public static byte Sum8(byte[] data)
    {
        int s = 0;
        foreach (var b in data) s = (s + b) & 0xff;
        return (byte)s;
    }
}
