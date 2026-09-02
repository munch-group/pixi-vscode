import fg from 'fast-glob';
import * as fs from 'fs-extra';
import * as path from 'path';
import { CancellationToken, Uri, workspace } from 'vscode';

import { findPythonExecutable } from '../common/findPython';
import { traceError, traceVerbose, traceWarn } from '../common/logging';
import { CONFIG_SECTION } from '../common/utils';
import { getPixiInfo } from './cli';
import { assessHealth } from './health';
import { PixiEnvironment } from './types';

const MANIFEST_NAMES = ['pixi.toml', 'pyproject.toml'];

/**
 * Finds directories under `folder` that hold a Pixi manifest.
 *
 * A `pyproject.toml` only counts when it actually configures Pixi, otherwise
 * every Python project in the tree would be probed.
 */
export async function findPixiProjects(folder: Uri): Promise<string[]> {
    const depth = workspace.getConfiguration(CONFIG_SECTION, folder).get<number>('searchDepth', 2);
    const patterns = MANIFEST_NAMES.map((name) => (depth > 0 ? `**/${name}` : name));

    let matches: string[];
    try {
        matches = await fg(patterns, {
            cwd: folder.fsPath,
            absolute: true,
            deep: depth + 1,
            onlyFiles: true,
            followSymbolicLinks: false,
            suppressErrors: true,
            ignore: ['**/node_modules/**', '**/.pixi/**', '**/.git/**', '**/site-packages/**'],
        });
    } catch (error) {
        traceError(`Failed to search for Pixi manifests in ${folder.fsPath}:`, error);
        return [];
    }

    const projects = new Set<string>();
    for (const manifest of matches) {
        if (path.basename(manifest) === 'pyproject.toml' && !(await configuresPixi(manifest))) {
            continue;
        }
        projects.add(path.dirname(manifest));
    }
    return [...projects];
}

async function configuresPixi(pyprojectPath: string): Promise<boolean> {
    try {
        const contents = await fs.readFile(pyprojectPath, 'utf-8');
        return /^\s*\[tool\.pixi[.\]]/m.test(contents);
    } catch (error) {
        traceVerbose(`Could not read ${pyprojectPath}:`, error);
        return false;
    }
}

/**
 * Reads the Python version straight out of `conda-meta` rather than executing
 * the interpreter, which keeps discovery free of subprocesses per environment.
 */
async function readPythonVersion(prefix: string): Promise<string | undefined> {
    try {
        const entries = await fs.readdir(path.join(prefix, 'conda-meta'));
        for (const entry of entries) {
            const match = entry.match(/^python-(\d+\.\d+\.\d+)-/);
            if (match) {
                return match[1];
            }
        }
    } catch {
        // Environment not installed yet; the health check reports that.
    }
    return undefined;
}

const SECTION_HEADER = /^\s*\[([^\]]+)\]\s*$/;
const NAME_ENTRY = /^\s*name\s*=\s*["']([^"']*)["']/;

/** The project name as the manifest declares it, without running Pixi. */
async function readProjectName(manifestPath: string): Promise<string | undefined> {
    let contents: string;
    try {
        contents = await fs.readFile(manifestPath, 'utf-8');
    } catch (error) {
        traceVerbose(`Could not read ${manifestPath}:`, error);
        return undefined;
    }

    let section = '';
    for (const line of contents.split(/\r?\n/)) {
        const header = line.match(SECTION_HEADER);
        if (header) {
            section = header[1].trim();
            continue;
        }
        if (!/^(?:tool\.pixi\.)?(?:workspace|project)$/.test(section)) {
            continue;
        }
        const name = line.match(NAME_ENTRY);
        if (name?.[1]) {
            return name[1];
        }
    }
    return undefined;
}

