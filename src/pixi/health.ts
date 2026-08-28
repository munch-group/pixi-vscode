import * as fs from 'fs-extra';
import * as path from 'path';

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

export async function assessHealth(prefix: string, pythonPath: string | undefined): Promise<EnvironmentHealth> {
    if (!(await fs.pathExists(prefix))) {
        return 'notInstalled';
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

export function describeHealth(health: EnvironmentHealth): string {
    switch (health) {
        case 'healthy':
            return 'healthy';
        case 'missingPixiMarker':
            return 'missing conda-meta/pixi — will be misread as a conda environment and stall Jupyter kernels by 30s';
        case 'notInstalled':
            return 'not installed — run `pixi install`';
        case 'noPython':
            return 'no Python interpreter found in the environment';
    }
}
