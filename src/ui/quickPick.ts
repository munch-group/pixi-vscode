import { QuickPickItem, QuickPickItemKind, ThemeIcon, Uri, window, workspace } from 'vscode';

import { PixiEnvironmentService } from '../environmentService';
import { causesKernelStall, describeHealth } from '../pixi/health';
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
            detail: causesKernelStall(env) ? `$(warning) ${describeHealth(env.health)}` : env.prefix,
            iconPath: new ThemeIcon(env.pythonPath === active ? 'check' : 'blank'),
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
        window.showInformationMessage(`Selected ${displayName(picked.environment)}.`);
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