async function findManifest(projectPath: string): Promise<string | undefined> {
    for (const name of MANIFEST_NAMES) {
        const candidate = path.join(projectPath, name);
        if (await fs.pathExists(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

/**
 * Reads the environments straight off disk, for when `pixi` cannot be run.
 *
 * Everything this extension needs about an environment is already in the
 * folder: the prefix is `.pixi/envs/<name>`, the interpreter is inside it, the
 * Python version is in `conda-meta`, and health is three file checks. Only the
 * project name has to come out of the manifest, and that is one line of TOML.
 *
 * This is what keeps a Dock-launched VS Code working. An application started
 * from the Dock on a Mac inherits none of the shell's PATH, so `pixi` is not
 * findable unless its full path has been written into settings — and giving up
 * there left a student with no interpreter and no kernel, on a folder whose
 * environment was sitting perfectly well installed a few directories down.
 *
 * What is lost without the command is repair: `pixi install` and `pixi clean`
 * are how a degraded or relocated environment is put right, and those really do
 * need the executable. Reporting the environments is not repairing them.
 */
async function readEnvironmentsFromDisk(projectPath: string): Promise<PixiEnvironment[]> {
    const manifestPath = await findManifest(projectPath);
    if (!manifestPath) {
        return [];
    }

    const envsDir = path.join(projectPath, '.pixi', 'envs');
    let entries: string[];
    try {
        entries = await fs.readdir(envsDir);
    } catch {
        traceVerbose(`No environments installed under ${envsDir}`);
        return [];
    }

    const projectName = (await readProjectName(manifestPath)) ?? path.basename(projectPath);
    const environments: PixiEnvironment[] = [];

    for (const name of entries) {
        const prefix = path.join(envsDir, name);
        try {
            if (!(await fs.stat(prefix)).isDirectory()) {
                continue;
            }
        } catch {
            continue;
        }

        const pythonPath = (await findPythonExecutable(prefix)) ?? undefined;
        environments.push({
            id: prefix,
            name,
            projectName,
            manifestPath,
            projectPath,
            prefix,
            pythonPath,
            pythonVersion: await readPythonVersion(prefix),
            health: await assessHealth(prefix, pythonPath),
        });
    }

    traceVerbose(`Read ${environments.length} environment(s) from ${envsDir}`);
    return environments;
}

export async function getEnvironmentsForProject(
    projectPath: string,
    token?: CancellationToken,
): Promise<PixiEnvironment[]> {
    let info;
    try {
        info = await getPixiInfo(projectPath, token);
    } catch (error) {
        traceWarn(`Could not ask Pixi about ${projectPath}; reading the folder instead:`, error);
        return readEnvironmentsFromDisk(projectPath);
    }

    if (!info.project_info) {
        traceVerbose(`No Pixi project at ${projectPath}`);
        return [];
    }

    const { name: projectName, manifest_path: manifestPath } = info.project_info;

    return Promise.all(
        info.environments_info.map(async (env) => {
            const pythonPath = (await findPythonExecutable(env.prefix)) ?? undefined;
            return {
                id: env.prefix,
                name: env.name,
                projectName,
                manifestPath,
                projectPath: path.dirname(manifestPath),
                prefix: env.prefix,
                pythonPath,
                pythonVersion: await readPythonVersion(env.prefix),
                health: await assessHealth(env.prefix, pythonPath),
            } satisfies PixiEnvironment;
        }),
    );
}

export async function discoverEnvironments(token?: CancellationToken): Promise<PixiEnvironment[]> {
    const folders = workspace.workspaceFolders ?? [];
    const projectLists = await Promise.all(folders.map((folder) => findPixiProjects(folder.uri)));
    const projects = [...new Set(projectLists.flat())];

    traceVerbose(`Found ${projects.length} Pixi project(s): ${projects.join(', ')}`);

    const envLists = await Promise.all(projects.map((project) => getEnvironmentsForProject(project, token)));
    const environments = envLists.flat();

    // Environments without Python cannot back an interpreter or a kernel.
    return environments
        .filter((env) => env.pythonPath !== undefined || env.health !== 'healthy')
        .sort((a, b) => a.projectName.localeCompare(b.projectName) || a.name.localeCompare(b.name));
}
