package org.yafflelang.runtime;

/**
 * Host implementation of an {@code extern codec} (docs/IR.md §5). Any exception it throws is a
 * {@code CODEC} error.
 *
 * <p>{@code @ranged} codecs may be called on any slice of the encoded region; {@link
 * CodecCtx#position()} is the slice's offset. {@code @streaming} codecs override {@link
 * #decodeStreaming}: they get the rest of the region and report how many bytes they consumed.
 */
public interface Codec {
  byte[] decode(byte[] input, CodecCtx ctx);

  byte[] encode(byte[] input, CodecCtx ctx);

  /** {@code @streaming} codecs: decode from the start of {@code input} and report the bytes consumed. */
  default Decoded decodeStreaming(byte[] input, CodecCtx ctx) {
    byte[] out = decode(input, ctx);
    return new Decoded(out, input.length);
  }
}
