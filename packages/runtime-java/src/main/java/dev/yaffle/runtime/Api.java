package dev.yaffle.runtime;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;

/** Glue used by the generated root classes ({@code X.parse}, {@code X.serialize}, …). */
public final class Api {
  private Api() {}

  /** Async entry points run the (blocking) generated code on virtual threads. */
  private static final Executor ASYNC = r -> Thread.ofVirtual().name("yaffle").start(r);

  /** Runs a generated root reader over {@code bytes}. */
  public static <T> T parse(byte[] bytes, boolean strict, Function<Reader, T> read) {
    if (bytes == null) throw new YaffleException(ErrorCode.INPUT, "expected bytes, got null");
    return read.apply(new Reader(bytes, strict));
  }

  /** Runs a generated root writer in a fresh root region and returns the bytes. */
  public static byte[] serialize(LayoutItem[] layout, Function<Writer, LEntry> write) {
    Region region = new Region();
    region.layout = layout;
    Writer.attach(region, write.apply(new Writer(region)));
    return region.finish();
  }

  /** Runs a writer callback in a fresh region and returns the bytes (view encoders). */
  public static byte[] encode(Consumer<Writer> write) {
    Region region = new Region();
    write.accept(new Writer(region));
    return region.finish();
  }

  /** Runs {@code f} on a virtual thread (async codecs block there while their futures complete). */
  public static <T> CompletableFuture<T> async(Supplier<T> f) {
    return CompletableFuture.supplyAsync(f, ASYNC);
  }
}
