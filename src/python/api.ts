import { Event, extensions, Uri } from 'vscode';

import { traceVerbose } from '../common/logging';
import { PYTHON_EXTENSION_ID } from '../common/utils';

export interface EnvironmentPath {
    id: string;
    path: string;
}

export interface ResolvedEnvironment {
    id: string;
    path: string;
    environment?: {
        type?: string;
        name?: string;
        folderUri?: Uri;
    };
    version?: {
        major: number;
        minor: number;
        micro: number;
    };
}

export interface ActiveEnvironmentPathChangeEvent extends EnvironmentPath {
    resource: { uri: Uri } | undefined;
}

/**
 * The stable API surface published by `ms-python.python`.
 *
 * Only the members we use are declared. Jupyter derives its kernel list from
 * the same data, so pointing this at a Pixi interpreter is all that is needed
 * to fix both Python and notebook execution.
 */
export interface PythonExtensionApi {
    environments: {
        readonly known: readonly ResolvedEnvironment[];
        getActiveEnvironmentPath(resource?: Uri): EnvironmentPath;
        updateActiveEnvironmentPath(path: string | EnvironmentPath, resource?: Uri): Promise<void>;
        resolveEnvironment(path: string | EnvironmentPath): Promise<ResolvedEnvironment | undefined>;
        refreshEnvironments(options?: { forceRefresh?: boolean }): Promise<void>;
        readonly onDidChangeActiveEnvironmentPath: Event<ActiveEnvironmentPathChangeEvent>;
    };
}

export class PythonExtensionNotFoundError extends Error {
    constructor() {
        super(`The Python extension (${PYTHON_EXTENSION_ID}) is required but was not found.`);
        this.name = 'PythonExtensionNotFoundError';
    }
}

let cached: PythonExtensionApi | undefined;

export async function getPythonApi(): Promise<PythonExtensionApi> {
    if (cached) {
        return cached;
    }

    const extension = extensions.getExtension<PythonExtensionApi>(PYTHON_EXTENSION_ID);
    if (!extension) {
        throw new PythonExtensionNotFoundError();
    }

    if (!extension.isActive) {
        await extension.activate();
    }

    cached = extension.exports;
    return cached;
}

export async function getActiveInterpreter(resource?: Uri): Promise<string | undefined> {
    const api = await getPythonApi();
    return api.environments.getActiveEnvironmentPath(resource)?.path;
}

export async function setActiveInterpreter(pythonPath: string, resource?: Uri): Promise<void> {
    const api = await getPythonApi();
    traceVerbose(`Setting interpreter for ${resource?.fsPath ?? 'the workspace'} to ${pythonPath}`);
    await api.environments.updateActiveEnvironmentPath(pythonPath, resource);
}

/**
 * Asks the Python extension to re-scan. Needed after repairing an environment,
 * because its cached classification still says conda.
 */
export async function refreshInterpreters(): Promise<void> {
    const api = await getPythonApi();
    await api.environments.refreshEnvironments({ forceRefresh: true });
}
