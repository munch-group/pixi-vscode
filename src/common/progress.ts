import { Disposable, Progress } from 'vscode';

import { traceVerbose } from './logging';

/** How often the message is refreshed. Once a second reads as "alive". */
const TICK_MS = 1000;

export interface LiveProgressOptions {
    /** What is happening, e.g. 'Installing packages'. */
    activity: string;
    /** Units of work already done, re-read on every tick. */
    poll?: () => Promise<number | undefined>;
    /** Units of work expected, when that is known. */
    total?: number;
    /** Share of the notification's bar this step owns, 0-100. */
    weight?: number;
}

/**
 * Keeps a progress notification visibly moving while a long command runs.
 *
 * Pixi prints nothing at all when its output is a pipe rather than a terminal —
 * the progress bars are drawn only for a TTY — so a rebuild is several silent
 * minutes. A notification whose message never changes reads as a hang, and the
 * obvious response to a hang is to close the window, which leaves a half-built
 * environment behind. Hence a clock that ticks every second: on its own it says
 * nothing about how far along the work is, but it does say the work is still
 * going.
 *
 * The count says the rest, when the caller can supply one.
 */
export function startLiveProgress(
    progress: Progress<{ message?: string; increment?: number }>,
    options: LiveProgressOptions,
): Disposable {
    const started = Date.now();
    const weight = options.weight ?? 100;
    let done: number | undefined;
    let polling = false;
    let reported = 0;

    const render = () => {
        const elapsed = formatElapsed(Date.now() - started);
        const counted = done !== undefined && done > 0;
        const total = options.total;

        let message: string;
        if (counted && total && done! <= total) {
            message = `${options.activity}: ${done} of ${total} packages — ${elapsed} elapsed`;
        } else if (counted) {
            message = `${options.activity}: ${done} packages — ${elapsed} elapsed`;
        } else {
            message = `${options.activity} — ${elapsed} elapsed`;
        }

        // The bar is left alone until there is real progress to put on it. A
        // determinate bar reporting 0% sits still, which is the stalled look
        // this exists to avoid; told no increment at all, VS Code animates it.
        let increment: number | undefined;
        if (counted && total && total > 0) {
            const percent = Math.min(done! / total, 1) * weight;
            if (percent > reported) {
                increment = percent - reported;
                reported = percent;
            }
        }

        progress.report(increment === undefined ? { message } : { message, increment });
    };

    const tick = () => {
        // A poll slower than the interval must not stack up behind itself.
        if (options.poll && !polling) {
            polling = true;
            void options
                .poll()
                .then((value) => {
                    done = value;
                })
                .catch((error) => traceVerbose('Progress poll failed:', error))
                .finally(() => {
                    polling = false;
                });
        }
        render();
    };

    render();
    const timer = setInterval(tick, TICK_MS);
    return new Disposable(() => clearInterval(timer));
}

/** `m:ss`, counting up. */
function formatElapsed(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
