import semver from 'semver';
import { commands, ExtensionContext, window, workspace } from 'vscode';

import { registerLogger, traceError, traceInfo } from './common/logging';
import { setPersistentState } from './common/persistentState';
import { PixiEnvironmentService } from './environmentService';
import { getPixiVersion, MINIMUM_PIXI_VERSION, PixiNotFoundError } from './pixi/cli';
import { getPythonApi } from './python/api';
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

    // Commands are registered before any await so they work even if the
    // environment check below fails — "Run Diagnostics" is most useful exactly
    // when something is wrong.
    context.subscriptions.push(
        commands.registerCommand('pixi-vscode.selectEnvironment', () => promptForEnvironment(service)),
        commands.registerCommand('pixi-vscode.refreshEnvironments', async () => {
            await service.refresh();
            await statusBar.update();
        }),
        commands.registerCommand('pixi-vscode.repairEnvironments', () => service.repairDegradedEnvironments(true)),
        commands.registerCommand('pixi-vscode.runDiagnostics', () => runDiagnostics(service, log)),
        commands.registerCommand('pixi-vscode.showLogs', () => log.show()),
        workspace.onDidChangeWorkspaceFolders(() => void service.refresh()),
    );

    if (!(await checkPixiVersion())) {
        return;
    }

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

    // The remaining steps each await a notification the user may never answer,
    // so they must not sit in the activation path — selecting the interpreter
    // would be blocked behind an unanswered dialog.
    void (async () => {
        await service.repairDegradedEnvironments();
        // A repair changes which environments are usable, so re-select.
        await service.autoSelect();
        await service.ensureEnvironmentOwnership();
        await statusBar.update();
    })();
}

/**
 * Reports a missing or too-old Pixi without throwing, so the extension stays
 * loaded and its diagnostics command remains reachable.
 */
async function checkPixiVersion(): Promise<boolean> {
    let version: string | undefined;
    try {
        version = await getPixiVersion();
    } catch (error) {
        if (error instanceof PixiNotFoundError) {
            window.showWarningMessage(error.message);
        } else {
            traceError('Could not determine the Pixi version:', error);
            window.showWarningMessage('Could not run Pixi. Run "Pixi: Run Diagnostics" for details.');
        }
        return false;
    }

    if (!version) {
        window.showWarningMessage('Could not parse the Pixi version. Run "Pixi: Run Diagnostics" for details.');
        return false;
    }

    if (!semver.gte(version, MINIMUM_PIXI_VERSION)) {
        window.showWarningMessage(
            `Pixi ${version} is too old; ${MINIMUM_PIXI_VERSION} or newer is required. Run \`pixi self-update\`.`,
        );
        return false;
    }

    traceInfo(`Using Pixi ${version}`);
    return true;
}
