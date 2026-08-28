#!/usr/bin/env bash
#
# Open a pixi project the way a student opens it, in a VS Code that has never
# seen it before, with this extension installed and nothing else that knows
# about pixi.
#
# This mirrors scripts/vscode_kernel_smoketest.sh in the instructing-machines
# repository, and exists for the same reason. VS Code remembers the kernel you
# chose *per folder path*, and your extensions, settings and environment
# history live in your user profile. So the second time you test a folder it
# cannot fail, and it cannot fail on your machine at all once you have selected
# the kernel there once. Every ingredient of the test has to be new: a folder
# path that has never been opened, and a VS Code profile that has never been
# used.
#
# It also tests the one thing this extension is for. An environment missing
# .pixi/envs/*/conda-meta/pixi is classified as conda rather than pixi, and
# every Jupyter kernel start in it takes an extra 30 seconds. --stalled builds
# exactly that environment, so you can watch the extension notice it, offer to
# repair it, and make it fast.
#
# What it does:
#
#   1. builds the extension into a .vsix
#   2. creates a pixi project at a fresh temporary path
#   3. runs `pixi install` in it, like a student would
#   4. optionally breaks it (--stalled) by deleting the marker file
#   5. installs the extensions into a throwaway profile
#   6. checks the environment from the outside (pet) and the inside
#      (scripts/check_pixi_kernel.py)
#   7. opens it in a VS Code with a throwaway user-data-dir and extensions-dir
#
# One thing will look broken and is not. VS Code opens every new folder in
# Restricted Mode without asking (the default of
# security.workspace.trust.startupPrompt changed from "once" to "never" in
# 1.126), and while a folder is untrusted its extensions do not run — including
# this one, so nothing will happen until you trust it. That is what a student
# gets. Pass --trusted to skip it while iterating on the extension itself.
#
# Usage:
#
#     scripts/vscode_kernel_smoketest.sh                # healthy environment
#     scripts/vscode_kernel_smoketest.sh --stalled      # reproduce the 30s stall
#     scripts/vscode_kernel_smoketest.sh --trusted      # skip Restricted Mode
#     scripts/vscode_kernel_smoketest.sh --with-pixi-code   # alongside upstream
#     scripts/vscode_kernel_smoketest.sh --no-vscode    # steps 1-6 only
#
# It deliberately does not clean up after itself: the folder it made is the
# evidence. It prints the path and the command to remove it.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STALLED=0
TRUSTED=0
WITH_PIXI_CODE=0
LAUNCH_VSCODE=1

for arg in "$@"; do
    case "$arg" in
        --stalled)        STALLED=1 ;;
        --trusted)        TRUSTED=1 ;;
        --with-pixi-code) WITH_PIXI_CODE=1 ;;
        --no-vscode)      LAUNCH_VSCODE=0 ;;
        -h|--help)        awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' \
                              "${BASH_SOURCE[0]}"; exit 0 ;;
        *)                echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

command -v pixi >/dev/null || { echo "error: pixi is not on PATH" >&2; exit 1; }

# A fresh path every run. This is the part that makes the test mean anything:
# VS Code keys its remembered kernel on the folder path, so reusing a path
# tests nothing.
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/pixi-vscode-smoketest.XXXXXXXX")"
FOLDER="$SANDBOX/course-folder"
echo "sandbox: $SANDBOX"
echo

echo "==> 1/7  building the extension"
( cd "$REPO" && npm run --silent compile >/dev/null && npx --yes @vscode/vsce package --out "$SANDBOX/pixi-vscode.vsix" >/dev/null )
echo "    $(du -h "$SANDBOX/pixi-vscode.vsix" | cut -f1) vsix"

echo "==> 2/7  writing a pixi project at a path VS Code has never seen"
mkdir -p "$FOLDER/.vscode"
cat > "$FOLDER/pixi.toml" <<'EOF'
[workspace]
name = "course-folder"
channels = ["conda-forge"]
platforms = ["osx-arm64", "osx-64", "win-64", "linux-64"]

[dependencies]
python = ">=3.13,<3.14"
ipykernel = ">=7,<8"
EOF

# Deliberately minimal. The point of this extension is that a pixi project
# needs no python-envs.* settings to be found, so setting any here would test
# the settings rather than the extension.
cat > "$FOLDER/.vscode/settings.json" <<'EOF'
{
    // Intentionally almost empty. munch-group.pixi-vscode is supposed to find
    // the environment in .pixi without being told where to look. If this file
    // has to grow to make the kernel work, that is a bug in the extension.
    "jupyter.notebookFileRoot": "${workspaceFolder}"
}
EOF

