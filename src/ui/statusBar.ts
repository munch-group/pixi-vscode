import { Disposable, StatusBarAlignment, StatusBarItem, ThemeColor, window, workspace } from 'vscode';

import { CONFIG_SECTION } from '../common/utils';
import { PixiEnvironmentService } from '../environmentService';
import { causesKernelStall, needsRebuild } from '../pixi/health';
import { displayName } from '../pixi/types';
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
        item.command = 'im-pixi-vscode.selectEnvironment';
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
        const current = environments.find((env) => env.pythonPath === active);

        if (!current) {
            return {
                text: '$(prefix-dev) Select Pixi env',
                tooltip: 'No Pixi environment is active. Click to select one.',
                // Prominent, because the pill is the thing to click.
                background: 'statusBarItem.warningBackground',
            };
        }

        const label = `$(prefix-dev) ${current.projectName}:${current.name}`;

        if (needsRebuild(current)) {
            return {
                text: `$(warning) ${label}`,
                tooltip:
                    `${current.prefix} was moved after \`pixi install\`. Jupyter kernels will fail to start. ` +
                    'Run "Pixi: Repair Environments".',
                background: 'statusBarItem.errorBackground',
            };
        }

        if (causesKernelStall(current)) {
            // Costs 30 seconds on every kernel start, and there is a one-click fix.
            return {
                text: `$(warning) ${label}`,
                tooltip:
                    `${current.prefix} is missing conda-meta/pixi and will stall Jupyter kernel starts by 30s. ` +
                    'Run "Pixi: Repair Environments".',
                background: 'statusBarItem.errorBackground',
            };
        }

        return {
            text: label,
            tooltip: `Pixi environment: ${displayName(current)}\n${current.prefix}\n\nClick to switch.`,
        };
    }

    dispose(): void {
        this.item?.dispose();
        this.disposables.forEach((d) => d.dispose());
    }
}
