package dev.yaffle.runtime;

/**
 * A codec's decoded output and the number of encoded bytes it consumed (the whole input unless
 * the codec is {@code @streaming}).
 *
 * @param output the decoded bytes
 * @param consumed encoded bytes consumed
 */
public record Decoded(byte[] output, int consumed) {}
