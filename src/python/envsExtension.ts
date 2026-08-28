import { ConfigurationTarget, extensions, Uri, workspace } from 'vscode';

import { ENVS_EXTENSION_ID } from '../common/utils';

const SETTING = 'useEnvironmentsExtension';

export function getEnvsExtensionVersion(): string | undefined {
    return extensions.getExtension(ENVS_EXTENSION_ID)?.packageJSON?.version;
}

export function isEnvsExtensionInstalled(): boolean {
    return extensions.getExtension(ENVS_EXTENSION_ID) !== undefined;
}

/**
 * Mirrors `shouldEnvExtHandleActivation()` inside `ms-python.python`.
 *
 * The subtlety worth preserving: the Python extension reads this setting with
 * `inspect()` and looks only at explicitly written values. The declared default
 * of `false` is never consulted, so merely having the environments extension
 * installed hands it terminal activation. Only a literal `false` in user,
 * workspace or folder settings takes it back.
 */
export function isTerminalActivationDelegated(): boolean {
    if (!isEnvsExtensionInstalled()) {
        return false;
    }

    const inspection = workspace.getConfiguration('python').inspect<boolean>(SETTING);
    if (inspection?.globalValue === false || inspection?.workspaceValue === false) {
        return false;
    }

    for (const folder of workspace.workspaceFolders ?? []) {
        const folderInspection = workspace.getConfiguration('python', folder.uri).inspect<boolean>(SETTING);
        if (folderInspection?.workspaceFolderValue === false) {
            return false;
        }
    }

    return true;
}

/**
 * Mirrors `useEnvExtension()` inside `ms-python.python`, which decides who owns
 * environment discovery.
 *
 * Unlike the activation gate this reads the setting with `get()`, so a default
 * supplied by VS Code's experimentation service counts. The setting is tagged
 * `onExP`, which means a fresh profile can be enrolled with it switched on —
 * and then the Python Environments extension, which has no Pixi support,
 * resolves the interpreter and lands on a system Python.
 */
export function isDiscoveryDelegated(): boolean {
    if (!isEnvsExtensionInstalled()) {
        return false;
    }
    return workspace.getConfiguration('python').get<boolean>(SETTING, false) === true;
}

/** True when nobody has written the setting at any scope. */
export function isSettingUnset(): boolean {
    const inspection = workspace.getConfiguration('python').inspect<boolean>(SETTING);
    return (
        inspection?.globalValue === undefined &&
        inspection?.workspaceValue === undefined &&
        inspection?.workspaceFolderValue === undefined
    );
}

/**
 * Writes `python.useEnvironmentsExtension: false`, returning terminal
 * activation to the Python extension, which drives Pixi correctly (`pixi shell`
 * in an interactive terminal is the right command — the bug is only when it is
 * used for non-interactive environment capture).
 */
export async function reclaimTerminalActivation(target: ConfigurationTarget, resource?: Uri): Promise<void> {
    await workspace.getConfiguration('python', resource).update(SETTING, false, target);
}
