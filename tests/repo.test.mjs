// Repo hygiene: generated / fetched data directories are linked into worktrees
// as symlinks; a symlink must never be tracked (twice tonight an ignore rule
// with a trailing slash — directories only — let one through, and the
// fast-forward into the live checkout replaced a real directory with a
// self-referential link and lost the data).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('repo hygiene', () => {
  it('tracks no symlinks under testdata/, data/user/, telemetry/, recordings/', () => {
    const out = execFileSync('git', ['ls-files', '-s', 'testdata', 'data/user', 'telemetry', 'recordings'], { cwd: ROOT, encoding: 'utf8' });
    const links = out.split('\n').filter(l => l.startsWith('120000'));
    assert.deepEqual(links, [], `tracked symlinks: ${links.join(', ')}`);
  });
  it('ignore rules for linked asset dirs have no trailing slash (a slash matches directories only, not symlinks)', () => {
    const rules = execFileSync('cat', ['.gitignore'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
    for (const d of ['testdata/audio', 'testdata/hex', 'testdata/notebank', 'testdata/synth']) {
      assert.ok(rules.includes(d), `.gitignore should contain exactly "${d}"`);
      assert.ok(!rules.includes(d + '/'), `.gitignore must not use "${d}/"`);
    }
  });
});
