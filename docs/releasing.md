# Releasing

Installers for macOS, Windows and Linux are built by the [Release workflow](../.github/workflows/release.yml) when a version tag is pushed.

## Cut a release

1. Bump `version` in [`app/package.json`](../app/package.json) and commit it, for example `chore(app): bump version to 0.3.0`.
2. Tag that commit with the same version, prefixed with `v`, and push the tag:

   ```sh
   git tag v0.3.0
   git push origin v0.3.0
   ```

3. Each platform builds its installer and uploads it to one draft release on GitHub.
4. Once every job is green, edit the draft, write the release notes, and publish it.

Installed apps check for a newer published release on launch, download it in the background and install it when the user restarts from the banner or quits, so a release reaches existing users only once it is published. The update reads the `latest*.yml` files each job uploads next to its installers, so keep them in the release; macOS updates from the `.zip`, not the `.dmg`.

On macOS the update installs only when the installed app and the new release are signed with the same Developer ID (see below). An unsigned build skips the download and shows a **Download** button that opens the release page instead, so users of unsigned builds install the first signed release by hand.

## Code signing

macOS signing and notarization run only when these repository secrets are set: `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Without them the `.dmg` is unsigned. Windows and Linux installers are not signed yet. The [README](../README.md#install) tells users how to open unsigned installers.

## Build an installer locally

```sh
npm run dist -w @gnomi/app
```

This builds an installer for your own platform into `app/dist/` without publishing anything.
