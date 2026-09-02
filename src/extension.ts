import semver from 'semver';
import { commands, ExtensionContext, window, workspace } from 'vscode';

import { registerLogger, traceError, traceInfo, traceWarn } from './common/logging';
import { setPersistentState } from './common/persistentState';
import { PixiEnvironmentService } from './environmentService';
import { getPixiVersion, MINIMUM_PIXI_VERSION, PixiNotFoundError } from './pixi/cli';
import { getPythonApi } from './python/api';
import { claimRunAsTask } from './python/runAsTask';
import { runDiagnostics } from './ui/diagnostics';
import { promptForEnvironment } from './ui/quickPick';
import { PixiStatusBar } from './ui/statusBar';

export async function activate(context: ExtensionContext): Promise<void> {
    const log = window.createOutputChannel('Pixi', { log: true });
    context.subscriptions.push(log, registerLogger(log));

    setPersistentState(context);

    const service = new PixiEnvironmentService();
    const statusBar = new PixiStatusBar(service);
    context.subscriptions.push(service, statusBar);

    // The Run menu's "Run as Task" entry, which the Python Environments
    // extension contributes and then does not register a command for whenever
    // a folder switches that extension off. Claimed here, before the awaits
    // below, for the same reason the commands are: a student clicking it should
    // meet a program running rather than "command not found", whatever else
    // this window has failed to do.
    context.subscriptions.push(claimRunAsTask());

    // Commands are registered before any await so they work even if the
    // environment check below fails — "Run Diagnostics" is most useful exactly
    // when something is wrong.
    context.subscriptions.push(
        commands.registerCommand('im-pixi-vscode.selectEnvironment', () => promptForEnvironment(service)),
        commands.registerCommand('im-pixi-vscode.refreshEnvironments', async () => {
            await service.refresh();
            await statusBar.update();
        }),
        commands.registerCommand('im-pixi-vscode.repairEnvironments', async () => {
            await service.repairDegradedEnvironments(true);
            await service.rebuildRelocatedEnvironments(true);
        }),
        commands.registerCommand('im-pixi-vscode.runDiagnostics', () => runDiagnostics(service, log)),
        commands.registerCommand('im-pixi-vscode.showLogs', () => log.show()),
        workspace.onDidChangeWorkspaceFolders(() => void service.refresh()),
    );

    // Whether Pixi itself can be run, which is no longer a condition of doing
    // anything. Discovery falls back to reading `.pixi/envs`, and that is the
    // whole of what selecting an interpreter needs; only repairing an
    // environment has to shell out. Returning here instead — which is what this
    // did — meant a VS Code started from the Dock, inheriting no PATH and so
    // unable to find pixi, selected no interpreter and offered no kernel, on a
    // folder where the environment was installed and working.
    const pixiProblem = await checkPixi();

    try {
        await getPythonApi();
    } catch (error) {
        traceError('Python extension unavailable:', error);
        window.showErrorMessage('The Python extension is required for Pixi environments to be used.');
        return;
    }

    await service.refresh();
    await service.autoSelect();
    // The Python extension applies its own initial selection shortly after we
    // do, and will overwrite ours with a system Python if its discovery has not
    // finished. Hold our choice for a moment, then leave it alone for good.
    context.subscriptions.push(await service.guardStartupSelection(15_000));
    await statusBar.update();

    // Said out loud only when it actually cost something. A student whose
    // environment was found anyway does not need a warning about a command they
    // have installed and that works in their terminal.
    if (pixiProblem && service.getEnvironments().length === 0) {
        window.showWarningMessage(pixiProblem);
    }

    // The remaining steps each await a notification the user may never answer,
    // so they must not sit in the activation path — selecting the interpreter
    // would be blocked behind an unanswered dialog.
    void (async () => {
        if (!pixiProblem) {
            // Both repairs run `pixi install`, so they are the one thing that
            // genuinely cannot be done without the command.
            await service.repairDegradedEnvironments();
            await service.rebuildRelocatedEnvironments();
            // A repair changes which environments are usable, so re-select.
            await service.autoSelect();
        }
        await service.ensureEnvironmentOwnership();
        await statusBar.update();
    })();
}

/**
 * Describes what is wrong with Pixi on this machine, or undefined when nothing
 * is.
 *
 * It reports rather than decides, and never shows the message itself: whether a
 * missing Pixi is worth interrupting a student over depends on whether the
 * environments were found without it, which is not known yet here.
 */
async function checkPixi(): Promise<string | undefined> {
    let version: string | undefined;
    try {
        version = await getPixiVersion();
    } catch (error) {
        if (error instanceof PixiNotFoundError) {
            traceWarn(error.message);
            return error.message;
        }
        traceError('Could not determine the Pixi version:', error);
        return 'Could not run Pixi. Run "Pixi: Run Diagnostics" for details.';
    }

    if (!version) {
        traceWarn('Could not parse the Pixi version.');
        return 'Could not parse the Pixi version. Run "Pixi: Run Diagnostics" for details.';
    }

    if (!semver.gte(version, MINIMUM_PIXI_VERSION)) {
        const message = `Pixi ${version} is too old; ${MINIMUM_PIXI_VERSION} or newer is required. Run \`pixi self-update\`.`;
        traceWarn(message);
        return message;
    }

    traceInfo(`Using Pixi ${version}`);
    return undefined;
}
