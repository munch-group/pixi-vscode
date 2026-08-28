# Release Process

## Prerequisites

Publishing requires a `munch-group` publisher on the [VS Code
Marketplace](https://marketplace.visualstudio.com/manage) and/or [OpenVSX](https://open-vsx.org), plus these repository
secrets:

- `MARKETPLACE_TOKEN` — Azure DevOps PAT with Marketplace → Manage scope
- `OPENVSX_TOKEN` — OpenVSX access token

Until those exist, `.github/workflows/release.yaml` will fail if a `v*` tag is pushed, and no pre-release is published
on merges to `main` (those jobs were removed from CI in the fork).

## Stable release

1. **Create a PR updating `package.json` version, `package-lock.json` and `CHANGELOG.md`**

2. **Merge PR**

3. **Create git tag**

    ```bash
    git tag vx.x.x
    git push origin vx.x.x
    ```

4. **Verify GitHub Actions**
    - Check that the release workflow runs successfully

## Local install (no marketplace needed)

```bash
npm ci
npx vsce package
code --install-extension pixi-vscode-<version>.vsix
```
