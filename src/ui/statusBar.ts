import { Disposable, StatusBarAlignment, StatusBarItem, ThemeColor, window, workspace } from 'vscode';

import { CONFIG_SECTION } from '../common/utils';
import { PixiEnvironmentService } from '../environmentService';
import { causesKernelStall, needsRebuild } from '../pixi/health';
import { displayName } from '../pixi/types';
import { getActiveInterpreter } from '../python/api';

export class PixiStatusBar implements Disposable {
    private readonly item: StatusBarItem;
    private readonly disposables: Disposable[] = [];

    constructor(private readonly service: PixiEnvironmentService) {
        this.item = window.createStatusBarItem(StatusBarAlignment.Right, 99);
        this.item.command = 'im-pixi-vscode.selectEnvironment';
        this.disposables.push(
            this.item,
            service.onDidChangeEnvironments(() => void this.update()),
            window.onDidChangeActiveTextEditor(() => void this.update()),
        );
    }

    async update(): Promise<void> {
        if (!workspace.getConfiguration(CONFIG_SECTION).get<boolean>('showStatusBarItem', true)) {
            this.item.hide();
            return;
        }

        const environments = this.service.getEnvironments();
        if (environments.length === 0) {
            this.item.hide();
            return;
        }

        const active = await getActiveInterpreter();
        const current = environments.find((env) => env.pythonPath === active);

        if (current) {
            this.item.text = `$(prefix-dev) ${current.projectName}:${current.name}`;
            this.item.tooltip = `Pixi environment: ${displayName(current)}\n${current.prefix}\n\nClick to switch.`;
        } else {
            this.item.text = '$(prefix-dev) Select Pixi env';
            this.item.tooltip = 'No Pixi environment is active. Click to select one.';
        }

        // VS Code accepts only two background colours on a status bar item,
        // `statusBarItem.errorBackground` and `statusBarItem.warningBackground`
        // (see the note on StatusBarItem.backgroundColor). Any other ThemeColor
        // is ignored and the pill renders with no background at all, so a blue
        // one is not available to an extension. The two states that need to
        // stand out therefore take one each, which also keeps them
        // distinguishable from one another.
        if (current && needsRebuild(current)) {
            this.item.text = `$(warning) ${this.item.text}`;
            this.item.tooltip =
                `${current.prefix} was moved after \`pixi install\`. Jupyter kernels will fail to start. ` +
                'Run "Pixi: Repair Environments".';
            this.item.backgroundColor = new ThemeColor('statusBarItem.errorBackground');
        } else if (current && causesKernelStall(current)) {
            // Costs 30 seconds on every kernel start, and there is a one-click fix.
            this.item.text = `$(warning) ${this.item.text}`;
            this.item.tooltip =
                `${current.prefix} is missing conda-meta/pixi and will stall Jupyter kernel starts by 30s. ` +
                'Run "Pixi: Repair Environments".';
            this.item.backgroundColor = new ThemeColor('statusBarItem.errorBackground');
        } else if (!current) {
            // Nothing selected: prominent, because the pill is the thing to click.
            this.item.backgroundColor = new ThemeColor('statusBarItem.warningBackground');
        } else {
            this.item.backgroundColor = undefined;
        }

        this.item.show();
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}
