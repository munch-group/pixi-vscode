import { CancellationToken, workspace } from 'vscode';
import which from 'which';

import { CONFIG_SECTION, untildify } from '../common/utils';
import { RunOptions, runProcess } from '../process/run';
import { PixiInfo } from './types';

/** Oldest Pixi we are willing to drive. */
export const MINIMUM_PIXI_VERSION = '0.53.0';

export class PixiNotFoundError extends Error {
    constructor() {
        super(
            'Pixi executable not found. Install Pixi from https://pixi.sh, or set "im-pixi-vscode.pixiExecutable" in your settings.',
        );
        this.name = 'PixiNotFoundError';
    }
}

export async function getPixiExecutable(): Promise<string> {
    const configured = workspace.getConfiguration(CONFIG_SECTION).get<string>('pixiExecutable');
    if (configured) {
        return untildify(configured);
    }

    try {
        return await which('pixi');
    } catch {
        throw new PixiNotFoundError();
    }
}

export async function runPixi(args: string[], options: RunOptions = {}): Promise<string> {
    const pixi = await getPixiExecutable();
    return runProcess(pixi, args, options);
}

export async function getPixiVersion(): Promise<string | undefined> {
    const stdout = await runPixi(['--version'], { timeoutMs: 15_000 });
    return stdout.trim().match(/^pixi (\d+\.\d+\.\d+)/)?.[1];
}

export async function getPixiInfo(projectPath: string, token?: CancellationToken): Promise<PixiInfo> {
    const stdout = await runPixi(['info', '--json'], { cwd: projectPath, timeoutMs: 30_000, token });
    return JSON.parse(stdout) as PixiInfo;
}

/**
 * Runs `pixi install`, which (re)writes `conda-meta/pixi` and so repairs an
 * environment that VS Code would otherwise misidentify as conda.
 */
export async function pixiInstall(
    manifestPath: string,
    environmentName: string,
    token?: CancellationToken,
): Promise<void> {
    await runPixi(['install', '--manifest-path', manifestPath, '--environment', environmentName], {
        timeoutMs: 10 * 60_000,
        token,
    });
}
