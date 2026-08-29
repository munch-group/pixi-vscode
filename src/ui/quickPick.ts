import { commands, QuickPickItem, QuickPickItemKind, ThemeIcon, Uri, window, workspace } from 'vscode';

import { traceVerbose } from '../common/logging';
import { samePath } from '../common/utils';
import { PixiEnvironmentService } from '../environmentService';
import { causesKernelStall, describeHealth, needsRebuild } from '../pixi/health';
import { displayName, PixiEnvironment } from '../pixi/types';
import { getActiveInterpreter } from '../python/api';

interface EnvironmentItem extends QuickPickItem {
    environment?: PixiEnvironment;
}

export async function promptForEnvironment(service: PixiEnvironmentService): Promise<void> {
    const folder = await resolveFolder();
    if (!folder) {
        window.showErrorMessage('Open a folder containing a Pixi project first.');
        return;
    }

    const environments = service.getEnvironmentsForFolder(folder);
    if (environments.length === 0) {
        window.showErrorMessage(`No Pixi environments found in ${folder.fsPath}.`);
        return;
    }

    const active = await getActiveInterpreter(folder);
    const items: EnvironmentItem[] = [];
    let lastProject: string | undefined;

    for (const env of environments) {
        if (env.projectName !== lastProject) {
            items.push({ label: env.projectName, kind: QuickPickItemKind.Separator });
            lastProject = env.projectName;
        }
        items.push({
            label: env.name,
            description: env.pythonVersion ? `Python ${env.pythonVersion}` : undefined,
            detail:
                causesKernelStall(env) || needsRebuild(env)
                    ? `$(warning) ${env.prefix} — ${describeHealth(env.health)}`
                    : env.prefix,
            iconPath: new ThemeIcon(samePath(env.pythonPath, active) ? 'check' : 'blank'),
            environment: env,
        });
    }

    const picked = await window.showQuickPick(items, {
        title: 'Select a Pixi environment',
        placeHolder: 'The Python interpreter and Jupyter kernel both follow this choice',
        matchOnDetail: true,
    });

    if (picked?.environment) {
        await service.select(picked.environment, folder);
        window.setStatusBarMessage(`Selected ${displayName(picked.environment)}`, 4000);
    }

    await returnFocusToEditor();
}

/**
 * Moves focus off the status bar after the picker closes.
 *
 * Clicking the pill focuses it, and VS Code shows a status bar item's tooltip on
 * focus as well as on hover, so that keyboard users get it too. When the quick
 * pick closes, focus is restored to whatever had it before — the pill — and the
 * tooltip reappears with no pointer anywhere near it, staying up until
 * something else is clicked.
 *
 * Nothing about the item itself can prevent that; the focus has to go
 * somewhere else. Failure is ignored because this is a cosmetic tidy-up and
 * there may be no editor to focus.
 */
async function returnFocusToEditor(): Promise<void> {
    try {
        await commands.executeCommand('workbench.action.focusActiveEditorGroup');
    } catch (error) {
        traceVerbose('Could not return focus to the editor:', error);
    }
}

async function resolveFolder(): Promise<Uri | undefined> {
    const folders = workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        return undefined;
    }
    if (folders.length === 1) {
        return folders[0].uri;
    }

    const active = window.activeTextEditor?.document.uri;
    if (active) {
        const match = workspace.getWorkspaceFolder(active);
        if (match) {
            return match.uri;
        }
    }

    const picked = await window.showWorkspaceFolderPick({ placeHolder: 'Select a workspace folder' });
    return picked?.uri;
}
