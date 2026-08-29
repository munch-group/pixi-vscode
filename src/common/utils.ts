import * as fs from 'fs-extra';
import * as os from 'os';

export const EXTENSION_ID = 'munch-group.im-pixi-vscode';
export const CONFIG_SECTION = 'im-pixi-vscode';

/**
 * The Pixi project this extension is allowed to change settings for.
 *
 * Discovery, selection and the status bar are this extension's job in any Pixi
 * project and stay that way. Writing `python.useEnvironmentsExtension` into a
 * workspace is different: it is a course arrangement, decided for a folder a
 * hundred students all open, and a student who opens some other Python project
 * of their own should not find this extension editing its settings or asking to
 * reload the window.
 *
 * Matched against the name in the project's own manifest -- `[workspace] name`
 * in pixi.toml, which is what `pixi info` reports -- and not against the
 * directory, so it still holds for a student who renames the folder.
 */
export const COURSE_PROJECT = 'instructing-machines';

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

/**
 * A path in the form that two of them can be compared as strings.
 *
 * Resolving symlinks is half of it, and canonicalPath above does that. The
 * other half is that Windows file names are case-insensitive while JavaScript
 * string comparison is not, and the two sources this extension compares
 * disagree about case as a matter of routine: VS Code reports a workspace
 * folder through Uri.fsPath, which lowercases the drive letter (c:\Users\...),
 * while pixi and Node's realpath report the same directory with the letter the
 * disk uses (C:\Users\...). One `===` between those finds nothing, and the
 * symptom is "No Pixi environments found in c:\..." for a folder that plainly
 * has one, with the lowercase drive letter in the message the giveaway.
 *
 * Only Windows is folded. macOS is case-insensitive too on a default volume,
 * but both sides of every comparison there come back from realpath with the
 * disk's own casing, so there is nothing to reconcile — and folding would be
 * wrong on the case-sensitive volumes that do exist.
 */
export function comparablePath(candidate: string): string {
    const resolved = canonicalPath(candidate);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Whether two paths name the same file or directory.
 *
 * An absent path matches nothing, including another absent one: the callers ask
 * this about an environment's interpreter and the one the Python extension has
 * active, and "neither exists" is not a reason to mark an environment as the
 * one in use.
 */
export function samePath(left: string | undefined, right: string | undefined): boolean {
    if (!left || !right) {
        return false;
    }
    return comparablePath(left) === comparablePath(right);
}

/** Whether `candidate` is `parent` itself or something under it. */
export function isInsidePath(candidate: string, parent: string): boolean {
    const child = comparablePath(candidate);
    const root = comparablePath(parent);

    if (child === root) {
        return true;
    }
    if (!child.startsWith(root)) {
        return false;
    }
    // Guard against /home/kasper-old matching /home/kasper.
    const next = child[root.length];
    return next === '/' || next === '\\';
}
