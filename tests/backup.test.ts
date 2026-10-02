import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  BACKUP_SETTINGS,
  PITR_WINDOW_DAYS,
  buildPlan,
  checkRunAllowed,
  defaultProject,
  formatCommand,
  quoteArg,
} from '../scripts/backup.mjs';

// scripts/backup.mjs (Phase 14, "Backup strategy"): the commands the runbook (docs/backup.md) names.
// Nothing here talks to a real project: the project is on the Spark plan, which has no backups.

const PROJECT = 'demo-project';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-10T12:00:00Z');
const BACKUP = 'projects/demo-project/locations/eur3/backups/abc123';

const plan = (action: string, options: Record<string, string | undefined> = {}) =>
  buildPlan(action, { project: PROJECT, ...options }, NOW);

describe('the settings the runbook decided', () => {
  it('keep daily backups for 14 days, with point-in-time recovery and delete protection on', () => {
    expect(BACKUP_SETTINGS).toEqual({
      database: '(default)',
      recurrence: 'DAILY',
      retention: '14d',
      pointInTimeRecovery: 'ENABLED',
      deleteProtection: 'ENABLED',
    });
    expect(PITR_WINDOW_DAYS).toBe(7);
  });

  it('read the project from .firebaserc', () => {
    expect(defaultProject()).toMatch(/^[a-z][a-z0-9-]+$/);
  });
});

describe('setup', () => {
  it('turns on point-in-time recovery and delete protection, then schedules the daily backup', () => {
    expect(plan('setup').steps.map((step) => step.args)).toEqual([
      [
        'firestore:databases:update',
        '(default)',
        '--point-in-time-recovery',
        'ENABLED',
        '--delete-protection',
        'ENABLED',
        '--project',
        PROJECT,
      ],
      [
        'firestore:backups:schedules:create',
        '--database',
        '(default)',
        '--recurrence',
        'DAILY',
        '--retention',
        '14d',
        '--project',
        PROJECT,
      ],
    ]);
  });
});

describe('status', () => {
  it('lists the databases, the schedules and the backups', () => {
    expect(plan('status').steps.map((step) => step.args[0])).toEqual([
      'firestore:databases:list',
      'firestore:backups:schedules:list',
      'firestore:backups:list',
    ]);
  });

  it('can limit the backups to a location', () => {
    expect(plan('status', { location: 'eur3' }).steps[2]?.args).toEqual([
      'firestore:backups:list',
      '--location',
      'eur3',
      '--project',
      PROJECT,
    ]);
  });
});

describe('auth-export', () => {
  it('exports the accounts to the named file', () => {
    expect(plan('auth-export', { file: 'accounts.json' }).steps[0]?.args).toEqual([
      'auth:export',
      'accounts.json',
      '--format',
      'json',
      '--project',
      PROJECT,
    ]);
    expect(plan('auth-export', { file: 'accounts.csv' }).steps[0]?.args).toContain('csv');
  });

  it.each([undefined, '', 'accounts', 'accounts.txt'])(
    'needs a .json or .csv file, not %j',
    (file) => {
      expect(() => plan('auth-export', { file })).toThrow(/Name the file/);
    },
  );
});

describe('restore-backup', () => {
  it('restores into a new database, never over the live one', () => {
    expect(
      plan('restore-backup', { backup: BACKUP, into: 'restored-1010' }).steps[0]?.args,
    ).toEqual([
      'firestore:databases:restore',
      '--database',
      'restored-1010',
      '--backup',
      BACKUP,
      '--project',
      PROJECT,
    ]);
  });

  it.each([undefined, '', '(default)', 'Restored', 'a', '-bad', 'bad-'])(
    'refuses %j as the new database',
    (into) => {
      expect(() => plan('restore-backup', { backup: BACKUP, into })).toThrow(/NEW database/);
    },
  );

  it.each([undefined, '', 'abc123', 'projects/demo-project/backups/abc'])(
    'refuses %j as the backup',
    (backup) => {
      expect(() => plan('restore-backup', { backup, into: 'restored-1' })).toThrow(
        /Name the backup/,
      );
    },
  );

  it("refuses another project's backup", () => {
    expect(() =>
      plan('restore-backup', {
        backup: 'projects/someone-else/locations/eur3/backups/abc',
        into: 'restored-1',
      }),
    ).toThrow(/belongs to project someone-else/);
  });
});

