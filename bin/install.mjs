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
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, statSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
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

/**
 * Delete `p` without ever walking through a link.
 *
 * `rmSync(p, { recursive: true })` follows a directory junction / symlink and
 * deletes the *target's* contents. Running it on the stale node_modules entry
 * therefore empties the checkout it was pointing at — the opposite of what an
 * install is allowed to do. Remove the link itself: one `rmdir`/`unlink`.
 */
function removeEntry(p) {
  let linked = false;
  try {
    linked = realpathSync(p).toLowerCase() !== resolve(p).toLowerCase();
  } catch {
    linked = true; // dangling link: realpath throws, and it must not be walked
  }
  if (linked) {
    try { rmdirSync(p); return; } catch { /* a file symlink needs unlink */ }
    try { unlinkSync(p); return; } catch { /* fall through to rm for safety */ }
  }
  rmSync(p, { recursive: true, force: true });
}

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
    if (existsSync(linkPath)) removeEntry(linkPath);
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
  const current = String(pkg.dependencies[PKG]);
  // A link: that points at another checkout means this plugin was installed
  // from somewhere else (a moved directory, or a second copy). Repoint it,
  // otherwise the profile keeps loading the old source and the edit the user
  // just made never takes effect — which looks exactly like a broken plugin.
  if (/^link:/.test(current) && !dryRun) {
    pkg.dependencies[PKG] = spec;
    log(`dependencies["${PKG}"] repointed: ${current} -> ${spec}`);
  } else if (/^link:/.test(current)) {
    log(`dependencies["${PKG}"] would be repointed: ${current} -> ${spec}`);
  } else {
    log(`dependencies["${PKG}"] is ${current} — left as is (not a link:)`);
  }
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

/** Does the existing node_modules entry already resolve to this checkout? */
const pointsHere = (p) => {
  try {
    const here = realpathSync(p);
    const want = realpathSync(source);
    return platform() === 'win32'
      ? here.toLowerCase() === want.toLowerCase()
      : here === want;
  } catch {
    return false;
  }
};

const existing = existsSync(linkPath) || (() => { try { statSync(linkPath); return true; } catch { return false; } })();
// A link that resolves to a *different* checkout is as stale as a missing one:
// leaving it alone makes every edit in this directory look like a no-op, which
// is exactly the confusion the dependency repoint above exists to prevent.
const stale = existing && !copy && !pointsHere(linkPath);

if (dryRun) {
  if (stale) log(`node_modules/${PKG} would be relinked to this checkout`);
  else if (!existing) log(`node_modules/${PKG} would be linked to this checkout`);
  else log(`node_modules/${PKG} already linked`);
}

if (!dryRun) {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  mkdirSync(dirname(linkPath), { recursive: true });
  if (existing) {
    let ok = false;
    try { ok = statSync(linkPath).isDirectory() || statSync(linkPath).isSymbolicLink(); } catch { ok = false; }
    if (!ok) removeEntry(linkPath);
  }
  if (!existing || copy || stale) {
    if (existing) removeEntry(linkPath);
    if (copy) {
      // A copy has to be re-copied after every edit; a link stays live.
      execFileSync(platform() === 'win32' ? 'cmd' : 'cp',
        platform() === 'win32' ? ['/c', 'xcopy', '/e', '/i', '/q', '/y', source, linkPath]
          : ['-R', `${source}/.`, linkPath], { stdio: 'ignore' });
      log(`copied ${PKG} into node_modules`);
    } else if (platform() === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, source], { stdio: 'ignore' });
      log(`${stale ? 'relinked' : 'junction'} node_modules/${PKG} -> ${source}`);
    } else {
      execFileSync('ln', ['-sfn', source, linkPath], { stdio: 'ignore' });
      log(`${stale ? 'relinked' : 'symlink'} node_modules/${PKG} -> ${source}`);
    }
  } else {
    log(`node_modules/${PKG} already linked`);
  }
}

log('');
log('next: restart DeepSeek Harness. The four tools appear as');
log('  video_probe · video_storyboard · video_zoom · video_read');
log(`verify with: node "${join(PLUGIN_DIR, 'bin', 'selfcheck.mjs')}"`);
