// Cuts a release: sets every manifest to the new version, commits, and tags. Doesn't push.
//   npm run release -- 0.0.3
// See RELEASING.md.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { VERSION, fields, mismatches } from "./release-manifests.ts";

const GO_TAG_PREFIX = "packages/runtime-go/";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const git = (...args: string[]) => run("git", args);

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!VERSION.test(version)) fail("Usage: npm run release -- <version>, e.g. 0.0.3 or 0.1.0-rc.1");
const tags = [`v${version}`, `${GO_TAG_PREFIX}v${version}`];

// Release only what CI has already passed on main.
if (git("status", "--porcelain")) fail("The working tree has changes; commit or stash them first.");
if (git("branch", "--show-current") !== "main") fail("Releases are cut from main.");
git("fetch", "--quiet", "origin", "main");
const head = git("rev-parse", "HEAD");
if (head !== git("rev-parse", "origin/main")) fail("main isn't in sync with origin/main.");
for (const tag of tags) {
  if (git("tag", "--list", tag) || git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) {
    fail(`Tag ${tag} already exists.`);
  }
}

const [ci] = JSON.parse(
  run("gh", [
    "run",
    "list",
    "--workflow",
    "ci.yml",
    "--commit",
    head,
    "--json",
    "status,conclusion,url"
  ])
) as { status: string; conclusion: string; url: string }[];
if (!ci) fail(`CI hasn't run on ${head.slice(0, 7)}.`);
if (ci.status !== "completed") fail(`CI is still running on ${head.slice(0, 7)}: ${ci.url}`);
if (ci.conclusion !== "success") fail(`CI ${ci.conclusion} on ${head.slice(0, 7)}: ${ci.url}`);

// Bump every manifest, then the lockfile.
const paths = [...new Set(fields.map(field => field.path))];
for (const path of paths) {
  let text = readFileSync(path, "utf8");
  for (const field of fields) if (field.path === path) text = field.write(text, version);
  writeFileSync(path, text);
}
run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);

const wrong = mismatches(version);
if (wrong.length > 0) fail(wrong.join("\n") + "\nUndo with: git checkout -- .");

git("add", ...paths, "package-lock.json");
git("commit", "--quiet", "-m", `chore: release ${version}`);
for (const tag of tags) git("tag", "-a", tag, "-m", `yaffle ${version}`);

console.log(`Committed and tagged ${tags.join(" and ")}. To publish:

  git push --atomic origin main ${tags.join(" ")}

To undo instead:

  git tag -d ${tags.join(" ")} && git reset --hard HEAD~1`);