cat > "$FOLDER/notebook.ipynb" <<'EOF'
{
 "cells": [
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": [
    "import sys\n",
    "print(sys.executable)\n",
    "assert '.pixi' in sys.executable, 'not running in the pixi environment!'"
   ]
  }
 ],
 "metadata": {"language_info": {"name": "python"}},
 "nbformat": 4,
 "nbformat_minor": 5
}
EOF
echo "    $FOLDER"

echo "==> 3/7  pixi install (this is the slow one)"
pixi install --manifest-path "$FOLDER/pixi.toml"

PREFIX="$FOLDER/.pixi/envs/default"

echo "==> 4/7  environment state"
if [ "$STALLED" -eq 1 ]; then
    # This is the whole point of --stalled. An environment built by an older
    # pixi has no conda-meta/pixi, and deleting it reproduces that exactly.
    rm -f "$PREFIX/conda-meta/pixi"
    echo "    DELETED $PREFIX/conda-meta/pixi"
    echo "    this environment should now stall every kernel start by 30 seconds"
else
    echo "    left healthy (pass --stalled to reproduce the 30s kernel stall)"
fi

echo "==> 5/7  installing extensions into a throwaway profile"
# VS Code opens a unix domain socket inside --user-data-dir, and those paths
# are capped just above 103 characters by the OS. On macOS $TMPDIR is already
# ~48 characters before anything of ours is appended, so a user-data-dir under
# it overflows and VS Code exits with "listen EINVAL: invalid argument" having
# printed nothing to the terminal and drawn no window. Keeping the profile
# under /tmp with a short name buys back about forty characters.
USER_DATA="$(mktemp -d /tmp/pxvsc.XXXXXXXX)"
EXTENSIONS="$SANDBOX/vscode-extensions"
mkdir -p "$USER_DATA" "$EXTENSIONS"

# Fail loudly rather than repeat the silent exit this replaced.
SOCKET_PATH="$USER_DATA/1.13-main.sock"
if [ ${#SOCKET_PATH} -gt 100 ]; then
    echo "error: the VS Code profile path is too long for its IPC socket:" >&2
    echo "       $SOCKET_PATH (${#SOCKET_PATH} chars, limit ~103)" >&2
    echo "       VS Code would exit silently. Set TMPDIR to something shorter." >&2
    exit 1
fi

command -v code >/dev/null || {
    echo
    echo "error: the 'code' command is not on PATH, so VS Code cannot be started" >&2
    echo "       On a Mac: run 'Shell Command: Install code command in PATH' from" >&2
    echo "       the command palette in VS Code, then run this again." >&2
    echo "       The folder is ready at: $FOLDER" >&2
    exit 1
}

# ms-python.python drags its extension pack in with it, which includes
# ms-python.vscode-python-envs. That is realistic — a student gets it whether
# they ask for it or not — and this extension is written to work with it
# present. Quarto is not installed: it is a course concern, not this one's.
for extension in ms-python.python ms-toolsai.jupyter; do
    code --user-data-dir "$USER_DATA" --extensions-dir "$EXTENSIONS" \
         --install-extension "$extension" --force 2>&1 | sed 's/^/    /'
done
if [ "$WITH_PIXI_CODE" -eq 1 ]; then
    echo "    also installing upstream renan-r-santos.pixi-code, to test coexistence"
    code --user-data-dir "$USER_DATA" --extensions-dir "$EXTENSIONS" \
         --install-extension renan-r-santos.pixi-code --force 2>&1 | sed 's/^/    /'
fi
code --user-data-dir "$USER_DATA" --extensions-dir "$EXTENSIONS" \
     --install-extension "$SANDBOX/pixi-vscode.vsix" --force 2>&1 | sed 's/^/    /'

echo "==> 6/7  checking the environment, from outside and inside"
# From outside: the same binary the Python extension uses to classify
# environments. Its verdict here is what decides whether kernel starts are fast
# or pay the 30 second penalty, so it is the single most predictive check.
PET="$(find "$EXTENSIONS" -path '*/python-env-tools/bin/pet' -type f 2>/dev/null | head -1)"
if [ -n "$PET" ]; then
    VERDICT="$("$PET" resolve "$PREFIX/bin/python" 2>/dev/null | grep -oE '^Environment \(\w+\)' || echo 'Environment (unknown)')"
    echo "    pet says: $VERDICT"
    case "$VERDICT" in
        *Pixi*)  echo "              -> fast path, kernels start normally" ;;
        *Conda*) echo "              -> WRONG, and the reason kernel starts take 30s" ;;
    esac
