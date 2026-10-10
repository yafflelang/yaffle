#!/bin/sh
# Compiles the Java runtime (and, with "test", runs its unit tests).
#   packages/runtime-java/build.sh [test]
# Needs a JDK 21+ (javac/java on PATH, or JAVA_HOME). Example with nix:
#   nix shell nixpkgs#jdk21 --command packages/runtime-java/build.sh test
set -e
cd "$(dirname "$0")"
JAVAC="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
JAVA="${JAVA_HOME:+$JAVA_HOME/bin/}java"
rm -rf build
mkdir -p build/classes build/test-classes
find src/main/java -name '*.java' > build/sources.txt
"$JAVAC" -Xlint:all -Werror -d build/classes @build/sources.txt
if [ "$1" = "test" ]; then
  find src/test/java -name '*.java' > build/test-sources.txt
  "$JAVAC" -Xlint:all -Werror -cp build/classes -d build/test-classes @build/test-sources.txt
  "$JAVA" -cp build/classes:build/test-classes org.yafflelang.runtime.TestMain
fi
