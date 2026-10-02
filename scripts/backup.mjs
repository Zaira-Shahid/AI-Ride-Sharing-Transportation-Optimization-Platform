#!/usr/bin/env node
// Backup and restore commands for the real Firebase project (Phase 14, "Backup strategy").
//
//   npm run admin:backup -- setup
//   npm run admin:backup -- status
//   npm run admin:backup -- auth-export <file.json>
//   npm run admin:backup -- restore-backup --backup <backup resource> --into <new database id>
//   npm run admin:backup -- restore-point-in-time --at <ISO time> --into <new database id>
//
// It only PRINTS the commands by default. To run them add `--run --confirm-production` (both: running
// against the real project must never happen by accident). `--project <id>` overrides the project in
// .firebaserc. docs/backup.md is the runbook: what is protected, the targets, how a restore goes and
// why it always goes into a NEW database.
//
// Every command is the Firebase CLI's own (firebase-tools), and a test checks that each flag used is
// one the installed CLI documents. NONE of this has been run against a real project: it needs the Blaze
// plan, and the project is on Spark with nothing deployed. See docs/backup.md before relying on it.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The settings the runbook decided; change them there and here together. */
export const BACKUP_SETTINGS = {
  database: '(default)',
  recurrence: 'DAILY',
  /** Short on purpose: a backup still holds an account that was deleted since (docs/backup.md). */
  retention: '14d',
  pointInTimeRecovery: 'ENABLED',
  deleteProtection: 'ENABLED',
};

/** Firestore keeps point-in-time versions for 7 days. */
export const PITR_WINDOW_DAYS = 7;

const PROJECT_ID = /^[a-z][a-z0-9-]{4,29}$/;
const DATABASE_ID = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const ACTIONS = [
  'setup',
  'status',
  'auth-export',
  'restore-backup',
  'restore-point-in-time',
];

/** The project in .firebaserc, or undefined when there is none. */
export function defaultProject(rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')) {
  try {
    const rc = JSON.parse(readFileSync(join(rootDir, '.firebaserc'), 'utf8'));
    return rc?.projects?.default;
  } catch {
    return undefined;
  }
}

function fail(message) {
  throw new Error(message);
}

/**
 * The steps of an action, as the Firebase CLI's own arguments. Throws a plain Error when an option is
 * missing or unsafe. `now` is only for tests.
 */
export function buildPlan(action, options = {}, now = Date.now()) {
  const project = options.project;
  if (!project || !PROJECT_ID.test(project)) {
    fail('Name the project: --project <id> (or set it in .firebaserc).');
  }
  const withProject = (args) => [...args, '--project', project];

  switch (action) {
    case 'setup':
      return {
        title: 'Turn on the protections for the database',
        steps: [
          {
            description:
              'Point-in-time recovery (minute-level versions for the last 7 days) and delete protection',
            args: withProject([
              'firestore:databases:update',
              BACKUP_SETTINGS.database,
              '--point-in-time-recovery',
              BACKUP_SETTINGS.pointInTimeRecovery,
              '--delete-protection',
              BACKUP_SETTINGS.deleteProtection,
            ]),
          },
          {
            description: `A ${BACKUP_SETTINGS.recurrence.toLowerCase()} backup, kept ${BACKUP_SETTINGS.retention}`,
            args: withProject([
              'firestore:backups:schedules:create',
              '--database',
              BACKUP_SETTINGS.database,
              '--recurrence',
              BACKUP_SETTINGS.recurrence,
              '--retention',
              BACKUP_SETTINGS.retention,
            ]),
          },
        ],
      };

    case 'status':
      return {
        title: 'What is protected right now',
        steps: [
          { description: 'The databases', args: withProject(['firestore:databases:list']) },
          {
            description: 'The backup schedules',
            args: withProject(['firestore:backups:schedules:list']),
          },
          {
            description: 'The backups that exist',
            args: withProject([
              'firestore:backups:list',
              ...(options.location ? ['--location', options.location] : []),
            ]),
          },
        ],
      };

    case 'auth-export': {
      const file = options.file;
      if (!file || !/\.(json|csv)$/i.test(file)) {
        fail('Name the file: auth-export <file.json>. It holds emails and password hashes.');
      }
      return {
        title: 'Export the sign-in accounts (Firestore backups do not include them)',
        steps: [
          {
            description:
              'Accounts, with their password hashes. Keep the file private and delete it after 14 days.',
            args: withProject([
              'auth:export',
              file,
              '--format',
              file.toLowerCase().endsWith('.csv') ? 'csv' : 'json',
            ]),
          },
        ],
      };
    }

    case 'restore-backup': {
      const into = checkNewDatabase(options.into);
      const backup = options.backup;
      const pattern = /^projects\/([^/]+)\/locations\/[^/]+\/backups\/[^/]+$/;
      const match = typeof backup === 'string' ? pattern.exec(backup) : null;
      if (!match) {
        fail(
          'Name the backup: --backup projects/<project>/locations/<location>/backups/<id> (see: status).',
        );
      }
      if (match[1] !== project) {
        fail(`That backup belongs to project ${match[1]}, not ${project}.`);
      }
      return {
        title: `Restore a backup into a NEW database, ${into}`,
        steps: [
          {
            description:
              'Creates the new database from the backup. The existing one is not touched.',
            args: withProject([
              'firestore:databases:restore',
              '--database',
              into,
              '--backup',
              backup,
            ]),
          },
        ],
      };
    }

    case 'restore-point-in-time': {
      const into = checkNewDatabase(options.into);
      const at = options.at;
      const time = typeof at === 'string' ? Date.parse(at) : Number.NaN;
      if (Number.isNaN(time) || !/^\d{4}-\d{2}-\d{2}T/.test(at)) {
        fail('Name the moment: --at 2026-10-02T14:30:00Z (ISO 8601).');
      }
      if (time > now) fail('That moment is in the future.');
      if (now - time > PITR_WINDOW_DAYS * DAY_MS) {
        fail(
          `Point-in-time recovery only reaches back ${PITR_WINDOW_DAYS} days. Use restore-backup for anything older.`,
        );
      }
      return {
        title: `Copy the database as it was at ${at} into a NEW database, ${into}`,
        steps: [
          {
            description:
              'Creates the new database from that moment. The existing one is not touched.',
            args: withProject([
              'firestore:databases:clone',
              BACKUP_SETTINGS.database,
              into,
              '--snapshot-time',
              at,
            ]),
          },
        ],
      };
    }

    default:
      return fail(`Unknown action "${action}". One of: ${ACTIONS.join(', ')}.`);
  }
}

