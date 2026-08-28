import {
    CancellationToken,
    commands,
    ConfigurationTarget,
    Disposable,
    EventEmitter,
    ProgressLocation,
    Uri,
    window,
    workspace,
    WorkspaceFolder,
} from 'vscode';

import { traceError, traceInfo, traceVerbose, traceWarn } from './common/logging';
import { getWorkspacePersistentState } from './common/persistentState';
import { canonicalPath, CONFIG_SECTION, EXTENSION_ID } from './common/utils';
import { pixiInstall } from './pixi/cli';
import { discoverEnvironments } from './pixi/discovery';
import { causesKernelStall } from './pixi/health';
import { displayName, PixiEnvironment, qualifiedName } from './pixi/types';
import { getActiveInterpreter, getPythonApi, refreshInterpreters, setActiveInterpreter } from './python/api';
import {
    isDiscoveryDelegated,
    isEnvsExtensionInstalled,
    isSettingUnset,
    isTerminalActivationDelegated,
    reclaimTerminalActivation,
} from './python/envsExtension';

const SELECTION_KEY = `${EXTENSION_ID}:selectedEnvironments`;
const REPAIR_OPT_OUT_KEY = `${EXTENSION_ID}:repairOptOut`;
const ACTIVATION_PROMPT_KEY = `${EXTENSION_ID}:activationPromptAnswered`;

type SelectionState = Record<string, string>;

export class PixiEnvironmentService implements Disposable {
    private environments: PixiEnvironment[] = [];

    private readonly _onDidChangeEnvironments = new EventEmitter<void>();
    readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;

    dispose(): void {
        this._onDidChangeEnvironments.dispose();
    }

    getEnvironments(): readonly PixiEnvironment[] {
        return this.environments;
    }

    getEnvironmentsForFolder(folder: Uri): PixiEnvironment[] {
        return this.environments.filter((env) => isInside(env.projectPath, folder.fsPath));
    }

    async refresh(token?: CancellationToken): Promise<readonly PixiEnvironment[]> {
        this.environments = await window.withProgress(
            { location: ProgressLocation.Window, title: 'Discovering Pixi environments' },
            () => discoverEnvironments(token),
        );
        traceInfo(`Discovered ${this.environments.length} Pixi environment(s)`);

        const degraded = this.environments.filter(causesKernelStall);
        if (degraded.length > 0) {
            traceWarn(
                `${degraded.length} environment(s) are missing conda-meta/pixi and will stall Jupyter kernel ` +
                    `starts by 30s: ${degraded.map((env) => env.prefix).join(', ')}`,
            );
        }
        this._onDidChangeEnvironments.fire();
        return this.environments;
    }

    /**
     * Points the Python extension — and therefore Jupyter — at an environment,
     * and remembers the choice for the folder.
     */
    async select(env: PixiEnvironment, folder: Uri): Promise<void> {
        if (!env.pythonPath) {
            window.showErrorMessage(`${displayName(env)} has no Python interpreter. Run \`pixi install\` first.`);
            return;
        }

        await setActiveInterpreter(env.pythonPath, folder);

        const state = await getWorkspacePersistentState();
        const selections: SelectionState = (await state.get(SELECTION_KEY)) ?? {};
        selections[folder.fsPath] = env.id;
        await state.set(SELECTION_KEY, selections);

        this._onDidChangeEnvironments.fire();
    }

    /**
     * Selects a Pixi environment for every folder that has one, unless the user
     * already picked a Pixi environment from that same project — an explicit
     * choice between Pixi environments is never overridden.
     */
    async autoSelect(): Promise<void> {
        for (const folder of workspace.workspaceFolders ?? []) {
            const target = await this.resolveTarget(folder);
            if (!target) {
                continue;
            }

            const active = await getActiveInterpreter(folder.uri);
            if (active && canonicalPath(active) === canonicalPath(target.pythonPath ?? '')) {
                continue;
            }

            traceInfo(`Auto-selecting ${qualifiedName(target, this.environments)} for ${folder.name}`);
            await this.select(target, folder.uri);
        }
    }

