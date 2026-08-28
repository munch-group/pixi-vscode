<div align="center">

<img src="./assets/icon.png" alt="Pixi VSCode" width="220" height="220">

</div>

# Pixi VSCode

VS Code extension that integrates [Pixi](https://pixi.sh) environments with the [Python Environments
extension](https://github.com/microsoft/vscode-python-environments), so that Pixi environments are picked up
automatically for Python files, terminals, debugging and Jupyter notebooks.

> **Credit.** This extension is a fork of [**Pixi Code**](https://github.com/renan-r-santos/pixi-code) by [Renan
> Santos](https://github.com/renan-r-santos), MIT licensed. The first commit in this repository is an unmodified import
> of upstream `v0.2.0`; everything after it is our own. See [NOTICE](./NOTICE) for full attribution.
>
> If you are not a member of the munch-group teaching setup, you almost certainly want the original extension instead:
> [`renan-r-santos.pixi-code`](https://marketplace.visualstudio.com/items?itemName=renan-r-santos.pixi-code).

## Overview

This extension implements the `EnvironmentManager` and `PackageManager` interfaces for the [Python Environments
extension](https://github.com/microsoft/vscode-python-environments), allowing Pixi environments to appear alongside
conda, venv, and other Python environments in VS Code.

It exists as a separate fork so that we can control exactly how Pixi, Python and Jupyter interact in VS Code for
students, without waiting on upstream.

## Features

- Automatic discovery of Python environments created with Pixi
- Automatic interpreter selection when running and debugging Python code
- Support for Pixi features (dev, test, lint, etc.) as separate selectable environments
- Terminal activation
- Persistent environment selection per project
- Package discovery

## Requirements

- [Pixi](https://pixi.sh) 0.53.0 or newer, installed on your system
- Python Environments extension (`ms-python.vscode-python-envs`) — installed automatically as a dependency

## Installation

1. Install Pixi on your system
2. Install this extension (see [Building from source](#building-from-source) until it is published)
3. Open a project with a `pixi.toml` or `pyproject.toml` file

The extension will automatically discover Pixi environments and register them with the Python Environments system.

> **Do not install this alongside `renan-r-santos.pixi-code`.** Both register a Pixi environment manager, so you would
> get every environment listed twice in the picker. The extension IDs differ, so VS Code will happily install both —
> pick one.

## Extension settings

- `pixi-vscode.pixiExecutable`: Path to the Pixi executable. Leave empty to use auto-discovery (default).

Discovery also honours the Python Environments extension's own settings, `python-envs.workspaceSearchPaths` and
`python-envs.globalSearchPaths`.

## Limitations

- **Environment creation and deletion**
- **Adding, updating and removing packages**

These operations are intentionally not supported as Pixi's declarative manifest approach works best through direct CLI
interaction or editing of the `pixi.toml` or `pyproject.toml` files directly.

## Building from source

```bash
npm install
npm run compile        # development build into dist/
npx vsce package       # produces pixi-vscode-<version>.vsix
code --install-extension pixi-vscode-<version>.vsix
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development workflow.

## Tracking upstream

The upstream project is configured as the `upstream` git remote:

```bash
git fetch upstream
git diff HEAD upstream/main -- src/
```

Because commit 1 of this repository is a pristine copy of upstream, upstream changes can be reviewed and cherry-picked
without archaeology.

## Troubleshooting

### Logs

Check the "Pixi Environment Manager" output channel:

1. View → Output
2. Select "Pixi Environment Manager" from dropdown

### Common issues

**Pixi executable not found**

- Ensure Pixi is installed and in PATH
- Set `pixi-vscode.pixiExecutable` setting if needed

**No environments discovered**

- Verify `pixi.toml` or `pyproject.toml` exists in project root
- Run `pixi install` to ensure environments are set up
- Verify the environment actually contains Python — environments without a `python` package are skipped

## License

MIT — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