describe('restore-point-in-time', () => {
  it('copies the database as it was into a new one', () => {
    expect(
      plan('restore-point-in-time', { at: '2026-10-09T14:30:00Z', into: 'restored-0909' }).steps[0]
        ?.args,
    ).toEqual([
      'firestore:databases:clone',
      '(default)',
      'restored-0909',
      '--snapshot-time',
      '2026-10-09T14:30:00Z',
      '--project',
      PROJECT,
    ]);
  });

  it('refuses a moment in the future', () => {
    expect(() =>
      plan('restore-point-in-time', { at: '2026-10-11T00:00:00Z', into: 'restored-1' }),
    ).toThrow(/future/);
  });

  it('refuses a moment older than the 7 days it can reach, and points to restore-backup', () => {
    const tooOld = new Date(NOW - 7 * DAY_MS - 60_000).toISOString();
    expect(() => plan('restore-point-in-time', { at: tooOld, into: 'restored-1' })).toThrow(
      /restore-backup/,
    );
    const justInside = new Date(NOW - 7 * DAY_MS + 60_000).toISOString();
    expect(() =>
      plan('restore-point-in-time', { at: justInside, into: 'restored-1' }),
    ).not.toThrow();
  });

  it.each([undefined, '', 'yesterday', '2026-10-09', 'not a date'])(
    'refuses %j as the moment',
    (at) => {
      expect(() => plan('restore-point-in-time', { at, into: 'restored-1' })).toThrow(/ISO 8601/);
    },
  );

  it('refuses to restore into (default)', () => {
    expect(() =>
      plan('restore-point-in-time', { at: '2026-10-09T14:30:00Z', into: '(default)' }),
    ).toThrow(/NEW database/);
  });
});

describe('every action', () => {
  it('needs a project', () => {
    for (const action of ACTIONS) {
      expect(() => buildPlan(action, {}, NOW)).toThrow(/Name the project/);
    }
    expect(() => buildPlan('setup', { project: 'Bad Project' }, NOW)).toThrow(/Name the project/);
  });

  it('refuses an unknown action', () => {
    expect(() => plan('delete-everything')).toThrow(/Unknown action/);
  });

  it('adds the project to every command', () => {
    for (const action of ['setup', 'status']) {
      for (const step of plan(action).steps) {
        expect(step.args.slice(-2)).toEqual(['--project', PROJECT]);
      }
    }
  });
});

describe('printing and running', () => {
  it('quotes an argument so a shell reads it back as one argument', () => {
    expect(quoteArg('plain-arg_1.json', 'linux')).toBe('plain-arg_1.json');
    expect(quoteArg('(default)', 'linux')).toBe("'(default)'");
    expect(quoteArg("it's", 'linux')).toBe("'it'\\''s'");
    expect(quoteArg('(default)', 'win32')).toBe('"(default)"');
    expect(quoteArg('', 'linux')).toBe("''");
  });

  it('formats a command as a line to paste', () => {
    expect(
      formatCommand(
        { description: '', args: ['firestore:databases:update', '(default)'] },
        'linux',
      ),
    ).toBe("firebase firestore:databases:update '(default)'");
  });

  it('refuses --run without --confirm-production, and --confirm-production alone', () => {
    expect(() => checkRunAllowed(new Set(['--run']))).toThrow(/--confirm-production/);
    expect(() => checkRunAllowed(new Set(['--confirm-production']))).toThrow(/Add --run/);
    expect(() => checkRunAllowed(new Set(['--run', '--confirm-production']))).not.toThrow();
    expect(() => checkRunAllowed(new Set())).not.toThrow();
  });
});

// The commands are the Firebase CLI's own, so each flag they use must be one the installed CLI
// documents. This catches a flag the CLI renamed or never had, which is the part that cannot be run
// here (it needs a real project on the Blaze plan).
describe('the installed Firebase CLI', () => {
  const run = promisify(execFile);
  const commands = [
    plan('setup'),
    plan('status', { location: 'eur3' }),
    plan('auth-export', { file: 'a.json' }),
    plan('restore-backup', { backup: BACKUP, into: 'restored-1' }),
    plan('restore-point-in-time', { at: '2026-10-09T14:30:00Z', into: 'restored-1' }),
  ]
    .flatMap((p) => p.steps)
    .map((step) => step.args);

  // Each distinct command's help, asked for once and all at the same time (every `npx firebase` call
  // takes a few seconds).
  async function helpFor(command: string): Promise<string> {
    try {
      const result = await run('npx', ['--no-install', 'firebase', command, '--help'], {
        shell: process.platform === 'win32',
        timeout: 60_000,
      });
      return result.stdout;
    } catch (error) {
      return String((error as { stdout?: string }).stdout ?? '');
    }
  }

  it('knows every command and every flag the plans use', async () => {
    const names = [...new Set(commands.map((args) => args[0]!))];
    const helps = new Map(
      await Promise.all(names.map(async (name) => [name, await helpFor(name)] as const)),
    );

    for (const args of commands) {
      const command = args[0]!;
      const help = helps.get(command) ?? '';
      expect(help, `firebase ${command} --help printed nothing`).toContain('Usage: firebase');
      for (const flag of args.filter((arg) => arg.startsWith('--') && arg !== '--project')) {
        expect(help, `firebase ${command} has no ${flag}`).toContain(flag);
      }
    }
  }, 180_000);
});
