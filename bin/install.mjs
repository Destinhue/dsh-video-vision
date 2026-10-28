#!/usr/bin/env node
/**
 * Install dsh-video-vision into a DeepSeek Harness profile.
 *
 * A DSH profile is three things: a `package.json` with the dependency, an entry
 * in `dsh.profile.bundles`, and the package present under `node_modules/`. The
 * harness applies the package's own `cordis.patch.yml` on the next start, which
 * is what mounts the tools.
 *
 * This script does the `pnpm add link:<path>` equivalent by hand, because the
 * desktop profile is managed by the Electron app and is not a pnpm project you
 * can just add to. It is idempotent: running it twice changes nothing.
 *
 *   node bin/install.mjs                     # into the desktop profile
 *   node bin/install.mjs --profile work      # another profile
 *   node bin/install.mjs --copy              # copy instead of link
 *   node bin/install.mjs --dry-run           # show what would change
 *   node bin/install.mjs --remove            # uninstall
 *
 * Restart the harness afterwards: tools are registered at boot.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG = 'dsh-video-vision';
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const dryRun = flag('dry-run');
const remove = flag('remove');
const copy = flag('copy');
const profileName = value('profile', 'desktop');
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', profileName);
const pkgPath = join(profileDir, 'package.json');
const linkPath = join(profileDir, 'node_modules', PKG);

const log = (msg) => console.log(`${dryRun ? '[dry-run] ' : ''}${msg}`);
const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

if (!existsSync(pkgPath)) {
  fail(`no profile at ${profileDir} (looked for package.json). Use --profile <name>.`);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.dependencies ??= {};
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
const bundles = pkg.dsh.profile.bundles;
const hadDep = Object.hasOwn(pkg.dependencies, PKG);
const hadBundle = bundles.includes(PKG);

if (remove) {
  if (hadDep) delete pkg.dependencies[PKG];
  const at = bundles.indexOf(PKG);
  if (at >= 0) bundles.splice(at, 1);
  log(`${hadDep || hadBundle ? 'unmounting' : 'not mounted:'} ${PKG}`);
  if (!dryRun) {
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    if (existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true });
  }
  log('restart the harness to drop the tools');
  process.exit(0);
}

// 1. dependency
const spec = `link:${PLUGIN_DIR.replace(/\\/g, '/')}`;
if (!hadDep) {
  pkg.dependencies[PKG] = spec;
  log(`dependencies["${PKG}"] = ${spec}`);
} else if (pkg.dependencies[PKG] !== spec) {
  log(`dependencies["${PKG}"] already present (${pkg.dependencies[PKG]}) — left as is`);
} else {
  log(`dependency already present`);
}

// 2. bundle entry — this is what actually mounts the tools
if (!hadBundle) {
  bundles.push(PKG);
  log(`dsh.profile.bundles += ${PKG} (now ${bundles.length})`);
} else {
  log(`bundle entry already present`);
}

// 3. node_modules entry
const source = PLUGIN_DIR;
if (!dryRun) {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  mkdirSync(dirname(linkPath), { recursive: true });
  const existing = existsSync(linkPath);
  if (existing) {
    let ok = false;
    try { ok = statSync(linkPath).isDirectory() || statSync(linkPath).isSymbolicLink(); } catch { ok = false; }
    if (!ok) rmSync(linkPath, { recursive: true, force: true });
  }
  if (!existing || copy) {
    if (existing && copy) rmSync(linkPath, { recursive: true, force: true });
    if (copy) {
      // A copy has to be re-copied after every edit; a link stays live.
      execFileSync(platform() === 'win32' ? 'cmd' : 'cp',
        platform() === 'win32' ? ['/c', 'xcopy', '/e', '/i', '/q', '/y', source, linkPath]
          : ['-R', `${source}/.`, linkPath], { stdio: 'ignore' });
      log(`copied ${PKG} into node_modules`);
    } else if (platform() === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, source], { stdio: 'ignore' });
      log(`junction node_modules/${PKG} -> ${source}`);
    } else {
      execFileSync('ln', ['-sfn', source, linkPath], { stdio: 'ignore' });
      log(`symlink node_modules/${PKG} -> ${source}`);
    }
  } else {
    log(`node_modules/${PKG} already linked`);
  }
}

log('');
log('next: restart DeepSeek Harness. The three tools appear as');
log('  video_probe · video_storyboard · video_zoom');
log(`verify with: node "${join(PLUGIN_DIR, 'bin', 'selfcheck.mjs')}"`);
