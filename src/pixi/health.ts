import * as fs from 'fs-extra';
import * as path from 'path';

import { traceVerbose } from '../common/logging';
import { canonicalPath } from '../common/utils';
import { EnvironmentHealth, PixiEnvironment } from './types';

/**
 * Written by `pixi install`. Its *absence* is the bug: the native locator used
 * by the Python extension falls back to conda detection and reports
 * `Environment (Conda)` instead of `Environment (Pixi)`.
 */
export const PIXI_MARKER = path.join('conda-meta', 'pixi');

/**
 * Written by older Pixi versions too. `isPixiEnvironment()` in the Python
 * extension accepts *either* marker, which is what makes a marker-less
 * environment both "conda" (for interpreter resolution) and "pixi" (for
 * terminal activation) at the same time — the combination that ends in
 * `pixi shell` being run non-interactively.
 */
export const PIXI_ENV_PREFIX_MARKER = path.join('conda-meta', 'pixi_env_prefix');

/**
 * Detects a folder moved after `pixi install`.
 *
 * A Pixi environment is not relocatable: absolute paths are baked into console
 * script shebangs and Jupyter kernelspecs at install time. After a move the
 * interpreter still runs — plain imports do not care — so nothing obvious looks
 * wrong, while `jupyter` fails with "bad interpreter" and any kernel VS Code
 * launches dies immediately.
 *
 * Three signals, strongest first. More than one is needed because `pixi
 * install` rewrites the bookkeeping without fixing the baked-in paths, so an
 * environment that has been moved *and* then reinstalled looks correct by the
 * marker alone while still being broken.
 */
async function isRelocated(prefix: string): Promise<boolean> {
    // Symlinks have to be resolved on both sides. On macOS a shebang records
    // /private/tmp/... for an environment VS Code and pixi both call /tmp/...,
    // and a plain string comparison then reports every such environment as
    // moved. canonicalPath falls back to the original string when the path does
    // not exist, which is exactly the relocated case and still compares
    // correctly against the resolved prefix.
    const root = canonicalPath(prefix);
    const inside = (candidate: string) => {
        const resolved = canonicalPath(candidate);
        return resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    };

    // 1. The kernelspec. Cross-platform, and it is precisely what Jupyter runs.
    try {
        const kernelsDir = path.join(prefix, 'share', 'jupyter', 'kernels');
        for (const entry of await fs.readdir(kernelsDir)) {
            const kernelFile = path.join(kernelsDir, entry, 'kernel.json');
            if (!(await fs.pathExists(kernelFile))) {
                continue;
            }
            const argv = (await fs.readJson(kernelFile))?.argv;
            if (Array.isArray(argv) && typeof argv[0] === 'string' && path.isAbsolute(argv[0]) && !inside(argv[0])) {
                traceVerbose(`Kernelspec ${kernelFile} points outside its environment: ${argv[0]}`);
                return true;
            }
        }
    } catch {
        // No kernels directory, or unreadable; fall through to the next signal.
    }

    // 2. Console script shebangs. Only Python ones matter: a script generated
    //    by pip or conda hardcodes the interpreter it was installed against, so
    //    it is the thing that breaks. Plenty of packages ship shell scripts
    //    starting `#!/bin/sh`, which are absolute, outside the prefix, and
    //    entirely correct — flagging those was a false positive on every
    //    healthy environment.
    //
    //    POSIX only. On Windows these are .exe launchers with the path embedded
    //    in the binary, which is not worth parsing when signal 3 still applies.
    try {
        const binDir = path.join(prefix, 'bin');
        const entries = await fs.readdir(binDir);
        // Likely Python console scripts first, so the usual case reads one file.
        const likely = ['jupyter', 'ipython', 'pip', 'wheel', 'pygmentize', 'jupyter-kernel', 'normalizer'];
        const ordered = [
            ...likely.filter((name) => entries.includes(name)),
            ...entries.filter((name) => !likely.includes(name)).slice(0, 200),
        ];

        for (const entry of ordered) {
            const file = path.join(binDir, entry);
            let head: string;
            try {
                const handle = await fs.open(file, 'r');
                const { buffer, bytesRead } = await fs.read(handle, Buffer.alloc(256), 0, 256, 0);
                await fs.close(handle);
                head = buffer.subarray(0, bytesRead).toString('utf-8');
            } catch {
                continue;
            }
            if (!head.startsWith('#!')) {
                continue;
            }

            const interpreter = head.slice(2).trim().split(/\s+/)[0];
            if (!path.isAbsolute(interpreter) || !/^python/i.test(path.basename(interpreter))) {
                continue;
            }
            if (!inside(interpreter)) {
                traceVerbose(`Script ${file} has a shebang outside its environment: ${interpreter}`);
                return true;
            }
            return false; // A Python shebang pointing inside settles it.
        }
    } catch {
        // No bin directory; fall through.
    }

    // 3. Pixi's own record of where the environment lives. Weakest, because a
    //    bare `pixi install` refreshes it even when the environment is still
    //    broken, but it is the only one that works on Windows.
    try {
        const recorded = (await fs.readFile(path.join(prefix, PIXI_ENV_PREFIX_MARKER), 'utf-8')).trim();
        if (recorded && !inside(recorded)) {
            traceVerbose(`Recorded environment prefix ${recorded} is not inside ${prefix}`);
            return true;
        }
    } catch {
        // Marker absent; missingPixiMarker covers that case.
    }

    return false;
}

export async function assessHealth(prefix: string, pythonPath: string | undefined): Promise<EnvironmentHealth> {
    if (!(await fs.pathExists(prefix))) {
        return 'notInstalled';
    }
    // Checked before the marker, because the repair for a relocated environment
    // rewrites the marker too, while the marker repair leaves a moved
    // environment broken.
    if (await isRelocated(prefix)) {
        return 'relocated';
    }
    if (!(await fs.pathExists(path.join(prefix, PIXI_MARKER)))) {
        return 'missingPixiMarker';
    }
    if (!pythonPath) {
        return 'noPython';
    }
    return 'healthy';
}

export function isDegraded(env: PixiEnvironment): boolean {
    return env.health !== 'healthy';
}

/** True when the environment will trigger the 30-second Jupyter kernel stall. */
export function causesKernelStall(env: PixiEnvironment): boolean {
    return env.health === 'missingPixiMarker';
}

/** True when the environment must be rebuilt rather than merely reinstalled. */
export function needsRebuild(env: PixiEnvironment): boolean {
    return env.health === 'relocated';
}

export function describeHealth(health: EnvironmentHealth): string {
    switch (health) {
        case 'healthy':
            return 'healthy';
        case 'relocated':
            return 'the folder was moved after `pixi install` — console scripts and Jupyter kernels still point at the old location, so the kernel will die on start';
        case 'missingPixiMarker':
            return 'missing conda-meta/pixi — will be misread as a conda environment and stall Jupyter kernels by 30s';
        case 'notInstalled':
            return 'not installed — run `pixi install`';
        case 'noPython':
            return 'no Python interpreter found in the environment';
    }
}
