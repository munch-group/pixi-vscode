import fg from 'fast-glob';
import * as fs from 'fs-extra';
import * as path from 'path';
import { CancellationToken, Uri, workspace } from 'vscode';

import { findPythonExecutable } from '../common/findPython';
import { traceError, traceVerbose } from '../common/logging';
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

export async function getEnvironmentsForProject(
    projectPath: string,
    token?: CancellationToken,
): Promise<PixiEnvironment[]> {
    let info;
    try {
        info = await getPixiInfo(projectPath, token);
    } catch (error) {
        traceError(`Failed to read Pixi info for ${projectPath}:`, error);
        return [];
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
