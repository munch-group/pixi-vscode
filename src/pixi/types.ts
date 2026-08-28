import * as path from 'path';

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

/**
 * Distinguishes environments whose projects declare the same name, which is
 * common when a project is copied or vendored: `pixi.toml` carries the name, so
 * two directories can legitimately claim the same one.
 */
export function qualifiedName(env: PixiEnvironment, all: readonly PixiEnvironment[]): string {
    const collides = all.some((o) => o.projectName === env.projectName && o.projectPath !== env.projectPath);
    if (!collides) {
        return displayName(env);
    }
    // The directory usually distinguishes them, but when it merely repeats the
    // project name it says nothing — reach one level up for something useful.
    const dir = path.basename(env.projectPath);
    const hint = dir === env.projectName ? path.join(path.basename(path.dirname(env.projectPath)), dir) : dir;

    const version = env.pythonVersion ? ` (${env.pythonVersion})` : '';
    return `${env.projectName} [${hint}]:${env.name}${version}`;
}

export function displayName(env: PixiEnvironment): string {
    const version = env.pythonVersion ? ` (${env.pythonVersion})` : '';
    return `${env.projectName}:${env.name}${version}`;
}