    /**
     * The environment this folder should be using, or undefined when the choice
     * is not ours to make — auto-selection disabled, no environments, an
     * ambiguous parent directory, or the user already on a Pixi environment of
     * the same project.
     */
    private async resolveTarget(folder: WorkspaceFolder): Promise<PixiEnvironment | undefined> {
        if (!workspace.getConfiguration(CONFIG_SECTION, folder.uri).get<boolean>('autoSelectEnvironment', true)) {
            return undefined;
        }

        const candidates = this.getEnvironmentsForFolder(folder.uri).filter((env) => env.pythonPath);
        if (candidates.length === 0) {
            return undefined;
        }

        const active = await getActiveInterpreter(folder.uri);
        if (active && candidates.some((env) => canonicalPath(env.pythonPath ?? '') === canonicalPath(active))) {
            traceVerbose(`${folder.name} already uses a Pixi interpreter; leaving it alone`);
            return undefined;
        }

        // Opening a parent directory can surface many unrelated projects. Only
        // choose for the user when the intent is unambiguous: a project at the
        // folder root, or a single project inside it.
        const projectPaths = new Set(candidates.map((env) => env.projectPath));
        const rootProject = canonicalPath(folder.uri.fsPath);
        const hasRootProject = [...projectPaths].some((p) => canonicalPath(p) === rootProject);

        if (!hasRootProject && projectPaths.size > 1) {
            traceInfo(
                `${folder.name} contains ${projectPaths.size} Pixi projects and none at its root; ` +
                    'leaving the interpreter alone. Use "Pixi: Select Environment" to choose.',
            );
            return undefined;
        }

        const scoped = hasRootProject
            ? candidates.filter((env) => canonicalPath(env.projectPath) === rootProject)
            : candidates;

        const state = await getWorkspacePersistentState();
        const selections: SelectionState = (await state.get(SELECTION_KEY)) ?? {};
        return this.pickDefault(scoped, selections[folder.uri.fsPath], folder);
    }

    /**
     * Re-applies our choice if something overwrites it during startup.
     *
     * The Python extension applies its own initial environment selection a few
     * hundred milliseconds after activation, and when its discovery has not
     * finished it falls back to a system Python — overwriting the environment we
     * just selected. Observed in a fresh profile: we select at T+0.876, it
     * selects /usr/local/bin/python3 at T+1.265.
     *
     * The window is deliberately short and logged. Once it closes, whatever is
     * selected is the user's business and is never touched again.
     */
    async guardStartupSelection(windowMs: number): Promise<Disposable> {
        const api = await getPythonApi();
        const deadline = Date.now() + windowMs;
        let reasserting = false;

        return api.environments.onDidChangeActiveEnvironmentPath(async (event) => {
            if (reasserting || Date.now() > deadline) {
                return;
            }

            const uri = event.resource?.uri ?? workspace.workspaceFolders?.[0]?.uri;
            if (!uri) {
                return;
            }
            const folder = workspace.getWorkspaceFolder(uri);
            if (!folder) {
                return;
            }

            // If it already points at one of this project's environments, the
            // change was ours or the user's and either way it is correct.
            const mine = this.getEnvironmentsForFolder(folder.uri).filter((env) => env.pythonPath);
            if (mine.some((env) => canonicalPath(env.pythonPath ?? '') === canonicalPath(event.path))) {
                return;
            }

            const target = await this.resolveTarget(folder);
            if (!target?.pythonPath) {
                return;
            }

            traceWarn(
                `Interpreter for ${folder.name} was changed to ${event.path} during startup; ` +
                    `restoring ${qualifiedName(target, this.environments)}`,
            );
            reasserting = true;
            try {
                await this.select(target, folder.uri);
            } finally {
                reasserting = false;
            }
        });
    }