/** A restore always lands in a new database, never over a live one. */
function checkNewDatabase(into) {
  if (!into || into === BACKUP_SETTINGS.database || !DATABASE_ID.test(into)) {
    fail(
      'Name the NEW database: --into <id> (lower case letters, digits and hyphens). A restore never goes into (default).',
    );
  }
  return into;
}

/** One argument, quoted so a shell reads it back as the same single argument. */
export function quoteArg(arg, platform = process.platform) {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg)) return arg;
  if (platform === 'win32') return `"${arg.replace(/"/g, '""')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The command as a line a person can paste. */
export function formatCommand(step, platform = process.platform) {
  return ['firebase', ...step.args.map((arg) => quoteArg(arg, platform))].join(' ');
}

/** Running needs both flags: nothing here may touch the real project by accident. */
export function checkRunAllowed(flags) {
  if (flags.has('--run') && !flags.has('--confirm-production')) {
    fail('--run changes the real project, so it also needs --confirm-production.');
  }
  if (flags.has('--confirm-production') && !flags.has('--run')) {
    fail('--confirm-production does nothing alone. Add --run to run the commands.');
  }
}

function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run' || arg === '--confirm-production') flags.add(arg);
    else if (arg.startsWith('--')) {
      values[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else positional.push(arg);
  }
  return { flags, values, positional };
}

function main(argv) {
  const { flags, values, positional } = parseArgs(argv);
  const [action, file] = positional;
  try {
    checkRunAllowed(flags);
    const plan = buildPlan(action, {
      project: values.project ?? defaultProject(),
      file,
      backup: values.backup,
      into: values.into,
      at: values.at,
      location: values.location,
    });
    console.log(`${plan.title}\n`);
    for (const step of plan.steps) {
      console.log(`# ${step.description}`);
      console.log(`${formatCommand(step)}\n`);
    }
    if (!flags.has('--run')) {
      console.log(
        'Printed only. Add --run --confirm-production to run it against the real project.',
      );
      return 0;
    }
    for (const step of plan.steps) {
      const quoted = step.args.map((arg) => quoteArg(arg));
      const result = spawnSync('firebase', quoted, {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
      if (result.status !== 0) {
        console.error(`\nStopped: "${formatCommand(step)}" did not succeed.`);
        return result.status ?? 1;
      }
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      '\nUsage: npm run admin:backup -- <setup|status|auth-export <file>|restore-backup|restore-point-in-time> [--project <id>] [--run --confirm-production]',
    );
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
