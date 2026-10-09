package dev.yaffle.runtime;

/**
 * The structure the layout engine matches {@code layout} paths against: the placeables reachable
 * from a struct instance ({@link LStruct}), an array ({@link LArray}) or one target ({@link
 * Placeable}).
 */
public sealed interface LEntry permits LStruct, LArray, Placeable {}
