import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const PKG = 'dsh-video-vision';

/** A throwaway DSH_HOME with one profile, so the real one is never touched. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'vv-install-'));
  const profile = join(home, 'profiles', 't1');
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({ name: 't1', dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
  );
  return { home, profile };
}

function install(home, args = []) {
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'install.mjs'), '--profile', 't1', ...args], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `install.mjs failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Remove a sandbox without ever recursing through the junction inside it. */
function drop(p) {
  let linked = false;
  try {
    linked = realpathSync(p).toLowerCase() !== p.toLowerCase();
  } catch {
    linked = true;
  }
  if (linked) {
    try { rmdirSync(p); return; } catch { try { unlinkSync(p); return; } catch { /* fall through */ } }
  }
  rmSync(p, { recursive: true, force: true, maxRetries: 3 });
}

const readPkg = (profile) => JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
const same = (a, b) => realpathSync(a) === realpathSync(b);

test('install mounts the package and the bundle entry, and is idempotent', () => {
  const { home, profile } = sandbox();
  try {
    const first = install(home);
    assert.match(first, /dependencies\["dsh-video-vision"\] = link:/);
    assert.match(first, /bundles \+= dsh-video-vision/);

    const pkg = readPkg(profile);
    assert.equal(pkg.dependencies[PKG], `link:${ROOT.replace(/\\/g, '/')}`);
    assert.deepEqual(pkg.dsh.profile.bundles, [PKG]);
    assert.ok(same(join(profile, 'node_modules', PKG), ROOT), 'node_modules entry must reach this checkout');

    const second = install(home);
    assert.match(second, /dependency already present/);
    assert.match(second, /bundle entry already present/);
    assert.match(second, /already linked/);
    assert.deepEqual(readPkg(profile).dsh.profile.bundles, [PKG], 'bundles must not grow on reinstall');
  } finally {
    drop(join(profile, 'node_modules', PKG));
    drop(home);
  }
});

test('a node_modules entry pointing at another checkout is replaced, not trusted', () => {
  const { home, profile } = sandbox();
  try {
    install(home);
    // Someone moved the checkout, or installed a second copy: the profile now
    // points at a directory that is not this one. Trusting it means every edit
    // here silently does nothing.
    const link = join(profile, 'node_modules', PKG);
    drop(link);
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, 'package.json'), JSON.stringify({ name: PKG, version: '0.0.0-old' }));

    const out = install(home);
    assert.match(out, /relinked/);
    assert.ok(same(join(profile, 'node_modules', PKG), ROOT));
    assert.equal(
      JSON.parse(readFileSync(join(link, 'package.json'), 'utf8')).version,
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
      'the mounted copy must be this checkout',
    );
  } finally {
    drop(join(profile, 'node_modules', PKG));
    drop(home);
  }
});

test('--dry-run changes nothing', () => {
  const { home, profile } = sandbox();
  try {
    const out = install(home, ['--dry-run']);
    assert.match(out, /\[dry-run\]/);
    const pkg = readPkg(profile);
    assert.equal(pkg.dependencies[PKG], undefined);
    assert.deepEqual(pkg.dsh.profile.bundles, []);
    assert.equal(readPkg(profile).dependencies[PKG], undefined);
  } finally {
    drop(join(profile, 'node_modules', PKG));
    drop(home);
  }
});

test('removing or replacing the link never deletes the checkout it points at', () => {
  const { home, profile } = sandbox();
  const marker = join(ROOT, 'package.json');
  const before = readFileSync(marker, 'utf8');
  try {
    install(home);
    // Replacing a link and uninstalling both delete a node_modules entry that
    // resolves to this checkout. A recursive delete would follow the junction
    // and empty the checkout itself, so both paths are exercised here.
    drop(join(profile, 'node_modules', PKG));
    mkdirSync(join(profile, 'node_modules', PKG), { recursive: true });
    install(home);
    install(home, ['--remove']);

    assert.equal(existsSync(join(profile, 'node_modules', PKG)), false, 'the link must be gone');
    assert.equal(readFileSync(marker, 'utf8'), before, 'this checkout must be untouched');
    assert.ok(existsSync(join(ROOT, 'src', 'index.js')), 'src must still be there');
  } finally {
    drop(join(profile, 'node_modules', PKG));
    drop(home);
  }
});
