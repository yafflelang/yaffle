// Checks that every package the release workflow publishes is at the version named by the tag.
//   node .github/scripts/check-release-version.ts v0.0.2
// Prints the version (without the leading "v") on success, so the workflow can capture it.
import { VERSION, mismatches } from "./release-manifests.ts";

const tag = process.argv[2] ?? "";
const version = tag.slice(1);
if (!tag.startsWith("v") || !VERSION.test(version)) {
  console.error(`Expected a tag like v1.2.3 or v1.2.3-rc.1, got "${tag}"`);
  process.exit(1);
}

const wrong = mismatches(version);
for (const line of wrong) console.error(line);
if (wrong.length > 0) process.exit(1);
console.log(version);
