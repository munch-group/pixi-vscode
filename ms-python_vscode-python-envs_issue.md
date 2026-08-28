# 30-second Jupyter kernel stall caused by `ms-python.vscode-python-envs` (pixi environments)

**Status:** confirmed locally by isolation test, 2026-08-28. Unfixed upstream.
**Impact on this extension:** we declare `extensionDependencies: ["ms-python.vscode-python-envs"]`, so every user of `munch-group.pixi-vscode` inherits this stall.

## TL;DR

With `ms-python.vscode-python-envs` installed, every Jupyter kernel start/restart in a pixi
project blocks for exactly 30 s. The Python extension tries to capture the activated
environment by running `pixi shell` — an **interactive** subshell that never exits — chained
with `&&` to the commands that actually print the environment. Those never run, and the whole
pipeline is `SIGTERM`ed at the extension's 30 s timeout. The kernel then starts normally in
~0.5 s.

Removing `ms-python.vscode-python-envs` makes the Python extension fall back to
`pixi run … python`, which is correct and returns in ~0.2 s.

## Environment

| Component                      | Version                                          |
| ------------------------------ | ------------------------------------------------ |
| macOS                          | Darwin 25.4.0 (arm64)                            |
| VS Code                        | 1.134.0                                          |
| `ms-python.python`             | 2026.4.0                                         |
| `ms-python.vscode-python-envs` | 1.36.0                                           |
| `ms-toolsai.jupyter`           | 2025.9.1                                         |
| `renan-r-santos.pixi-code`     | 0.1.5 and 0.2.0 (both installed)                 |
| pixi                           | 0.77.1                                           |
| Project interpreter            | `./.pixi/envs/default/bin/python` → `python3.14` |

## Symptom

`Output ▸ Jupyter`:

```
12:38:05.671 [info]  Restart requested ~/geneinfo/notebooks/chrom_tracks_demo.ipynb
12:38:35.739 [warn]  Failed to get activated env vars for ~/geneinfo/.pixi/envs/default/bin/python in 30014ms
12:38:35.741 [error] Unable to determine site packages path for python ~/geneinfo/.pixi/envs/default/bin/python (Unknown)
12:38:35.743 [info]  Process Execution: ~/geneinfo/.pixi/envs/default/bin/python -c "import ipykernel; ..."
12:38:36.277 [info]  Restarted 2d7853ff-4340-42ae-a58b-63d67ee67e25
```

30.07 s of stall, then 0.53 s of actual work. The kernel works correctly afterwards — the
delay is pure dead time. Reproduced on every start and restart.

## Root cause

`Output ▸ Python` shows the command being run:

```
2026-08-28 12:38:05.748 [info]  > ~/.pixi/bin/pixi shell --manifest-path ./pyproject.toml \
    && echo 'e8b39361-0157-4923-80e1-22d70d46dee6' \
    && python ~/.vscode/extensions/ms-python.python-2026.4.0-darwin-arm64/python_files/printEnvVariables.py
2026-08-28 12:38:05.748 [info]  shell: bash
2026-08-28 12:38:35.737 [error] getActivatedEnvironmentVariables [Error: Command failed: …]
  { code: null, killed: true, signal: 'SIGTERM' }
```

`pixi shell` does not activate the calling shell — it **spawns a new interactive shell**
(`bash -i`) and waits for it to exit. Under `child_process.exec` that child inherits a stdin
pipe which is never written to and never closed, so it blocks on read forever. The `&&`
chain therefore never reaches the marker `echo` or `printEnvVariables.py`, and after 30 s the
extension kills the process group.

`killed: true, signal: 'SIGTERM'` in the error confirms a timeout kill, not a command failure.

## Evidence

**1. The hang is reproducible by hand.** Running the exact logged command in a non-TTY context
never prints the marker; it had to be killed manually:

```console
$ (pixi shell --manifest-path ~/geneinfo/pyproject.toml && echo REACHED_MARKER) > out 2>&1
# … never terminates; no REACHED_MARKER in `out`
```

**2. The `ms-python.vscode-python-envs` extension is active at the exact millisecond of the
stall**, repeatedly resolving the environment and failing to identify it as pixi
(`Output ▸ Python Environments`):

```
12:38:05.719 [error] [pet] WARN pet_conda::package: Unable to find conda package Python in "~/geneinfo/.pixi/envs/default"
12:38:05.719 [info]  Resolved Python Environment ~/geneinfo/.pixi/envs/default/bin/python
        … ~10 such pairs within 30 ms …
```

This misidentification (pixi env probed as conda) is what surfaces as `(Unknown)` in the
Jupyter log line above.

