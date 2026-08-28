import * as fs from 'fs-extra';
import * as os from 'os';

export const EXTENSION_ID = 'munch-group.pixi-vscode';
export const CONFIG_SECTION = 'pixi-vscode';

export const PYTHON_EXTENSION_ID = 'ms-python.python';
export const ENVS_EXTENSION_ID = 'ms-python.vscode-python-envs';
export const JUPYTER_EXTENSION_ID = 'ms-toolsai.jupyter';

export function untildify(path: string): string {
    return path.replace(/^~($|\/|\\)/, `${os.homedir()}$1`);
}

/**
 * Resolves symlinks so that paths from different sources can be compared.
 *
 * This matters more than it looks. On macOS VS Code reports a workspace folder
 * as /var/folders/..., while `pixi info` reports the same directory as
 * /private/var/folders/..., because /var is a symlink. Comparing the two as
 * strings finds no environments for the folder and selects nothing, silently.
 * Temporary directories, network mounts and managed home directories all hit
 * this.
 */
export function canonicalPath(candidate: string): string {
    try {
        return fs.realpathSync(candidate);
    } catch {
        // The path may not exist yet; comparing the original is better than throwing.
        return candidate;
    }
}
