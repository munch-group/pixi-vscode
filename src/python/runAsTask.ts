import {
    commands,
    ConfigurationChangeEvent,
    Disposable,
    ProcessExecution,
    Task,
    TaskPanelKind,
    TaskRevealKind,
    tasks,
    TaskScope,
    Uri,
    window,
    workspace,
} from 'vscode';

import { traceInfo, traceVerbose, traceWarn } from '../common/logging';
import { getActiveInterpreter } from './api';

/**
 * The command behind "Run as Task", claimed when nobody else is offering it.
 *
 * ms-python.vscode-python-envs contributes that entry to the Run button's menu
 * with `"when": "editorLangId == python"` and nothing else, while its own
 * activate() begins:
 *
 *     if (!useEnvironmentsExtension) {
 *         await deactivate(context);
 *         return;                      // before a single registerCommand
 *     }
 *
 * So a folder that sets `python.useEnvironmentsExtension: false` -- which is
 * what this course's folder does, because that extension has no Pixi support
 * and otherwise takes the interpreter away from .pixi -- gets the menu entry
 * without the command behind it. Clicking it says "command 'python-envs.
 * runAsTask' not found", which is what a hundred students met.
 *
 * A menu entry contributed by another extension cannot be given a `when` clause
 * from here; contributions belong to the extension that declares them. What can
 * be done is register the command the entry points at, since the id is free in
 * exactly this case. So the dead button is made to work, on the environment the
 * course actually uses, rather than removed -- and removing it was never
 * durable anyway, because the extension arrives again with the next
 * ms-python.python update.
 *
 * The registration is conditional on the same predicate their activate() uses,
 * read the same way. If the setting is anything other than an explicit false,
 * that extension registers this command itself and this one must not: two
 * extensions cannot hold the same id, and the second registration throws inside
 * whichever activate() runs later.
 */
const COMMAND = 'python-envs.runAsTask';
const SETTING = 'useEnvironmentsExtension';

/**
 * Whether the Python Environments extension has been switched off by setting.
 *
 * Mirrors microsoft/vscode-python-environments' own check, including its look
 * at each folder of a multi-root workspace: inspect() on an unscoped
 * configuration does not reliably populate workspaceFolderValue, so a folder
 * that disables the extension is only visible by asking about that folder.
 */
export function envsExtensionDisabledBySetting(): boolean {
    const inspection = workspace.getConfiguration('python').inspect<boolean>(SETTING);
    if (inspection?.globalValue === false || inspection?.workspaceValue === false) {
        return true;
    }
    return (workspace.workspaceFolders ?? []).some(
        (folder) =>
            workspace.getConfiguration('python', folder.uri).inspect<boolean>(SETTING)?.workspaceFolderValue === false,
    );
}

/**
 * Runs one file as a task, on the interpreter this window has active.
 *
 * That interpreter is the one this extension selected from .pixi, so the file
 * runs with the course's packages on the path. ProcessExecution rather than
 * ShellExecution: the argument is a path chosen by whoever named the folder,
 * and handing it to a shell means quoting it correctly on three platforms.
 */
async function runFileAsTask(item?: unknown): Promise<void> {
    const uri = item instanceof Uri ? item : window.activeTextEditor?.document.uri;
    if (!uri) {
        window.showWarningMessage('Open a Python file first.');
        return;
    }

    const interpreter = await getActiveInterpreter(uri);
    if (!interpreter) {
        window.showWarningMessage(
            'No Python interpreter is selected for this file, so there is nothing to run it with. ' +
                'Pick one from the Pixi entry in the status bar.',
        );
        return;
    }

    const folder = workspace.getWorkspaceFolder(uri);
    const task = new Task(
        { type: 'python' },
        folder ?? TaskScope.Workspace,
        'Python Run',
        'Pixi',
        new ProcessExecution(interpreter, [uri.fsPath], { cwd: folder?.uri.fsPath }),
        '$python',
    );
    task.presentationOptions = {
        reveal: TaskRevealKind.Always,
        echo: true,
        panel: TaskPanelKind.Shared,
        close: false,
        showReuseMessage: true,
    };

    traceInfo(`Running as task: ${interpreter} ${uri.fsPath}`);
    await tasks.executeTask(task);
}

/**
 * Holds the command while the other extension is switched off, and lets go the
 * moment it is not.
 *
 * The setting only takes effect for that extension on a window reload, so
 * letting go is not urgent -- but it is not nothing either: leaving the id held
 * would mean the reload after someone switches the extension back on ends with
 * its activate() throwing on a name this extension never gave back.
 */
class RunAsTaskClaim implements Disposable {
    private registration: Disposable | undefined;
    private readonly watcher: Disposable;

    constructor() {
        this.apply();
        this.watcher = workspace.onDidChangeConfiguration((event: ConfigurationChangeEvent) => {
            if (event.affectsConfiguration(`python.${SETTING}`)) {
                this.apply();
            }
        });
    }

    private apply(): void {
        const wanted = envsExtensionDisabledBySetting();
        if (wanted && !this.registration) {
            try {
                this.registration = commands.registerCommand(COMMAND, runFileAsTask);
                traceInfo(`Registered ${COMMAND}: its own extension is switched off by setting`);
            } catch (error) {
                // Already registered means that extension is running after all,
                // and this one has nothing to add. Its command, its menu entry.
                traceWarn(`Left ${COMMAND} alone: ${error}`);
            }
        } else if (!wanted && this.registration) {
            this.registration.dispose();
            this.registration = undefined;
            traceVerbose(`Released ${COMMAND} back to the Python Environments extension`);
        }
    }

    dispose(): void {
        this.watcher.dispose();
        this.registration?.dispose();
    }
}

export function claimRunAsTask(): Disposable {
    return new RunAsTaskClaim();
}