**3. Everything else in the chain is fast** — the 30 s is not environmental:

| Measured                                                                           | Time              |
| ---------------------------------------------------------------------------------- | ----------------- |
| `bash -lc exit` (full login profile, incl. conda hook, gcloud, iTerm2 integration) | 0.043 s           |
| `pixi --version`                                                                   | 0.012 s           |
| `pixi shell-hook`                                                                  | 0.102 s           |
| `.pixi/envs/default/bin/python -c pass`                                            | 0.033 s           |
| `pixi run --manifest-path ./pyproject.toml python printEnvVariables.py`            | **0.22 s**        |
| `pixi shell --manifest-path … && …`                                                | **never returns** |

Note `/Users/<user>/miniconda3` does not exist on this machine, so the conda block in
`.bashrc` is a no-op — the shell profile was ruled out early.

**4. The failing command string comes from `ms-python.python`, not from `pixi-code`.**
The two builders differ in a way that identifies the emitter:

| Source                                           | Command shape                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `ms-python.python` → `getPixiActivationCommands` | `pixi shell --manifest-path <p>` (+ `--environment <n>` only when a name is set) |
| `pixi-code` 0.2.0 → `execInfo.activation`        | `pixi shell --manifest-path <p> -e <n>` (always)                                 |

The observed command has **no `-e`**, so it was built by `ms-python.python`. `pixi-code`
carries an equivalent defect but was not the emitter here.

Notably, `ms-python.python` also contains a _correct_ builder, `getRunPythonArgs`, producing
`pixi run --manifest-path <p> [--environment <n>] python`. Both live in the same bundle; the
presence of the envs extension is what selects the broken one.

## Isolation

| Configuration                                              | Kernel restart         |
| ---------------------------------------------------------- | ---------------------- |
| `vscode-python-envs` + `pixi-code` installed               | 30 s stall             |
| both removed                                               | instant                |
| **`vscode-python-envs` alone reinstalled, no `pixi-code`** | **30 s stall returns** |

The third row is the decisive test: `ms-python.vscode-python-envs` is **sufficient on its own**
to cause the stall.

`pixi-code` can be excluded as an independent cause: it declares
`extensionDependencies: ["ms-python.vscode-python-envs"]`, so it can never be installed
without the envs extension. (VS Code refuses to uninstall the envs extension while
`pixi-code` is present — remove `pixi-code` first.)

This matches upstream, where a reporter reproduced the stall **without** `pixi-code` installed
and reported that adding it "changes nothing".

## Side effect: leaked processes

`SIGTERM` reaches the wrapper shell but not the `pixi` grandchild, so **every timeout leaks a
process pair** — one `pixi shell --manifest-path …` reparented to PID 1 with no controlling
terminal, plus the `bash -i` it spawned.

On this machine after a few days: **38 orphaned pairs (76 processes)**, the oldest running
~7 days, spanning three different projects.

To find and clear them safely — note the `PPID == 1` and "no TTY" filters, which are what
distinguish leaks from `pixi shell` sessions a user legitimately started in a terminal
(a blanket `pkill -f "pixi shell"` would kill those too):

```bash
# list
ps -eo pid,ppid,tty,etime,command | awk '$2==1 && $3=="??" && $4 ~ /pixi$/ && $5=="shell" && $6=="--manifest-path"'

# kill children then parents
PIDS=$(ps -eo pid,ppid,tty,command | awk '$2==1 && $3=="??" && $4 ~ /pixi$/ && $5=="shell" && $6=="--manifest-path" {print $1}')
for p in $PIDS; do pgrep -P $p; done | xargs kill
kill $PIDS
```

## Workaround

```bash
code --uninstall-extension renan-r-santos.pixi-code        # or any dependent extension, first
code --uninstall-extension ms-python.vscode-python-envs
```

Reload the window. `ms-python.python` then uses:

```
pixi run --manifest-path ./pyproject.toml python …/printEnvVariables.py
```

Verified: 0.22 s, 192 environment variables, `PATH[0] = ~/geneinfo/.pixi/envs/default/bin`,
`CONDA_PREFIX` set correctly. This is strictly better than the previous behaviour, which
returned _nothing_ (hence the `Unable to determine site packages path` error that always
followed the timeout).

Things that do **not** work:

- `"python.terminal.activateEnvironment": false` — reported ineffective upstream.
- `"python.useEnvironmentsExtension": true` — makes it worse; upstream reports `false` (the
  default) is the working setting. Tested here: no effect, the stall persisted.
- Downgrading `ms-python.python` — the original report claimed this helped, but the reporter
  later established the Python extension version has no effect either way.

