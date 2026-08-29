import * as fs from 'fs-extra';
import * as path from 'path';
import { extensions, LogOutputChannel, version as vscodeVersion, workspace } from 'vscode';

import { JUPYTER_EXTENSION_ID, PYTHON_EXTENSION_ID, samePath } from '../common/utils';
import { PixiEnvironmentService } from '../environmentService';
import { getPixiExecutable, getPixiVersion } from '../pixi/cli';
import { describeHealth, PIXI_ENV_PREFIX_MARKER, PIXI_MARKER } from '../pixi/health';
import { displayName } from '../pixi/types';
import { runProcess } from '../process/run';
import { getActiveInterpreter } from '../python/api';
import {
    getEnvsExtensionVersion,
    isEnvsExtensionInstalled,
    isTerminalActivationDelegated,
} from '../python/envsExtension';

/**
 * Writes a support report to the output channel. Everything here has been a
 * source of confusion at least once, so it is all stated explicitly rather than
 * left to be inferred.
 */
export async function runDiagnostics(service: PixiEnvironmentService, log: LogOutputChannel): Promise<void> {
    const lines: string[] = [];
    const add = (line = '') => lines.push(line);

    add('='.repeat(72));
    add('Pixi VSCode diagnostics');
    add('='.repeat(72));
    add(`VS Code:  ${vscodeVersion}`);
    add(`Platform: ${process.platform} ${process.arch}`);
    add();

    add('-- Pixi ------------------------------------------------------------');
    try {
        add(`Executable: ${await getPixiExecutable()}`);
        add(`Version:    ${(await getPixiVersion()) ?? 'unknown'}`);
    } catch (error) {
        add(`Executable: NOT FOUND (${error instanceof Error ? error.message : String(error)})`);
    }
    add();

    add('-- Extensions ------------------------------------------------------');
    for (const id of [PYTHON_EXTENSION_ID, JUPYTER_EXTENSION_ID]) {
        const ext = extensions.getExtension(id);
        add(`${id}: ${ext ? ext.packageJSON.version : 'not installed'}`);
    }
    add(`ms-python.vscode-python-envs: ${getEnvsExtensionVersion() ?? 'not installed'}`);
    add();

    add('-- Terminal activation ownership -----------------------------------');
    const inspection = workspace.getConfiguration('python').inspect<boolean>('useEnvironmentsExtension');
    add(
        `python.useEnvironmentsExtension  default=${inspection?.defaultValue}  global=${inspection?.globalValue}  workspace=${inspection?.workspaceValue}`,
    );
    if (!isEnvsExtensionInstalled()) {
        add('Owner: Python extension (environments extension not installed)');
    } else if (isTerminalActivationDelegated()) {
        add('Owner: Environments extension.');
        add('  NOTE: the Python extension reads this setting with inspect() and honours only an');
        add('  explicitly written value — the `false` default does not count. Run');
        add('  "Pixi: Select Environment" or set python.useEnvironmentsExtension=false to take it back.');
    } else {
        add('Owner: Python extension (setting explicitly false)');
    }
    add();

    add('-- Environments ----------------------------------------------------');
    const environments = service.getEnvironments();
    if (environments.length === 0) {
        add('No Pixi environments discovered.');
    }
    const active = await getActiveInterpreter();
    add(`Active interpreter: ${active ?? 'none'}`);
    add();

    for (const env of environments) {
        const hasPixiMarker = await fs.pathExists(path.join(env.prefix, PIXI_MARKER));
        const hasPrefixMarker = await fs.pathExists(path.join(env.prefix, PIXI_ENV_PREFIX_MARKER));
        add(`${samePath(env.pythonPath, active) ? '*' : ' '} ${displayName(env)}`);
        add(`    manifest:  ${env.manifestPath}`);
        add(`    prefix:    ${env.prefix}`);
        add(`    python:    ${env.pythonPath ?? 'not found'}`);
        add(`    ${PIXI_MARKER}:              ${hasPixiMarker ? 'present' : 'MISSING'}`);
        add(`    ${PIXI_ENV_PREFIX_MARKER}:  ${hasPrefixMarker ? 'present' : 'missing'}`);
        add(
            `    expected classification: ${hasPixiMarker ? 'Pixi (fast)' : 'Conda (WRONG — causes the 30s kernel stall)'}`,
        );
        add(`    health:    ${describeHealth(env.health)}`);
        if (env.health === 'relocated') {
            add('    repair:    `pixi clean` then `pixi install` — a plain reinstall will NOT fix this');
        } else if (env.health === 'missingPixiMarker') {
            add('    repair:    `pixi install`');
        }
        add();
    }

    add('-- Orphaned `pixi shell` processes ----------------------------------');
    add('(leaked by timed-out environment capture; each one is a stalled kernel start)');
    for (const line of await findOrphanedPixiShells()) {
        add(`  ${line}`);
    }
    add();
    add('='.repeat(72));

    log.info(lines.join('\n'));
    log.show(true);
}

/**
 * Finds `pixi shell` processes reparented to PID 1 with no controlling
 * terminal. The PPID and TTY filters matter: they distinguish leaks from
 * `pixi shell` sessions a user legitimately started in a terminal.
 */
async function findOrphanedPixiShells(): Promise<string[]> {
    if (process.platform === 'win32') {
        return ['(not checked on Windows)'];
    }

    try {
        const stdout = await runProcess('ps', ['-eo', 'pid,ppid,tty,etime,command'], { timeoutMs: 10_000 });
        const orphans = stdout
            .split('\n')
            .slice(1)
            .filter((line) => {
                const fields = line.trim().split(/\s+/);
                return (
                    fields[1] === '1' && fields[2] === '??' && /\/pixi$/.test(fields[4] ?? '') && fields[5] === 'shell'
                );
            })
            .map((line) => line.trim());

        return orphans.length > 0 ? orphans : ['none'];
    } catch {
        return ['(could not run ps)'];
    }
}
