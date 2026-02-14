# Release packaging helpers

These scripts render package metadata from a tagged GitHub release and the
`SHA256SUMS` file uploaded by CI.

## Artifact naming

The release workflow now publishes tarballs with a stable scheme:

- `lectic-vX.Y.Z-darwin-x86_64.tar.gz`
- `lectic-vX.Y.Z-darwin-aarch64.tar.gz`
- `lectic-vX.Y.Z-linux-x86_64.tar.gz`
- `lectic-vX.Y.Z-linux-aarch64.tar.gz`

Linux AppImages are also published for direct Linux installs:

- `lectic-vX.Y.Z-linux-x86_64.AppImage`
- `lectic-vX.Y.Z-linux-aarch64.AppImage`

## Homebrew formula rendering

```bash
./extra/release/render-homebrew-formula.sh \
  --tag v0.0.2 \
  --repo gleachkr/Lectic \
  --checksums ./SHA256SUMS > lectic.rb
```

## AUR PKGBUILD rendering

```bash
./extra/release/render-aur-pkgbuild.sh \
  --tag v0.0.2 \
  --repo gleachkr/Lectic \
  --checksums ./SHA256SUMS \
  --pkgname lectic-bin > PKGBUILD
```

Render `.SRCINFO`:

```bash
./extra/release/render-aur-pkgbuild.sh \
  --tag v0.0.2 \
  --repo gleachkr/Lectic \
  --checksums ./SHA256SUMS \
  --pkgname lectic-bin \
  --srcinfo > .SRCINFO
```

## Creating a release commit and tag

Use the helper script to bump the package version and tag a release.

```bash
./extra/release/release.sh 0.0.2
```

This updates:

- `package.json`
- `package-lock.json`
- `CHANGELOG.md` (`unreleased` → UTC date)

Then it creates:

- commit: `Release v0.0.2`
- tag: `v0.0.2`

To push in one step:

```bash
./extra/release/release.sh 0.0.2 --push
```

## CI integration settings

The release workflow can publish Homebrew and AUR updates automatically.
Set these in your repository settings:

- Homebrew:
  - Variable `HOMEBREW_TAP_REPO` (for example `owner/homebrew-lectic`)
  - Optional variable `HOMEBREW_FORMULA_PATH` (default `Formula/lectic.rb`)
  - Secret `HOMEBREW_TAP_TOKEN` with push access to the tap repository
- AUR:
  - Optional variable `AUR_PACKAGE` (default `lectic-bin`)
  - Secret `AUR_SSH_PRIVATE_KEY` with push access to the AUR package repo
