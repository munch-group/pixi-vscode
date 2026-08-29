#!/usr/bin/env node
//
// Bump the extension version in package.json (and package-lock.json with it).
//
//     node scripts/bump-version.js            0.1.0 -> 0.1.1
//     node scripts/bump-version.js --fix      0.1.0 -> 0.1.1
//     node scripts/bump-version.js --minor    0.1.0 -> 0.2.0
//     node scripts/bump-version.js --major    0.1.0 -> 1.0.0
//
// The version is <major>.<minor>.<fix>. `--fix` is what npm calls `patch`; both
// spellings are accepted, and it is the default because it is the common case.
//
// This only edits the files. Committing and tagging stay manual: the release
// workflow checks that the git tag matches the version in package.json, and a
// bump that tagged itself would make that check circular — it would compare a
// tag against the file the same command just wrote.

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const LEVELS = {
    '--major': 'major',
    '--minor': 'minor',
    '--fix': 'patch',
    '--patch': 'patch',
};

function main(argv) {
    const flags = argv.filter((arg) => arg !== '');

    if (flags.includes('-h') || flags.includes('--help')) {
        console.log('usage: bump-version.js [--major | --minor | --fix]   (default --fix)');
        return 0;
    }

    const unknown = flags.filter((arg) => !(arg in LEVELS));
    if (unknown.length > 0) {
        console.error(`error: unknown option: ${unknown.join(' ')}`);
        console.error('       expected one of --major, --minor, --fix');
        return 2;
    }
    if (flags.length > 1) {
        console.error(`error: pick one of --major, --minor, --fix (got ${flags.join(' ')})`);
        return 2;
    }

    const level = flags.length === 1 ? LEVELS[flags[0]] : 'patch';
    const repo = path.resolve(__dirname, '..');
    const before = require(path.join(repo, 'package.json')).version;

    // npm owns this rather than hand-rolled arithmetic, so package-lock.json is
    // updated in step. --no-git-tag-version keeps it out of git entirely; it
    // also means npm does not refuse to run in a dirty working tree.
    execFileSync('npm', ['version', level, '--no-git-tag-version'], { cwd: repo, stdio: 'pipe' });

    delete require.cache[require.resolve(path.join(repo, 'package.json'))];
    const after = require(path.join(repo, 'package.json')).version;

    console.log(`${before} -> ${after}  (${level})`);
    console.log('package.json and package-lock.json updated; nothing committed or tagged.');
    return 0;
}

process.exit(main(process.argv.slice(2)));
