// `extern fn swap16(u16 v) -> u16`: swaps the two bytes. Its own inverse.
public static partial class Externs
{
    public static ushort Swap16(ushort v) => (ushort)(((v & 0xff) << 8) | ((v >> 8) & 0xff));
}