else
    echo "    (pet not found in the throwaway profile; skipping)"
fi

# From inside: can this environment actually back a kernel at all.
#
# Note the interpreter is invoked directly rather than through `pixi run`.
# `pixi run` reconciles the environment before executing anything, and that
# rewrites conda-meta/pixi — so running the check that way repairs the very
# condition --stalled sets up, and reports a healthy environment every time.
# (Worth knowing outside this script too: running any pixi task in a project is
# enough to fix a marker-less environment.)
PY_EXE="$PREFIX/bin/python"
[ -x "$PY_EXE" ] || PY_EXE="$PREFIX/python.exe"
"$PY_EXE" "$REPO/scripts/check_pixi_kernel.py" 2>&1 | sed 's/^/    /' || true

if [ "$LAUNCH_VSCODE" -eq 0 ]; then
    echo
    echo "Stopping before VS Code, as asked."
    echo "Remove the sandbox with:  rm -rf $SANDBOX $USER_DATA"
    exit 0
fi

echo
echo "==> 7/7  opening VS Code"
echo
STEP=1
if [ "$TRUSTED" -eq 0 ]; then
    echo "  $STEP. TRUST. Bottom left, click the blue 'Restricted Mode' button, then"
    echo "     'Trust', then close the panel. Nothing asked you to. Until you do"
    echo "     it every extension in this window is switched off, including the"
    echo "     one under test, so nothing below will happen."
    STEP=$((STEP + 1))
fi
cat <<EOF
  $STEP. STATUS BAR, bottom right: expect a pixi glyph and 'course-folder:default'.
     If the glyph is a broken box, the icon font did not load.
EOF
STEP=$((STEP + 1))
cat <<EOF
  $STEP. Open notebook.ipynb. Top right, Select Kernel. The environment under
     .pixi should be offered WITHOUT you having pointed at it in settings.
  $((STEP + 1)). Run the cell. It asserts it is running inside .pixi, so a green tick
     is the interpreter check passing.
  $((STEP + 2)). Open Output (bottom panel) and select 'Jupyter'. Restart the kernel and
     read the elapsed time between 'Restart requested' and 'Restarted'.
EOF
if [ "$STALLED" -eq 1 ]; then
cat <<EOF

     THIS RUN IS THE BROKEN ONE. Expect roughly 30 seconds, and a line saying
     'Failed to get activated env vars ... in 30014ms'.

  $((STEP + 3)). The extension should have offered to repair it on startup. Accept, or
     run 'Pixi: Repair Environments' from the command palette.
  $((STEP + 4)). Reload the window, then restart the kernel again. It should now be
     under a second. That difference is the entire point of this extension.
EOF
else
cat <<EOF

     Expect well under a second. If it takes 30, the classification above was
     wrong and this is the bug the extension is meant to prevent.
EOF
fi
cat <<EOF

Also worth a look while you are in there:
  - 'Pixi: Run Diagnostics' — writes a report to Output -> Pixi. It lists every
    environment with its marker state and expected classification, says which
    extension owns terminal activation, and scans for orphaned 'pixi shell'
    processes left behind by earlier timeouts.
  - Click the status bar item to open the environment picker.
  - Output -> Python shows whether environment capture used 'pixi run' (fast)
    or 'pixi shell' (the stall).

Remove the sandbox when you are done:  rm -rf $SANDBOX $USER_DATA

EOF

# Spelled out twice rather than built as an array. macOS ships bash 3.2, where
# expanding an empty array under `set -u` is an "unbound variable" error, so the
# tidy version of this fails on exactly the platform the course targets.
if [ "$TRUSTED" -eq 1 ]; then
    code --user-data-dir "$USER_DATA" --extensions-dir "$EXTENSIONS" \
         --disable-workspace-trust --new-window "$FOLDER"
else
    code --user-data-dir "$USER_DATA" --extensions-dir "$EXTENSIONS" \
         --new-window "$FOLDER"
fi