    private pickDefault(
        candidates: PixiEnvironment[],
        storedId: string | undefined,
        folder: WorkspaceFolder,
    ): PixiEnvironment | undefined {
        const stored = storedId ? candidates.find((env) => env.id === storedId) : undefined;
        if (stored) {
            return stored;
        }

        // A folder can contain several Pixi projects, and their environments are
        // routinely all called "default". Prefer the project closest to the
        // folder root so the outer project wins over anything nested inside it.
        const nearest = Math.min(...candidates.map((env) => env.projectPath.length));
        const closest = candidates.filter((env) => env.projectPath.length === nearest);

        const preferred = workspace
            .getConfiguration(CONFIG_SECTION, folder.uri)
            .get<string>('defaultEnvironmentName', 'default');
        return closest.find((env) => env.name === preferred) ?? closest[0];
    }

    /**
     * Offers to repair environments missing `conda-meta/pixi`. This is the fix
     * for the 30-second Jupyter kernel stall — `pixi install` rewrites the
     * marker, after which the Python extension classifies the environment as
     * Pixi and uses the fast `pixi run` path.
     */
    /** Environments currently backing a workspace folder's interpreter. */
    private async getSelectedEnvironments(): Promise<PixiEnvironment[]> {
        const selected = new Map<string, PixiEnvironment>();
        for (const folder of workspace.workspaceFolders ?? []) {
            const active = await getActiveInterpreter(folder.uri);
            const match = active ? this.environments.find((env) => env.pythonPath === active) : undefined;
            if (match) {
                selected.set(match.id, match);
            }
        }
        return [...selected.values()];
    }

    async repairDegradedEnvironments(explicit = false): Promise<void> {
        // Unprompted, only complain about environments actually in use. Opening a
        // parent directory can discover many unrelated projects, and warning about
        // an environment nobody is working in is pure noise.
        const candidates = explicit ? [...this.environments] : await this.getSelectedEnvironments();
        const broken = candidates.filter(causesKernelStall);
        if (broken.length === 0) {
            if (explicit) {
                window.showInformationMessage('All Pixi environments are healthy.');
            } else {
                traceVerbose('No in-use environment needs repair; not prompting.');
            }
            return;
        }

        const mode = workspace.getConfiguration(CONFIG_SECTION).get<string>('repairEnvironments', 'prompt');
        if (!explicit && mode === 'off') {
            return;
        }

        traceInfo(
            `Prompting to repair ${broken.length} in-use environment(s): ` + broken.map((env) => env.prefix).join(', '),
        );

        const state = await getWorkspacePersistentState();
        if (!explicit && mode === 'prompt') {
            if (await state.get<boolean>(REPAIR_OPT_OUT_KEY)) {
                return;
            }

            const names = broken.map((env) => `${qualifiedName(env, this.environments)} (${env.prefix})`).join(', ');
            const subject =
                broken.length === 1
                    ? `The Pixi environment in use, ${names}, is missing its \`conda-meta/pixi\` marker`
                    : `${broken.length} Pixi environments in use are missing their \`conda-meta/pixi\` marker: ${names}`;
            const choice = await window.showWarningMessage(
                `${subject}, so VS Code reads it as a conda environment and every Jupyter kernel start takes an ` +
                    'extra 30 seconds. Repair by running `pixi install`?',
                'Repair',
                'Not now',
                "Don't ask again",
            );

            if (choice === "Don't ask again") {
                await state.set(REPAIR_OPT_OUT_KEY, true);
                return;
            }
            if (choice !== 'Repair') {
                return;
            }
        }

        await this.runRepair(broken);
    }

