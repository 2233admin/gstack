/**
 * setup.ps1: the Windows entry point checks Git for Windows, Bun and Node.js,
 * then runs ./setup in Git Bash with every argument passed as its own argv
 * entry, never pasted into shell source. The behavioral cases copy the script
 * next to a stub ./setup that prints its argv and run it under both PowerShells.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const SCRIPT = path.resolve(import.meta.dir, '..', 'setup.ps1');
const PWSH = Bun.which('pwsh');
const BASH = Bun.which('bash');
const WINDOWS_POWERSHELL = process.platform === 'win32' ? Bun.which('powershell') : null;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function stubCheckout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup ps1-'));
  dirs.push(dir);
  fs.copyFileSync(SCRIPT, path.join(dir, 'setup.ps1'));
  fs.writeFileSync(path.join(dir, 'setup'), '#!/usr/bin/env bash\nprintf \'cwd=%s\\n\' "$PWD"\nfor a in "$@"; do printf \'arg=[%s]\\n\' "$a"; done\nexit 7\n', { mode: 0o755 });
  return dir;
}

function runPs1(dir: string, args: string[], env: Record<string, string | undefined> = {}, shell = PWSH!) {
  // Encode PowerShell source so the test's own native command line cannot eat
  // quotes before setup.ps1 reaches the PowerShell-to-Git-Bash boundary.
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const command = `& ${literal(path.join(dir, 'setup.ps1'))} ${args.map(literal).join(' ')}; exit $LASTEXITCODE`;
  const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    cwd: os.tmpdir(),
    encoding: 'utf-8',
    env: { ...process.env, ...(process.platform === 'win32' ? {} : { GSTACK_GIT_BASH: BASH! }), ...env },
    timeout: 60_000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('setup.ps1', () => {

  for (const [name, shell] of [['pwsh', PWSH], ['Windows PowerShell 5.1', WINDOWS_POWERSHELL]]) {
    test.skipIf(!shell || !BASH)(`${name}: forwards literal refresh arguments from the script directory and keeps the exit code`, () => {
      const dir = stubCheckout();
      const temp = path.join(dir, 'private temp files');
      fs.mkdirSync(temp);
      const args = ['--refresh-registered', '', 'two words', '$(touch PWNED)', "it's", '"quoted"', 'back\\slash\\"quote', ';echo injected', '`whoami`', '中文'];
      const { code, out } = runPs1(dir, args, { TMP: temp, TEMP: temp, TMPDIR: temp }, shell!);
      expect(code, out).toBe(7);
      const lines = out.split(/\r?\n/);
      expect(lines.filter((l) => l.startsWith('arg=['))).toEqual(args.map((a) => `arg=[${a}]`));
      expect(lines.find((l) => l.startsWith('cwd='))).toContain(path.basename(dir));
      expect(out).not.toContain('injected\n');
      expect(fs.existsSync(path.join(dir, 'PWNED'))).toBe(false);
      expect(fs.existsSync(path.join(os.tmpdir(), 'PWNED'))).toBe(false);
      expect(fs.readdirSync(temp)).toEqual([]);
    });

    test.skipIf(!shell || !BASH)(`${name}: runs setup without inventing an empty argument`, () => {
      const dir = stubCheckout();
      const { code, out } = runPs1(dir, [], {}, shell!);
      expect(code, out).toBe(7);
      expect(out).not.toContain('arg=[');
    });
  }

  test.skipIf(!PWSH || !BASH || process.platform === 'win32')('a missing prerequisite names its winget command and runs nothing', () => {
    const dir = stubCheckout();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-ps1-bin-'));
    dirs.push(bin);
    for (const tool of ['git', 'node']) {
      const real = Bun.which(tool);
      if (real) fs.symlinkSync(real, path.join(bin, tool));
    }
    const { code, out } = runPs1(dir, ['--host', 'codex'], { PATH: bin });
    expect(code).toBe(1);
    expect(out).toContain('Bun: winget install --id Oven-sh.Bun -e');
    expect(out).not.toContain('Git for Windows:');
    expect(out).not.toContain('arg=[');
  });
});
