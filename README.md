<div align="center">

<img src="./images/icon.png" alt="Pixi VSCode" width="200" height="200">

</div>

# Pixi VSCode

Makes VS Code use the Python interpreter and Jupyter kernel from your project's `.pixi`
environment — automatically, and without the 30-second kernel stall.

> **Credit.** This extension began as a fork of [**Pixi Code**](https://github.com/renan-r-santos/pixi-code) by [Renan
> Santos](https://github.com/renan-r-santos), MIT licensed. The first commit in this repository is an unmodified import
> of upstream `v0.2.0`; the architecture has since diverged (see below). Several utility modules are still upstream's.
> See [NOTICE](./NOTICE) for full attribution.

## Why this exists

Upstream `pixi-code` implements an `EnvironmentManager` for the [Python Environments
extension](https://github.com/microsoft/vscode-python-environments) and therefore depends on it. That extension is the
subject of a long-standing bug that makes **every Jupyter kernel start and restart in a Pixi project block for exactly
30 seconds**, leaking a pair of orphaned processes each time.

Investigating it turned up a different root cause than the one reported upstream, and a much smaller fix. See
[`ms-python_vscode-python-envs_issue.md`](./ms-python_vscode-python-envs_issue.md) for the full write-up.

### The 30-second stall, briefly

`pixi install` writes a marker file at `<prefix>/conda-meta/pixi`. Environments created by older Pixi versions only have
`conda-meta/pixi_env_prefix`. That difference matters more than it looks:

| Check                  | Reads                  | Marker-less env         |
| ---------------------- | ---------------------- | ----------------------- |
| `pet` (native locator) | `conda-meta/pixi` only | classifies it **conda** |
| `isPixiEnvironment()`  | **either** marker      | classifies it **pixi**  |

So a marker-less environment is simultaneously "conda" for interpreter resolution and "pixi" for terminal activation.
The Python extension therefore skips its fast `pixi run` path, finds no conda to fall back to, and ends up running
`pixi shell` — an interactive subshell — to capture environment variables non-interactively. It never returns, and is
killed after 30 s.

**The fix is to run `pixi install` so the marker exists.** This extension detects the condition and offers to do it.

## What it does

- **Discovers** Pixi environments from `pixi.toml` and Pixi-enabled `pyproject.toml` manifests
- **Selects** the environment as the Python interpreter — Jupyter derives its kernel from the same source, so notebooks
  follow automatically
- **Detects and repairs** environments missing `conda-meta/pixi`, which is what causes the stall
- **Reports** the whole picture via `Pixi: Run Diagnostics`, including any orphaned `pixi shell` processes
- **Never leaks processes**: subprocesses run with stdin closed and are killed by process _group_ on timeout

It talks directly to the Python extension's stable API, so **the Python Environments extension is not required**.

## Requirements

- [Pixi](https://pixi.sh) 0.53.0 or newer
- Python extension (`ms-python.python`) — installed automatically as a dependency
- Jupyter extension (`ms-toolsai.jupyter`) for notebooks

## Commands

| Command                      | Description                                             |
| ---------------------------- | ------------------------------------------------------- |
| `Pixi: Select Environment`   | Pick the environment for a workspace folder             |
| `Pixi: Refresh Environments` | Re-scan for Pixi projects                               |
| `Pixi: Repair Environments`  | Run `pixi install` on environments missing their marker |
| `Pixi: Run Diagnostics`      | Write a full support report to the output channel       |
| `Pixi: Show Logs`            | Open the Pixi output channel                            |

## Settings

| Setting                                         | Default     | Description                                                           |
| ----------------------------------------------- | ----------- | --------------------------------------------------------------------- |
| `im-pixi-vscode.pixiExecutable`                 | `""`        | Path to Pixi. Empty means auto-discovery.                             |
| `im-pixi-vscode.searchDepth`                    | `2`         | Directory levels below each workspace folder to search for manifests. |
| `im-pixi-vscode.autoSelectEnvironment`          | `true`      | Select the Pixi environment automatically.                            |
| `im-pixi-vscode.defaultEnvironmentName`         | `"default"` | Which environment to pick when nothing is chosen yet.                 |
| `im-pixi-vscode.repairEnvironments`             | `"prompt"`  | `prompt` / `auto` / `off` for marker repair.                          |
| `im-pixi-vscode.configureEnvironmentsExtension` | `"prompt"`  | Whether to offer setting `python.useEnvironmentsExtension`.           |
| `im-pixi-vscode.showStatusBarItem`              | `true`      | Show the active environment in the status bar.                        |

### About `python.useEnvironmentsExtension`

If the Python Environments extension is installed it takes over **environment discovery and terminal activation** from
the Python extension, while having no Pixi support of its own. The result is that a Pixi environment is not found and
the interpreter falls back to a system Python.

This bites hardest on a **new VS Code profile**, which is what a new student has. The setting is tagged `onExP` — an
experiment flag — so a fresh install can be enrolled with it switched on. Observed on a clean profile: this extension
selects the Pixi interpreter, and 300ms later the environments extension replaces it with `/usr/local/bin/python3`.

Writing an explicit `false` is the only thing that settles it, which is why `im-pixi-vscode.configureEnvironmentsExtension`
defaults to `auto` rather than asking. Two details matter:

- The two gates behave differently. Discovery is read with `get()`, so an experiment-supplied default counts. Terminal
  activation is read with `inspect()`, which consults **only explicitly written values** — its declared default of
  `false` is never honoured.
- The Python extension reads the flag once and caches it for the session, so the setting does not take effect until the
  window reloads. The extension offers the reload rather than leaving it half-applied.

If you ship a course folder, putting `"python.useEnvironmentsExtension": false` in its `.vscode/settings.json` avoids
the first-run reload entirely.

## Automatic environment selection

Auto-selection deliberately does not fight you: if the active interpreter is already a Pixi environment **from the same
project**, your choice is left alone. It only steps in when the interpreter is something else (a global Python, a venv,
or nothing). Set `im-pixi-vscode.autoSelectEnvironment` to `false` to disable it entirely.

## Limitations

Creating and deleting environments, and adding or removing packages, are intentionally not supported. Pixi's declarative
manifest works best when edited directly or driven from the CLI.

## Troubleshooting

Run **`Pixi: Run Diagnostics`** first — it reports the Pixi version, every discovered environment with its marker state
and expected classification, which extension owns terminal activation, and any leaked `pixi shell` processes.

**Kernels still take 30 seconds.** Check the diagnostics report for `expected classification: Conda (WRONG …)`. Run
`Pixi: Repair Environments`, then reload the window so the Python extension re-scans.

**No environments discovered.** Verify a `pixi.toml` (or a `pyproject.toml` with a `[tool.pixi]` section) exists, run
`pixi install`, and raise `im-pixi-vscode.searchDepth` if the project is nested deeply.

**Pixi executable not found.** Ensure Pixi is on `PATH`, or set `im-pixi-vscode.pixiExecutable`.

## Development

```bash
npm install
npm run compile        # development build into dist/
npx vsce package       # produces im-pixi-vscode-<version>.vsix
```

Press `F5` to launch an Extension Development Host. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Tracking upstream

Upstream is configured as the `upstream` git remote. Commit 1 of this repository is a pristine copy of upstream
`v0.2.0`, so its changes can be diffed without archaeology:

```bash
git fetch upstream
git diff HEAD upstream/main -- src/
```

## License

MIT — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
