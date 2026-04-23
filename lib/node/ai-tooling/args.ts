// Shared CLI argument parser for session-usage scripts.
// SPDX-License-Identifier: MIT

export interface ParsedArgs {
  command: 'list' | 'session';
  sessionId: string;
  // projectArg means different things per tool: claude treats it as a slug,
  // codex/opencode treat it as a directory path. Scripts interpret it.
  projectArg: string;
  userDir: string;
  json: boolean;
  sort: string;
  limit: number;
  noColor: boolean;
}

export interface ParseArgsOptions {
  help: string;
  // Label used in error messages, e.g. "<uuid>" or "<id>".
  sessionArgLabel?: string;
}

export function parseArgs(argv: string[], opts: ParseArgsOptions): ParsedArgs {
  const sessionArgLabel = opts.sessionArgLabel ?? '<id>';
  const args: ParsedArgs = {
    command: 'list',
    sessionId: '',
    projectArg: '',
    userDir: '',
    json: false,
    sort: 'date',
    limit: 0,
    noColor: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        console.log(opts.help);
        process.exit(0);
      case '--json':
        args.json = true;
        break;
      case '--no-color':
        args.noColor = true;
        break;
      case '--project':
      case '-p':
        i++;
        args.projectArg = argv[i] ?? '';
        break;
      case '--user-dir':
      case '-u':
        i++;
        args.userDir = argv[i] ?? '';
        break;
      case '--sort':
        i++;
        args.sort = argv[i] ?? 'date';
        break;
      case '--limit':
      case '-n':
        i++;
        args.limit = parseInt(argv[i] ?? '0', 10);
        break;
      default:
        if (arg.startsWith('--project=')) {
          args.projectArg = arg.slice('--project='.length);
        } else if (arg.startsWith('--user-dir=')) {
          args.userDir = arg.slice('--user-dir='.length);
        } else if (arg.startsWith('--sort=')) {
          args.sort = arg.slice('--sort='.length);
        } else if (arg.startsWith('--limit=')) {
          args.limit = parseInt(arg.slice('--limit='.length), 10);
        } else if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        } else if (arg === 'session') {
          args.command = 'session';
          i++;
          args.sessionId = argv[i] ?? '';
          if (!args.sessionId) {
            console.error(`session command requires a ${sessionArgLabel} argument`);
            process.exit(1);
          }
        } else if (arg === 'list') {
          args.command = 'list';
        } else {
          console.error(`Unknown argument: ${arg}`);
          process.exit(1);
        }
        break;
    }
    i++;
  }

  return args;
}
