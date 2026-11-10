# Releasing

Pushing a tag `vX.Y.Z` runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which publishes these packages at version `X.Y.Z`. All but Maven use trusted publishing (OIDC), so no tokens are stored for them; Maven uses secrets on the `release` environment.

| Registry  | Package                         | Manifest                                                           |
| --------- | ------------------------------- | ------------------------------------------------------------------ |
| npm       | `@yafflelang/runtime`           | `packages/runtime/package.json`                                    |
| npm       | `yaffle`                        | `packages/compiler/package.json` (also its runtime dependency)     |
| crates.io | `yaffle`                        | `packages/runtime-rust/Cargo.toml`                                 |
| PyPI      | `yaffle`                        | `packages/runtime-python/pyproject.toml`                           |
| NuGet     | `Yaffle.Runtime`                | `packages/runtime-csharp/src/Yaffle.Runtime/Yaffle.Runtime.csproj` |
| Maven     | `org.yafflelang:yaffle-runtime` | `packages/runtime-java/pom.xml`                                    |

## Cutting a release

1. Set the same version in every manifest above, including the `@yafflelang/runtime` dependency in `packages/compiler/package.json`. Commit to `main` and wait for CI to pass.
2. Tag and push:

   ```sh
   git tag v0.0.2
   git push origin v0.0.2
   ```

The first job fails if any manifest doesn't match the tag. A prerelease tag (`v0.1.0-rc.1`) publishes to npm under the `next` dist-tag instead of `latest`. If a publish job fails, re-run the workflow: versions already on a registry are skipped.

## One-time setup

Every trusted publisher below uses the same values:

- Owner: `yafflelang`
- Repository: `yaffle`
- Workflow: `release.yml`
- Environment: `release`

### GitHub

Settings → Environments → New environment, named `release`. Under deployment branches and tags, allow only tags matching `v*`. You can also add yourself as a required reviewer, so each release waits for your approval before anything is published.

### npm

Do this for both `yaffle` and `@yafflelang/runtime`: open the package on npmjs.com, go to Settings → Trusted Publisher, choose GitHub Actions and enter the values above.

After the first release goes through, set Publishing access to "Require two-factor authentication and disallow tokens", then revoke any automation tokens you used for 0.0.1.

### crates.io

Go to <https://crates.io/crates/yaffle/settings> → Trusted Publishing → Add, choose GitHub and enter the values above.

### PyPI

Go to <https://pypi.org/manage/project/yaffle/settings/publishing/>, choose GitHub and enter the values above.

### NuGet

On nuget.org, open your account menu → Trusted Publishing → Create. Set the policy owner to your nuget.org account, `noahcoolboy` (it owns the package), and enter the values above. The workflow logs in as `noahcoolboy` (the `user` input of `NuGet/login`), so change it there if the policy owner changes.

### Maven Central

Central has no trusted publishing, so this one uses secrets on the `release` environment. Only jobs running for a `v*` tag can read them.

1. On <https://central.sonatype.com>, make sure the `org.yafflelang` namespace is verified (yafflelang.org has a TXT record for it).
2. Account menu → View Account → Generate User Token. This gives a username and a password.
3. Make a signing key and publish its public half, since Central checks signatures against public keyservers:

   ```sh
   gpg --quick-gen-key "yaffle releases <you@example.com>" ed25519 sign never
   gpg --keyserver keyserver.ubuntu.com --send-keys <KEY-ID>
   ```

4. Store the four secrets. Each `gh secret set` prompts for the value, so nothing lands in your shell history:

   ```sh
   gh secret set MAVEN_CENTRAL_USERNAME --env release -R yafflelang/yaffle
   gh secret set MAVEN_CENTRAL_PASSWORD --env release -R yafflelang/yaffle
   gh secret set MAVEN_GPG_PASSPHRASE --env release -R yafflelang/yaffle
   gpg --armor --export-secret-keys <KEY-ID> | gh secret set MAVEN_GPG_PRIVATE_KEY --env release -R yafflelang/yaffle
   ```

The job publishes immediately (`autoPublish`) and waits until Central reports the release as published, so a rejected upload fails the workflow.

## Not covered by this workflow

- **Go** (`yafflelang.org/go/yaffle`): there's no registry. A release is a git tag `packages/runtime-go/vX.Y.Z`, and yafflelang.org must serve a `go-import` meta tag for the module path.
- **VS Code Marketplace / Open VSX**: both use access tokens. CI already builds `yaffle.vsix` as an artifact.
- **`@yafflelang/lsp`** isn't set up for publishing: it has no `publishConfig` or `repository` field.