    private async runRepair(broken: PixiEnvironment[]): Promise<void> {
        const failures: string[] = [];

        await window.withProgress(
            { location: ProgressLocation.Notification, title: 'Repairing Pixi environments', cancellable: true },
            async (progress, token) => {
                for (const [index, env] of broken.entries()) {
                    if (token.isCancellationRequested) {
                        return;
                    }
                    progress.report({
                        message: `${displayName(env)} (${index + 1}/${broken.length})`,
                        increment: index === 0 ? 0 : 100 / broken.length,
                    });
                    try {
                        await pixiInstall(env.manifestPath, env.name, token);
                    } catch (error) {
                        traceError(`Failed to repair ${displayName(env)}:`, error);
                        failures.push(displayName(env));
                    }
                }
            },
        );

        // The Python extension caches the old conda classification, so it has to
        // re-scan before the repair takes effect.
        await refreshInterpreters();
        await this.refresh();

        if (failures.length > 0) {
            window.showErrorMessage(`Could not repair: ${failures.join(', ')}. See the Pixi output channel.`);
        } else {
            window.showInformationMessage(`Repaired ${broken.length} Pixi environment(s).`);
        }
    }

    /**
     * Hands environment management back to the Python extension.
     *
     * When `ms-python.vscode-python-envs` is installed and
     * `python.useEnvironmentsExtension` has not been written, that extension
     * owns both discovery and terminal activation — while having no Pixi
     * support. Observed in a fresh profile: this extension selects the Pixi
     * interpreter, and 300ms later the environments extension replaces it with
     * `/usr/local/bin/python3`.
     *
     * The setting is an experiment flag, so a new install can be enrolled with
     * it on. Writing an explicit `false` is the only thing that settles it, and
     * without it this extension is simply overruled — which is why the default
     * is to write rather than ask.
     */
    async ensureEnvironmentOwnership(): Promise<void> {
        if (!isEnvsExtensionInstalled() || !isSettingUnset() || this.environments.length === 0) {
            return;
        }
        if (!isDiscoveryDelegated() && !isTerminalActivationDelegated()) {
            return;
        }

        const mode = workspace.getConfiguration(CONFIG_SECTION).get<string>('configureEnvironmentsExtension', 'auto');
        if (mode === 'off') {
            return;
        }

        const wasDiscoveryDelegated = isDiscoveryDelegated();
        const owns = wasDiscoveryDelegated ? 'environment discovery' : 'terminal activation';

        if (mode === 'auto') {
            await reclaimTerminalActivation(ConfigurationTarget.Workspace);
            traceInfo(
                `The Python Environments extension owns ${owns} but has no Pixi support; ` +
                    'set python.useEnvironmentsExtension=false for this workspace.',
            );

            // The Python extension reads this once and caches it for the
            // session, so the setting does not take hold until the window
            // reloads. Saying so beats leaving it half-applied.
            if (wasDiscoveryDelegated) {
                const reload = await window.showInformationMessage(
                    'Pixi environments were being handled by the Python Environments extension, which has no Pixi ' +
                        'support. That is now switched off for this workspace, but the Python extension only reads ' +
                        'the setting at startup. Reload to pick up your Pixi environment?',
                    'Reload Window',
                    'Later',
                );
                if (reload === 'Reload Window') {
                    await commands.executeCommand('workbench.action.reloadWindow');
                }
            }
            return;
        }

        const state = await getWorkspacePersistentState();
        if (await state.get<boolean>(ACTIVATION_PROMPT_KEY)) {
            return;
        }

        const choice = await window.showInformationMessage(
            `The Python Environments extension is handling ${owns}, but it has no Pixi support, so your Pixi ` +
                'environment may be ignored. Set `python.useEnvironmentsExtension` to false so the Python ' +
                'extension handles it instead?',
            'Set for workspace',
            'Set globally',
            'Leave it',
        );

        await state.set(ACTIVATION_PROMPT_KEY, true);

        if (choice === 'Set for workspace') {
            await reclaimTerminalActivation(ConfigurationTarget.Workspace);
        } else if (choice === 'Set globally') {
            await reclaimTerminalActivation(ConfigurationTarget.Global);
        }
    }
}

function isInside(candidate: string, parent: string): boolean {
    const child = canonicalPath(candidate);
    const root = canonicalPath(parent);

    if (child === root) {
        return true;
    }
    if (!child.startsWith(root)) {
        return false;
    }
    const next = child[root.length];
    return next === '/' || next === '\\';
}
