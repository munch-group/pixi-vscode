#!/usr/bin/env python3
"""Check that a pixi environment exposes a usable notebook kernel, and that
VS Code will recognise it as a pixi one.

Run it *inside* the environment under test, which is where it can see what a
student's VS Code will see::

    pixi run --manifest-path <folder>/pixi.toml python scripts/check_pixi_kernel.py

This mirrors scripts/check_env_kernel.py in the instructing-machines repository
and adds the check this extension exists for.

A pixi environment carries two marker files, and the difference between them is
the whole bug:

- ``conda-meta/pixi`` is written by a current ``pixi install``.
- ``conda-meta/pixi_env_prefix`` is written by older versions too.

The native locator both the Python extension and the Python Environments
extension use needs the *first* one to report "Pixi". ``isPixiEnvironment()``
inside the Python extension accepts *either*. An environment carrying only the
second is therefore conda for the purpose of choosing how to read its
environment variables, and pixi for the purpose of activating a terminal — so
the Python extension skips its fast ``pixi run`` path, finds no conda to fall
back on, and captures environment variables by running ``pixi shell``, an
interactive subshell that never returns and is killed after 30 seconds.

Every Jupyter kernel start in such an environment pays that 30 seconds.

Exit status is 0 when the environment has a working kernel and would be
classified as pixi, and 1 with an explanation otherwise.
"""

from __future__ import annotations

import subprocess
import sys
import sysconfig
from pathlib import Path

PIXI_MARKER = "conda-meta/pixi"
PIXI_ENV_PREFIX_MARKER = "conda-meta/pixi_env_prefix"


def fail(message: str, *details: str) -> int:
    print(f"FAILED: {message}", file=sys.stderr)
    for line in details:
        print(f"        {line}", file=sys.stderr)
    return 1


def main() -> int:
    prefix = Path(sys.prefix).resolve()
    print(f"environment: {prefix}")
    print(f"python:      {sys.version.split()[0]}")

    # The kernel has to be able to start before anything about its speed
    # matters.
    try:
        import ipykernel  # noqa: F401
    except ImportError as error:
        return fail(
            "ipykernel is not importable in this environment",
            str(error),
            "without it the environment cannot back a notebook kernel at all",
        )

    probe = subprocess.run(
        [sys.executable, "-c", "import ipykernel_launcher; print('ok')"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if probe.returncode != 0:
        return fail(
            "the interpreter cannot start a kernel",
            *(probe.stderr.strip().splitlines()[-6:] or ["(no output)"]),
        )
    print("kernel:      starts")

    # The part this extension is about.
    has_pixi = (prefix / PIXI_MARKER).exists()
    has_prefix = (prefix / PIXI_ENV_PREFIX_MARKER).exists()
    print(f"{PIXI_MARKER}:             {'present' if has_pixi else 'MISSING'}")
    print(f"{PIXI_ENV_PREFIX_MARKER}: {'present' if has_prefix else 'missing'}")

    if not has_pixi:
        return fail(
            f"this environment has no {PIXI_MARKER}",
            "VS Code will classify it as a conda environment, and every Jupyter",
            "kernel start in it will take an extra 30 seconds.",
            "",
            "This is the condition munch-group.pixi-vscode detects and offers to",
            "repair. Repair it by hand with:",
            "    pixi install --manifest-path <folder>/pixi.toml",
        )

    print(f"platform:    {sysconfig.get_platform()}")
    print("\nOK: kernel starts, and this will be classified as a pixi environment.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
