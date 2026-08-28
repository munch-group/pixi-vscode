import * as ch from 'child_process';
import { CancellationError, CancellationToken } from 'vscode';

import { createDeferred } from '../common/deferred';
import { traceVerbose, traceWarn } from '../common/logging';

export const DEFAULT_TIMEOUT_MS = 60_000;

export interface RunOptions {
    cwd?: string;
    timeoutMs?: number;
    token?: CancellationToken;
}

export class ProcessError extends Error {
    constructor(
        message: string,
        readonly stdout: string,
        readonly stderr: string,
        readonly exitCode: number | null,
    ) {
        super(message);
        this.name = 'ProcessError';
    }
}

export class ProcessTimeoutError extends ProcessError {
    constructor(
        message: string,
        stdout: string,
        stderr: string,
        readonly timeoutMs: number,
    ) {
        super(message, stdout, stderr, null);
        this.name = 'ProcessTimeoutError';
    }
}

/**
 * Kills the child *and everything it spawned*.
 *
 * A plain `proc.kill()` sends SIGTERM to the direct child only. When that child
 * is a shell wrapping something like `pixi shell`, the grandchildren survive,
 * get reparented to PID 1 and linger forever — the leak documented in
 * `ms-python_vscode-python-envs_issue.md`. Because we spawn with `detached`,
 * the child leads its own process group and a negative PID reaches the whole
 * group in one call.
 */
function killTree(proc: ch.ChildProcess): void {
    const pid = proc.pid;
    if (pid === undefined) {
        return;
    }

    if (process.platform === 'win32') {
        // Windows has no process groups we can signal; taskkill /T walks the tree.
        const killer = ch.spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('error', (err) => traceWarn(`Failed to taskkill ${pid}: ${err}`));
        return;
    }

    try {
        process.kill(-pid, 'SIGKILL');
    } catch {
        // The group may already be gone, or we never became a group leader.
        try {
            proc.kill('SIGKILL');
        } catch {
            // Already exited; nothing to clean up.
        }
    }
}

/**
 * Runs a command and resolves with its stdout.
 *
 * Two deliberate choices guard against the failure modes we hit with pixi:
 *
 * - `stdio.stdin = 'ignore'` closes stdin, so a subprocess that unexpectedly
 *   turns interactive sees EOF and exits instead of blocking for 30 seconds.
 * - `detached` + {@link killTree} means a timeout kills the whole process group
 *   rather than orphaning grandchildren.
 *
 * No shell is used, so arguments never need quoting.
 */
export function runProcess(executable: string, args: string[], options: RunOptions = {}): Promise<string> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deferred = createDeferred<string>();

    traceVerbose(`Running: ${executable} ${args.join(' ')}${options.cwd ? ` (cwd: ${options.cwd})` : ''}`);

    let proc: ch.ChildProcess;
    try {
        proc = ch.spawn(executable, args, {
            cwd: options.cwd,
            shell: false,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        return Promise.reject(err);
    }

    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const timer =
        timeoutMs > 0
            ? setTimeout(() => {
                  timedOut = true;
                  traceWarn(`Timed out after ${timeoutMs}ms, killing process group: ${executable} ${args.join(' ')}`);
                  killTree(proc);
              }, timeoutMs)
            : undefined;

    const cancelSub = options.token?.onCancellationRequested(() => {
        cancelled = true;
        killTree(proc);
    });

    const cleanup = () => {
        if (timer) {
            clearTimeout(timer);
        }
        cancelSub?.dispose();
    };

    proc.stdout?.on('data', (data) => {
        stdout += data.toString('utf-8');
    });
    proc.stderr?.on('data', (data) => {
        stderr += data.toString('utf-8');
    });

    proc.on('error', (err) => {
        if (settled) {
            return;
        }
        settled = true;
        cleanup();
        deferred.reject(err);
    });

    // `exit` can fire before the stdio streams flush, so the result is only
    // decided on `close`, when both have happened.
    proc.on('exit', (code) => {
        exitCode = code;
    });

    proc.on('close', () => {
        if (settled) {
            return;
        }
        settled = true;
        cleanup();

        const command = `${executable} ${args.join(' ')}`;
        if (cancelled) {
            deferred.reject(new CancellationError());
        } else if (timedOut) {
            deferred.reject(
                new ProcessTimeoutError(`"${command}" timed out after ${timeoutMs}ms`, stdout, stderr, timeoutMs),
            );
        } else if (exitCode !== 0) {
            deferred.reject(
                new ProcessError(
                    `"${command}" exited with code ${exitCode}\n${stderr.trim()}`,
                    stdout,
                    stderr,
                    exitCode,
                ),
            );
        } else {
            deferred.resolve(stdout);
        }
    });

    return deferred.promise;
}
