package dev.yaffle.runtime;

import static dev.yaffle.runtime.Assert.check;
import static dev.yaffle.runtime.Assert.eq;
import static dev.yaffle.runtime.Assert.fails;

import java.util.concurrent.CompletableFuture;

/** Codec calls, reuse and virtual streams. */
public final class CodecsTest {
  private CodecsTest() {}

  private static final Codec NOT =
      new Codec() {
        @Override
        public byte[] decode(byte[] input, CodecCtx ctx) {
          byte[] out = input.clone();
          for (int i = 0; i < out.length; i++) out[i] = (byte) ~out[i];
          return out;
        }

        @Override
        public byte[] encode(byte[] input, CodecCtx ctx) {
          return decode(input, ctx);
        }
      };

  public static void testHostFailuresAreCodecErrors() {
    Codec bad =
        new Codec() {
          @Override
          public byte[] decode(byte[] input, CodecCtx ctx) {
            throw new IllegalStateException("boom");
          }

          @Override
          public byte[] encode(byte[] input, CodecCtx ctx) {
            return input;
          }
        };
    YaffleException e = fails(ErrorCode.CODEC, () -> Codecs.decode(bad, "bad", new byte[1], CodecCtx.of(), false, 7));
    eq(7L, e.offset());
    check(e.getMessage().contains("boom"), "message keeps the host's");
  }

  public static void testAsyncCodecsAreAwaited() {
    AsyncCodec a =
        new AsyncCodec() {
          @Override
          public CompletableFuture<byte[]> decode(byte[] input, CodecCtx ctx) {
            return CompletableFuture.supplyAsync(() -> new byte[] {9});
          }

          @Override
          public CompletableFuture<byte[]> encode(byte[] input, CodecCtx ctx) {
            return CompletableFuture.failedFuture(new IllegalArgumentException("nope"));
          }
        };
    Codec b = Codecs.blocking(a);
    eq(new byte[] {9}, Codecs.decode(b, "a", new byte[0], CodecCtx.of(), false, 0).output());
    fails(ErrorCode.CODEC, () -> Codecs.encode(b, "a", new byte[0], CodecCtx.of()));
  }

  public static void testReuseNeedsTheSameObjectAndUnchangedContent() {
    Object value = new Object();
    byte[] decoded = {1, 2};
    byte[] encoded = Codecs.encode(NOT, "not", decoded, CodecCtx.of());
    Codecs.remember(value, "S.f#0", encoded, decoded.clone());
    check(Codecs.reuse(value, "S.f#0", new byte[] {1, 2}) == encoded, "unchanged content reuses");
    eq(null, Codecs.reuse(value, "S.f#0", new byte[] {1, 3}));
    eq(null, Codecs.reuse(value, "S.g#0", new byte[] {1, 2}));
    eq(null, Codecs.reuse(new Object(), "S.f#0", new byte[] {1, 2}));
    eq(null, Codecs.reuse("strings are values", "S.f#0", new byte[] {1, 2}));
  }

  public static void testStreamsJoinSliceAndSplit() {
    eq(Hex.decode("010203"), Streams.join(java.util.List.of(new byte[] {1}, new byte[] {2, 3})));
    eq(Hex.decode("02"), Streams.slice(new byte[] {1, 2, 3}, 1, 2));
    fails(ErrorCode.EOF, () -> Streams.slice(new byte[] {1}, 0, 2));
    eq(2, Streams.splitBySizes(new byte[] {1, 2, 3}, new int[] {1, 2}).size());
    fails(ErrorCode.DERIVE, () -> Streams.splitBySizes(new byte[] {1, 2, 3}, new int[] {1}));
  }

  public static void testWeakIdentityMapUsesIdentity() {
    WeakIdentityMap<Object, String> m = new WeakIdentityMap<>();
    String a = new String("k");
    String b = new String("k");
    m.put(a, "A");
    eq("A", m.get(a));
    eq(null, m.get(b));
  }

  public static void testChecksums() {
    eq(0xcbf43926L, Checksums.crc32("123456789"));
    eq(0x091e01deL, Checksums.adler32("123456789"));
  }
}