Caveat: `ms-python.vscode-python-envs` is a member of `ms-python.python`'s `extensionPack`
(not its `extensionDependencies`), so a future update of the Python extension may reinstall
it. If the 30 s stall reappears, check for it first.

## Implications for `munch-group.pixi-vscode`

1. **We depend on the broken extension.** `package.json` declares
   `extensionDependencies: ["ms-python.vscode-python-envs"]`, so installing this extension
   reintroduces the stall for every user in a pixi project. The workaround above is not
   available to them without uninstalling us too.

2. **We vendor the same `pixi shell` activation.** `src/pixi/utils.ts:144`:

    ```ts
    activation: [
        {
            executable: pixi,
            args: ['shell', '--manifest-path', manifestPath, '-e', pixiEnv.name],
        },
    ],
    deactivation: [{ executable: 'exit', args: [] }],
    ```

    The paired `deactivation: exit` shows this array is designed for a _terminal_ — send
    `pixi shell`, later send `exit` — where `pixi shell` is the right call. It is only fatal
    when a consumer reuses it for non-interactive environment capture. Directly above it,
    `activatedRun` is already correct:

    ```ts
    activatedRun: {
        executable: pixi,
        args: ['run', '--manifest-path', manifestPath, '-e', pixiEnv.name, 'python'],
    },
    ```

    Worth confirming which of the two the envs extension consumes for env-var capture, and
    whether we can express activation as `eval "$(pixi shell-hook --manifest-path <p> -e <n>)"`
    so it works in both contexts. `pixi shell-hook` prints the activation script and exits
    (0.102 s measured), unlike `pixi shell`.

3. Any fix we ship is only a partial remedy while the selection of the broken code path
   happens inside `ms-python.python` in response to the envs extension being present.

## Suggested upstream fix

Environment-variable capture must never use `pixi shell`. Either:

- use the existing `pixi run --manifest-path <p> [-e <n>] python printEnvVariables.py` path
  (already implemented in `ms-python.python` as `getRunPythonArgs`, and demonstrably working),
  or
- source the activation into the current shell: `eval "$(pixi shell-hook --manifest-path <p>)"`
  followed by the marker `echo` and the env dump.

Independently, the capture subprocess should be spawned with stdin closed (or `< /dev/null`)
so an accidental interactive child exits instead of blocking, and the timeout kill should
target the whole process group to stop the leak described above.

## References

