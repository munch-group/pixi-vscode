import {
    CancellationToken,
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
import { CONFIG_SECTION, EXTENSION_ID } from './common/utils';
import { pixiInstall } from './pixi/cli';
import { discoverEnvironments } from './pixi/discovery';
import { causesKernelStall } from './pixi/health';
import { displayName, PixiEnvironment } from './pixi/types';
import { getActiveInterpreter, refreshInterpreters, setActiveInterpreter } from './python/api';
import { isEnvsExtensionInstalled, isSettingUnset, reclaimTerminalActivation } from './python/envsExtension';

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
        const state = await getWorkspacePersistentState();
        const selections: SelectionState = (await state.get(SELECTION_KEY)) ?? {};

        for (const folder of workspace.workspaceFolders ?? []) {
            if (!workspace.getConfiguration(CONFIG_SECTION, folder.uri).get<boolean>('autoSelectEnvironment', true)) {
                continue;
            }

            const candidates = this.getEnvironmentsForFolder(folder.uri).filter((env) => env.pythonPath);
            if (candidates.length === 0) {
                continue;
            }

            const active = await getActiveInterpreter(folder.uri);
            if (active && candidates.some((env) => env.pythonPath === active)) {
                traceVerbose(`${folder.name} already uses a Pixi interpreter; leaving it alone`);
                continue;
            }

            const target = this.pickDefault(candidates, selections[folder.uri.fsPath], folder);
            if (target) {
                traceInfo(`Auto-selecting ${displayName(target)} for ${folder.name}`);
                await this.select(target, folder.uri);
            }
        }
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
    async repairDegradedEnvironments(explicit = false): Promise<void> {
        const broken = this.environments.filter(causesKernelStall);
        if (broken.length === 0) {
            if (explicit) {
                window.showInformationMessage('All Pixi environments are healthy.');
            }
            return;
        }

        const mode = workspace.getConfiguration(CONFIG_SECTION).get<string>('repairEnvironments', 'prompt');
        if (!explicit && mode === 'off') {
            return;
        }

        const state = await getWorkspacePersistentState();
        if (!explicit && mode === 'prompt') {
            if (await state.get<boolean>(REPAIR_OPT_OUT_KEY)) {
                return;
            }

            const names = broken.map((env) => `${displayName(env)} at ${env.prefix}`).join(', ');
            const choice = await window.showWarningMessage(
                `${broken.length} Pixi environment(s) are missing their \`conda-meta/pixi\` marker (${names}). ` +
                    'VS Code will misread them as conda environments, which delays every Jupyter kernel start by 30 seconds. ' +
                    'Repair by running `pixi install`?',
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
     * When the environments extension is installed but nobody has written
     * `python.useEnvironmentsExtension`, it silently owns terminal activation
     * while providing no Pixi support. Offer to hand activation back.
     */
    async offerToReclaimTerminalActivation(): Promise<void> {
        if (!isEnvsExtensionInstalled() || !isSettingUnset() || this.environments.length === 0) {
            return;
        }

        const mode = workspace.getConfiguration(CONFIG_SECTION).get<string>('configureEnvironmentsExtension', 'prompt');
        if (mode === 'off') {
            return;
        }

        if (mode === 'auto') {
            await reclaimTerminalActivation(ConfigurationTarget.Workspace);
            traceInfo('Set python.useEnvironmentsExtension=false (workspace) automatically');
            return;
        }

        const state = await getWorkspacePersistentState();
        if (await state.get<boolean>(ACTIVATION_PROMPT_KEY)) {
            return;
        }

        const choice = await window.showInformationMessage(
            'The Python Environments extension is installed and is handling terminal activation, but it has no Pixi ' +
                'support. Set `python.useEnvironmentsExtension` to false so the Python extension activates Pixi ' +
                'environments in terminals?',
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
    const rel = candidate.startsWith(parent);
    return (
        rel &&
        (candidate.length === parent.length || candidate[parent.length] === '/' || candidate[parent.length] === '\\')
    );
}
