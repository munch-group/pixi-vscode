/** Shape of `pixi info --json`. */
export interface PixiInfo {
    project_info?: {
        name: string;
        manifest_path: string;
    };
    environments_info: Array<{
        name: string;
        prefix: string;
    }>;
}

/**
 * Why an environment may not work correctly in VS Code.
 *
 * `missingPixiMarker` is the important one: it is the state that makes VS Code
 * classify a Pixi prefix as conda and stall Jupyter kernel starts by 30s.
 */
export type EnvironmentHealth = 'healthy' | 'missingPixiMarker' | 'notInstalled' | 'noPython';

export interface PixiEnvironment {
    /** Stable identity — the environment prefix. */
    id: string;
    /** Pixi environment name, e.g. `default` or `test`. */
    name: string;
    /** Pixi project name from the manifest. */
    projectName: string;
    /** Absolute path to `pixi.toml` / `pyproject.toml`. */
    manifestPath: string;
    /** Directory containing the manifest. */
    projectPath: string;
    /** Absolute path to the environment prefix. */
    prefix: string;
    pythonPath?: string;
    pythonVersion?: string;
    health: EnvironmentHealth;
}

export function displayName(env: PixiEnvironment): string {
    const version = env.pythonVersion ? ` (${env.pythonVersion})` : '';
    return `${env.projectName}:${env.name}${version}`;
}