- [microsoft/vscode-python#25804](https://github.com/microsoft/vscode-python/issues/25804) — original report; **closed** by the reporter as misfiled after isolating the cause to the envs extension.
- [microsoft/vscode-python-environments#1407](https://github.com/microsoft/vscode-python-environments/issues/1407) — the correctly-filed issue; **closed as `NOT_PLANNED`** by a stale bot on 2026-05-09, not fixed. Contains an independent derivation of the same root cause, and the observation that removing the envs extension switches `ms-python.python` to `pixi run`.
- [renan-r-santos/pixi-code#43](https://github.com/renan-r-santos/pixi-code/issues/43) — same title, **still open**; the maintainer of the envs extension redirected the problem here.
- microsoft/vscode-python-environments#1253 — dedicated issue opened by the original reporter.

---

# Update 2026-08-28 15:15 — corrected root cause

Controlled testing in `/Users/kmt/sandbox/student-folder` identified a different
cause than the one above. **The envs extension is probably not the trigger; a
missing `conda-meta/pixi` marker is.**

## The switch

`pet` (the native locator shipped by _both_ `ms-python.python` and the envs
extension) classifies a pixi prefix by its conda-meta markers:

| `conda-meta/pixi` | `conda-meta/pixi_env_prefix` | `pet resolve` reports     |
| ----------------- | ---------------------------- | ------------------------- |
| present           | present                      | `Environment (Pixi)`      |
| **absent**        | present                      | **`Environment (Conda)`** |

Verified by deleting and restoring that one file in an otherwise untouched
environment, with all three installed `pet` binaries (python-ext 2026.4.0,
envs 1.36.0, envs 1.37 pre-release) agreeing.

## Why that produces a 30 s hang

`getActivatedEnvironmentVariables` in `ms-python.python` branches on `envType`:

```js
if (n?.envType === EnvironmentType.Conda)      { ...Conda.getConda()... }
else if (n?.envType === EnvironmentType.Pixi)  { getRunPixiPythonCommand(n.path) }  // 0.10 s
```

With the marker absent the env is typed `Conda`, so the fast pixi branch is
skipped. The conda branch then calls `Conda.getConda()`, which returns nothing —
there is no conda on this machine (confirmed: no `conda` on PATH, no
`~/miniconda3`, no `~/anaconda3`). No command is produced, so control falls
through to the generic terminal-activation provider. There `isPixiEnvironment()`
_is_ still true, because it accepts **either** marker:

```js
isPixiEnvironment = async (e) =>
    pathExists(join(t, 'conda-meta/pixi')) || pathExists(join(t, 'conda-meta/pixi_env_prefix'));
```

so `PixiActivationCommandProvider` runs → `getPixiActivationCommands` →
`pixi shell` → blocks forever → 30 s SIGTERM → `Unable to determine site
packages path … (Unknown)`.

The asymmetry between the two marker checks is the defect: `pet` needs
`conda-meta/pixi` to say "Pixi", but `isPixiEnvironment` is satisfied by
`pixi_env_prefix` alone. An env with only the latter is typed conda _and_
routed to the pixi shell activator.

## Evidence this is what happened in `~/geneinfo`

| File / event                                     | Timestamp                |
| ------------------------------------------------ | ------------------------ |
| `.pixi/envs/default/conda-meta/pixi_env_prefix`  | 29 May                   |
| 30 s stall logged                                | 28 Aug 12:38             |
| 8 orphaned `pixi shell` pairs spawned            | 28 Aug 13:00–13:22       |
| **`.pixi/envs/default/conda-meta/pixi` written** | **28 Aug 14:08:21**      |
| new orphans after that                           | **none** (checked 15:15) |

The environment was built in May by a pixi that did not write `conda-meta/pixi`.
Something rewrote the marker at 14:08 (probably a `pixi install`), and the leak
stopped. **The stall in `geneinfo` may already be fixed.**

## Corrections to the analysis above

1. **§Evidence 2 is misread.** The `pet_conda::package WARN Unable to find conda
package Python` line is _not_ the misidentification — it is emitted during
   successful `Environment (Pixi)` resolutions too. It is noise from a fallback
   probe, not a signal. The real classification is `pet`'s final verdict.

2. **§Workaround, `python.useEnvironmentsExtension`.** "`false` (the default) is
   the working setting" cannot be right: `shouldEnvExtHandleActivation()` reads
   the setting with `.inspect()` and tests only `globalValue` / `workspaceValue` /
   `workspaceFolderValue`. The default is never consulted, and the key is absent
   from this machine's `settings.json`, so the lever was never actually pulled.
   Note it gates only _terminal_ activation, so pulling it is not expected to fix
   the stall either.

3. **Two independent gates, often conflated:**

    | Gate                           | Formula                                               | Controls                      | Current state |
    | ------------------------------ | ----------------------------------------------------- | ----------------------------- | ------------- |
    | `useEnvExtension`              | `installed && get('useEnvironmentsExtension', false)` | discovery/resolution takeover | **off**       |
    | `shouldEnvExtHandleActivation` | `installed && !explicit-false` (`.inspect()`)         | terminal activation           | **on**        |

    Since discovery takeover is off, the envs extension is _not_ resolving the
    interpreter — `ms-python.python` is, via the same `pet` binary. That is why
    installing/removing it should not change the classification.

4. **§Implications 3 is too pessimistic.** `ms-python.python` 2026.4.0 ships
   complete native pixi support (`PixiLocator`, `getPixiInfo`, `PixiInstaller`,
   `getRunPixiPythonCommand`, `createPixiExecutionService`). The envs extension
   is not required for pixi to work.

5. **Jupyter has no pixi awareness at all** (zero `pixi` occurrences in
   `ms-toolsai.jupyter` 2025.9.1). It consumes environments from the Python
   extension API, so there is no separate Jupyter problem to solve.

## Unresolved discrepancy

§Isolation reports that reinstalling the envs extension alone brought the stall
back, and removing it made things instant. The marker theory does not explain
that: with discovery takeover off, the classification should be identical either
way. Either the isolation runs were confounded (e.g. an intervening
`pixi install` rewriting the marker), or there is a second mechanism.

`student-folder/` contains the experiment that settles it: two environments from
the same `pixi.toml`, differing only in that one file. If only the marker-less
one stalls, the marker is the whole story.

## Implication for `munch-group.pixi-vscode`

If confirmed, the extension's job is much smaller than reimplementing an
environment manager:

1. **Detect and repair** pixi environments missing `conda-meta/pixi` (run
   `pixi install`, or warn) — this alone removes the stall.
2. **Drop `extensionDependencies` on the envs extension** — not needed for pixi.
3. **Spawn with `start_new_session` and kill the process _group_** on timeout.
   Verified here: doing so leaves zero orphans, versus the 8 currently on this
   machine from ms-python.python's plain SIGTERM.
