import * as os from 'os';

export const EXTENSION_ID = 'munch-group.pixi-vscode';
export const CONFIG_SECTION = 'pixi-vscode';

export const PYTHON_EXTENSION_ID = 'ms-python.python';
export const ENVS_EXTENSION_ID = 'ms-python.vscode-python-envs';
export const JUPYTER_EXTENSION_ID = 'ms-toolsai.jupyter';

export function untildify(path: string): string {
    return path.replace(/^~($|\/|\\)/, `${os.homedir()}$1`);
}
