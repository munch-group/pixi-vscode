import { window } from 'vscode';

import { PixiEnvironmentService } from '../environmentService';
import { causesKernelStall, needsRebuild } from '../pixi/health';
import { PixiEnvironment, qualifiedName } from '../pixi/types';
import { promptForEnvironment, returnFocusToEditor } from './quickPick';

const SELECT_INSTEAD = 'Select Another Environment...';

/**
 * The dialog behind a red status bar pill.
 *
 * Clicking the pill used to open the interpreter picker, which lists the broken
 * environment as if it were fine and says nothing about the repair — the fix was
 * only ever mentioned in the hover tooltip, which a student following a red
 * badge by clicking it never reads. The click now leads to the fix instead.
 *
 * Modal on purpose. The pill is red because the kernel is not going to start,
 * and this is the one moment the user has asked about it; a notification toast
 * can be missed entirely, and it is what the current flow already tried.
 */
export async function promptToFixEnvironment(service: PixiEnvironmentService, environmentId?: string): Promise<void> {
    const environments = service.getEnvironments();
    const env = environmentId ? environments.find((candidate) => candidate.id === environmentId) : undefined;

    // The pill is drawn from the last scan, so the environment may have been
    // repaired, removed or deselected since. There is nothing to offer then, and
    // the old behaviour — the picker — is the sensible thing to fall back to.
    if (!env || !(needsRebuild(env) || causesKernelStall(env))) {
        await promptForEnvironment(service);
        return;
    }

    const { action, message, detail } = describeProblem(env, qualifiedName(env, environments));

    const choice = await window.showWarningMessage(message, { modal: true, detail }, action, SELECT_INSTEAD);
    if (choice === action) {
        await service.fixEnvironments([env]);
    } else if (choice === SELECT_INSTEAD) {
        await promptForEnvironment(service);
        return; // The picker returns focus itself.
    }

    await returnFocusToEditor();
}

/**
 * What to say, and what the button does.
 *
 * Modal dialogs render plain text, so no markdown here, and the `detail` is the
 * smaller text under the message.
 */
function describeProblem(env: PixiEnvironment, name: string): { action: string; message: string; detail: string } {
    if (needsRebuild(env)) {
        // Kernels are the reason this matters, but only for an environment that
        // has a Python in it. A Pixi environment holding none — tooling for a
        // project rather than a place to run notebooks — is broken by the move
        // just the same, in its own programs rather than in kernels, and saying
        // "Jupyter" to someone who is not running any explains nothing.
        const consequence = env.pythonPath
            ? `Jupyter kernels will fail to start: the environment in ${env.prefix} still points at the folder's ` +
              'old location.'
            : `The environment in ${env.prefix} still points at the folder's old location, so the programs ` +
              'installed in it will not run reliably.';

        return {
            action: 'Rebuild Environment',
            message: `The Pixi environment ${name} was moved after it was installed.`,
            detail:
                `${consequence}\n\n` +
                'Rebuilding deletes the environment and downloads it again, which takes a few minutes.',
        };
    }

    return {
        action: 'Repair Environment',
        message: `The Pixi environment ${name} is missing its conda-meta/pixi marker.`,
        detail:
            `VS Code reads ${env.prefix} as a conda environment, which adds 30 seconds to every Jupyter kernel ` +
            'start.\n\n' +
            'Repairing runs "pixi install", which usually takes a few seconds.',
    };
}
