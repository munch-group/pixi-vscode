import { Command, Disposable, StatusBarAlignment, StatusBarItem, ThemeColor, window, workspace } from 'vscode';

import { comparablePath, CONFIG_SECTION, samePath } from '../common/utils';
import { PixiEnvironmentService } from '../environmentService';
import { causesKernelStall, isNonPythonEnvironment, needsRebuild } from '../pixi/health';
import { displayName, PixiEnvironment, qualifiedName } from '../pixi/types';
import { getActiveInterpreter } from '../python/api';

/**
 * VS Code accepts only two background colours on a status bar item (see the
 * note on StatusBarItem.backgroundColor). Any other ThemeColor is ignored and
 * the pill renders with no background at all, so a blue one is not available to
 * an extension. The two states that need to stand out take one each, which also
 * keeps them distinguishable from one another.
 */
type PillBackground = 'statusBarItem.errorBackground' | 'statusBarItem.warningBackground';

interface PillState {
    text: string;
    tooltip: string;
    background?: PillBackground;
    /** What clicking the pill does. */
    command: Command;
}

export class PixiStatusBar implements Disposable {
    private item: StatusBarItem | undefined;
    /** What is currently on screen, so an unchanged update touches nothing. */
    private rendered: string | undefined;
    private readonly disposables: Disposable[] = [];

    constructor(private readonly service: PixiEnvironmentService) {
        this.disposables.push(
            service.onDidChangeEnvironments(() => void this.update()),
            window.onDidChangeActiveTextEditor(() => void this.update()),
        );
    }

    /**
     * Renders the pill, replacing the item rather than editing it.
     *
     * Editing `text` or `tooltip` on a visible item leaves any open hover
     * behind: VS Code binds the hover to the entry and does not re-evaluate it,
     * so after clicking the pill and choosing an environment the old tooltip
     * stays pinned until something else dismisses it. Disposing the item removes
     * the element the hover is attached to, which cannot leave one orphaned.
     *
     * The signature check matters as much as the replacement. This runs on every
     * active-editor change, and recreating the item each time would make the
     * pill flicker constantly; comparing first means the common case does
     * nothing at all.
     */
    async update(): Promise<void> {
        const state = await this.computeState();
        const signature = state === undefined ? '' : JSON.stringify(state);
        if (signature === this.rendered) {
            return;
        }
        this.rendered = signature;

        this.item?.dispose();
        this.item = undefined;

        if (state === undefined) {
            return;
        }

        const item = window.createStatusBarItem(StatusBarAlignment.Right, 99);
        item.command = state.command;
        item.text = state.text;
        item.tooltip = state.tooltip;
        if (state.background) {
            item.backgroundColor = new ThemeColor(state.background);
        }
        item.show();
        this.item = item;
    }

    /** The pill to show, or undefined when there should not be one. */
    private async computeState(): Promise<PillState | undefined> {
        if (!workspace.getConfiguration(CONFIG_SECTION).get<boolean>('showStatusBarItem', true)) {
            return undefined;
        }

        const environments = this.service.getEnvironments();
        if (environments.length === 0) {
            return undefined;
        }

        const active = await getActiveInterpreter();
        const current = environments.find((env) => samePath(env.pythonPath, active));

        if (!current) {
            // No Pixi interpreter is active, which does not mean nothing is
            // wrong. A moved environment is broken for every purpose, and one
            // holding no Python at all — or one the Python extension has not
            // discovered since the move — can never be the active interpreter,
            // so the branches below never see it. Picking it, which is all the
            // orange pill can lead to, does not fix it either. Say what is
            // actually wrong instead of asking for a choice that would not help.
            const moved = this.movedRootEnvironment(environments);
            if (moved) {
                return {
                    text: '$(warning) Rebuild Pixi env',
                    tooltip:
                        `${qualifiedName(moved, environments)} was moved after \`pixi install\`: ${moved.prefix} ` +
                        "still points at the folder's old location. Click to rebuild it.",
                    background: 'statusBarItem.errorBackground',
                    command: fixCommand(moved),
                };
            }

            // Nor is there anything to select, when every environment found
            // contains no Python: a pill asking for a choice that the picker
            // cannot offer is worse than no pill, and a Pixi project that does
            // not use Python is not this extension's business anyway.
            if (environments.every(isNonPythonEnvironment)) {
                return undefined;
            }

            return {
                text: '$(prefix-dev) Select Pixi env',
                tooltip: 'No Pixi environment is active. Click to select one.',
                // Prominent, because the pill is the thing to click.
                background: 'statusBarItem.warningBackground',
                command: selectCommand,
            };
        }

        const label = `$(prefix-dev) ${current.projectName}:${current.name}`;

        if (needsRebuild(current)) {
            return {
                text: `$(warning) ${label}`,
                tooltip:
                    `${current.prefix} was moved after \`pixi install\`. Jupyter kernels will fail to start. ` +
                    'Click to rebuild it.',
                background: 'statusBarItem.errorBackground',
                command: fixCommand(current),
            };
        }

        if (causesKernelStall(current)) {
            // Costs 30 seconds on every kernel start, and there is a one-click fix.
            return {
                text: `$(warning) ${label}`,
                tooltip:
                    `${current.prefix} is missing conda-meta/pixi and will stall Jupyter kernel starts by 30s. ` +
                    'Click to repair it.',
                background: 'statusBarItem.errorBackground',
                command: fixCommand(current),
            };
        }

        return {
            text: label,
            tooltip: `Pixi environment: ${displayName(current)}\n${current.prefix}\n\nClick to switch.`,
            command: selectCommand,
        };
    }

    /**
     * A moved environment belonging to a project at the root of an open folder.
     *
     * Only the root, deliberately. Opening a parent directory discovers every
     * Pixi project underneath it, and a red pill about a stale environment three
     * directories down — in something the user is not working on — is noise. A
     * project at the folder root is unambiguously what this window is about.
     *
     * Only a *moved* environment, equally deliberately. The missing marker costs
     * 30 seconds per kernel start, which is a cost only paid by an environment
     * something is actually running; there is nothing to warn about while it
     * sits unused. Being moved is not like that — it breaks the environment
     * itself, whether or not anything has selected it yet.
     */
    private movedRootEnvironment(environments: readonly PixiEnvironment[]): PixiEnvironment | undefined {
        const roots = (workspace.workspaceFolders ?? []).map((folder) => comparablePath(folder.uri.fsPath));
        return environments.find((env) => needsRebuild(env) && roots.includes(comparablePath(env.projectPath)));
    }

    dispose(): void {
        this.item?.dispose();
        this.disposables.forEach((d) => d.dispose());
    }
}

const selectCommand: Command = { command: 'im-pixi-vscode.selectEnvironment', title: 'Select Pixi Environment' };

/**
 * Sends the click to the repair dialog rather than to the interpreter picker.
 *
 * The environment is named in the argument rather than looked up again by the
 * command, so the dialog can only ever be about the environment the pill was
 * drawn for, however stale that has become by the time it is clicked.
 */
function fixCommand(env: PixiEnvironment): Command {
    return {
        command: 'im-pixi-vscode.fixEnvironment',
        title: 'Repair Pixi Environment',
        arguments: [env.id],
    };
}
