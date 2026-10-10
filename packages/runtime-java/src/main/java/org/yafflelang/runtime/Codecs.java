package org.yafflelang.runtime;

import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;

/**
 * Codecs ({@code @via}): calling host codecs and codec reuse for byte-exact rebuilds
 * (docs/IR.md §3.6).
 *
 * <p>A value read from a codec's decoded side remembers the original encoded bytes and a private
 * copy of the decoded bytes. When the same object is serialized and its plain encoding is
 * unchanged, the original encoded bytes are reused instead of re-encoding.
 */
public final class Codecs {
  private Codecs() {}

  static YaffleException codecError(String name, String op, Throwable e, long offset) {
    if (e instanceof YaffleException y) return y;
    if ((e instanceof CompletionException || e instanceof ExecutionException)
        && e.getCause() != null) {
      return codecError(name, op, e.getCause(), offset);
    }
    String msg = e.getMessage() != null ? e.getMessage() : e.toString();
    return new YaffleException(
        ErrorCode.CODEC, "codec " + name + " failed to " + op + ": " + msg, offset);
  }

  /**
   * An async codec as a blocking one. Generated code runs async schemas on virtual threads, where
   * waiting for the future parks the thread instead of blocking a carrier.
   */
  public static Codec blocking(AsyncCodec codec) {
    return new Codec() {
      @Override
      public byte[] decode(byte[] input, CodecCtx ctx) {
        return await(codec.decode(input, ctx));
      }

      @Override
      public byte[] encode(byte[] input, CodecCtx ctx) {
        return await(codec.encode(input, ctx));
      }

      @Override
      public Decoded decodeStreaming(byte[] input, CodecCtx ctx) {
        return await(codec.decodeStreaming(input, ctx));
      }
    };
  }

  /** The future's value; a failure is rethrown wrapped (codec errors unwrap it). */
  private static <T> T await(CompletableFuture<T> f) {
    try {
      return f.get();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new CompletionException(e);
    } catch (ExecutionException e) {
      throw new CompletionException(e.getCause());
    }
  }

  private static Decoded checkStreaming(String name, Decoded d, byte[] input, long offset) {
    if (d == null || d.output() == null) {
      throw new YaffleException(ErrorCode.CODEC, "streaming codec " + name + " returned null", offset);
    }
    if (d.consumed() < 0 || d.consumed() > input.length) {
      throw new YaffleException(
          ErrorCode.CODEC,
          "streaming codec " + name + " consumed " + d.consumed() + " of " + input.length + " bytes",
          offset);
    }
    return d;
  }

  /** Decodes {@code input}; host failures are CODEC errors at {@code offset}. */
  public static Decoded decode(
      Codec codec, String name, byte[] input, CodecCtx ctx, boolean streaming, long offset) {
    try {
      if (streaming) return checkStreaming(name, codec.decodeStreaming(input, ctx), input, offset);
      byte[] out = codec.decode(input, ctx);
      if (out == null) throw new IllegalStateException("decode returned null");
      return new Decoded(out, input.length);
    } catch (YaffleException e) {
      throw e;
    } catch (RuntimeException e) {
      throw codecError(name, "decode", e, offset);
    }
  }

  /** Encodes {@code input}; host failures are CODEC errors. */
  public static byte[] encode(Codec codec, String name, byte[] input, CodecCtx ctx) {
    try {
      byte[] out = codec.encode(input, ctx);
      if (out == null) throw new IllegalStateException("encode returned null");
      return out;
    } catch (YaffleException e) {
      throw e;
    } catch (RuntimeException e) {
      throw codecError(name, "encode", e, -1);
    }
  }

  // ── reuse ───────────────────────────────────────────────────────────────────

  private record Origin(byte[] encoded, byte[] decoded) {}

  private static final WeakIdentityMap<Object, Map<String, Origin>> ORIGINS =
      new WeakIdentityMap<>();

  /** Values that carry identity (struct objects, lists, byte arrays, union values). */
  static boolean trackable(Object value) {
    return value != null
        && !(value instanceof String)
        && !(value instanceof Number)
        && !(value instanceof Boolean)
        && !(value instanceof Enum<?>);
  }

  /**
   * Remembers that {@code value} (the content inside a {@code via} layer) was decoded from {@code
   * encoded}. {@code slot} distinguishes nested layers. {@code decoded} must not be aliased by
   * values.
   */
  public static void remember(Object value, String slot, byte[] encoded, byte[] decoded) {
    if (!trackable(value)) return;
    Map<String, Origin> m = ORIGINS.computeIfAbsent(value, HashMap::new);
    synchronized (m) {
      m.put(slot, new Origin(encoded, decoded));
    }
  }

  /** The original encoded bytes if {@code value} came from a parse and its plain encoding is unchanged. */
  public static byte[] reuse(Object value, String slot, byte[] plain) {
    if (!trackable(value)) return null;
    Map<String, Origin> m = ORIGINS.get(value);
    if (m == null) return null;
    Origin o;
    synchronized (m) {
      o = m.get(slot);
    }
    if (o == null || !Arrays.equals(o.decoded, plain)) return null;
    return o.encoded;
  }
}
