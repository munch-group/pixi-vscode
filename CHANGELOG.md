# Changelog

All notable changes to the "im-pixi-vscode" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0]

Initial release of the munch-group fork.

### Fixed

- **Jupyter kernel starts no longer stall for 30 seconds.** Environments missing
  `conda-meta/pixi` are detected and repaired with `pixi install`. Without that marker the
  native locator classifies a Pixi prefix as conda, so the Python extension skips its fast
  `pixi run` path and falls back to running `pixi shell` non-interactively, which never
  returns and is killed on a 30s timeout.
- **No more leaked processes.** Subprocesses run with stdin closed, so anything that turns
  interactive sees EOF and exits, and timeouts kill the whole process _group_ rather than
  orphaning grandchildren.

- **Detects a course folder that was moved or copied after `pixi install`** and offers to rebuild
  it. A Pixi environment is not relocatable: absolute paths are baked into console script
  shebangs and Jupyter kernelspecs, so the interpreter still imports while every kernel dies on
  start. `pixi install` does not repair this — it refreshes Pixi's bookkeeping and leaves the
  baked-in paths alone, after which everything claims to be healthy while still being broken.
  The repair is `pixi clean` followed by `pixi install`, and because it deletes and re-downloads
  the environment it always asks first, even when repair is set to `auto`.

### Changed

- **Dropped the dependency on `ms-python.vscode-python-envs`.** The extension now drives the
  Python extension's stable API directly; Jupyter follows from the same source. The
  `EnvironmentManager` / `PackageManager` implementations that existed only to serve the
  environments extension were removed.
- Subprocesses are spawned without a shell, so arguments no longer need manual quoting.
- Python versions are read from `conda-meta` instead of shelling out to `pixi list` per
  environment.

### Added

- `Pixi: Run Diagnostics` — reports marker state and expected classification per environment,
  which extension owns terminal activation, and any orphaned `pixi shell` processes.
- `Pixi: Repair Environments`, `Pixi: Select Environment`, `Pixi: Refresh Environments`.
- Status bar item showing the active environment, with a warning when one is degraded.
- An offer to write `python.useEnvironmentsExtension: false`, which is the only way to take
  terminal activation back from the environments extension (the Python extension reads it
  with `inspect()` and ignores the default).

### Fork housekeeping

- Forked from [pixi-code](https://github.com/renan-r-santos/pixi-code) `v0.2.0` (commit `996c368`) by Renan Santos
- Renamed extension to `munch-group.im-pixi-vscode` with its own environment/package manager ID, so it does not collide
  with the upstream extension
- Renamed the `pixi-code.pixiExecutable` setting to `im-pixi-vscode.pixiExecutable`
- Dropped the automatic pre-release publishing jobs from CI (no marketplace tokens configured yet)

Everything below documents the upstream project's history prior to the fork.

## [0.2.0]

- Use published @vscode/python-environments API package
- Improve environment display names to match uv/venv style (e.g. `project:env (version)`)
- Sort environments alphabetically by project and environment name
- Update default `workspaceSearchPaths` to improve environment discovery performance
- Support `python-envs.workspaceSearchPaths` and `python-envs.globalSearchPaths` for environment discovery
- Fix `pixi-code.pixiExecutable` setting not being read
- Fix subprocess runner race condition between exit and close events
- Fix fire-and-forget promises in environment selection
- Remove broken `deactivate` function (VS Code handles cleanup automatically)
- Extract shared helpers and parallelize environment discovery
- Add pre-release pipeline for continuous updates on every push to main
- Revert 0.1.5 `activatedRun` change now that https://github.com/microsoft/vscode-python-debugger/pull/949 was merged
- Remove `defaultInterpreterPath` support for setting the active environment

## [0.1.5]

- Fix debugging Pixi projects in the new version of the Python Environments extension by fixing the `activatedRun`
  command.

## [0.1.4]

- Check if project path exists before running Pixi commands
- Check minimum Pixi version on activation
- Remove unsupported actions (create, quick create and remove) for better UX

## [0.1.3]

### Added

- If `defaultInterpreterPath` is set and no Pixi environment was manually selected, use it as the project's interpreter
- Publish to OpenVSX

## [0.1.2]

### Fixed

- Deduplicate envs returned by getEnvironments

## [0.1.1]

### Fixed

- Fix error messages only showing in debug mode

## [0.1.0]

### Added

- Initial release of Pixi integration for VS Code
- Implements `EnvironmentManager` and `PackageManager` interfaces for the [Python Environments
  extension](https://github.com/microsoft/vscode-python-environments)
- Automatic discovery of Python environments created with Pixi
- Automatic interpreter selection when running and debugging Python code
- Support for Pixi features (dev, test, lint, etc.) as separate selectable environments
- Terminal activation
- Persistent environment selection per project
- Package discovery

### Limitations

- Environment creation and deletion
- Adding, updating and removing packages
