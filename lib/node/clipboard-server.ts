#!/usr/bin/env node
// Forward clipboard access over an HTTP socket.
// SPDX-License-Identifier: MIT

import * as childProcess from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as stream from 'node:stream';
import { pipeline as pipelineCb } from 'node:stream';
import { promisify } from 'node:util';

type Subcommand = 'start' | 'stop' | 'restart' | 'server';

interface Options {
  pidFile: string;
  socket: string;
  enablePaste: boolean;
  notify: boolean;
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const pipeline = promisify(pipelineCb);

// set umask for files to be 0600
process.umask(0o0177);

function waitForChildProcess(subprocess: childProcess.ChildProcess, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    subprocess.on('error', reject);
    subprocess.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`));
    });
  });
}

async function setClipboard(req: http.IncomingMessage): Promise<void> {
  const subprocess = childProcess.spawn('pbcopy', {
    stdio: ['pipe', 'ignore', process.stderr],
  });
  const childClosed = waitForChildProcess(subprocess, 'pbcopy');

  let size = 0;
  const sizeLimiter = new stream.Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        callback(new Error('Request body too large'));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    // echo 123 | curl -i 127.0.0.1:9999/clipboard --data-binary @-
    await pipeline(req, sizeLimiter, subprocess.stdin);
    await childClosed;
  } catch (err) {
    try {
      subprocess.kill();
    } catch {}
    try {
      await childClosed;
    } catch {}
    throw err;
  }
}

async function getClipboard(res: http.ServerResponse): Promise<void> {
  const subprocess = childProcess.spawn('pbpaste', {
    stdio: ['ignore', 'pipe', process.stderr],
  });
  const childClosed = waitForChildProcess(subprocess, 'pbpaste');

  try {
    // curl -i 127.0.0.1:9999/clipboard
    await Promise.all([pipeline(subprocess.stdout, res), childClosed]);
  } catch (err) {
    try {
      subprocess.kill();
    } catch {}
    try {
      await childClosed;
    } catch {}
    throw err;
  }
}

function showNotification(message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const subprocess = childProcess.spawn('quick-toast', ['Clipboard Server', message], {
      stdio: 'ignore',
    });

    subprocess.on('exit', () => resolve());
    subprocess.on('error', reject);
  });
}

async function createBaseDir(filepath: string): Promise<void> {
  const dirname = path.dirname(filepath);
  try {
    await fs.stat(dirname);
    return;
  } catch {}
  const mask = process.umask(0o0077);
  await fs.mkdir(dirname, { recursive: true, mode: 0o700 });
  process.umask(mask);
}

async function getPidFromPidFile(pidFile: string): Promise<number> {
  try {
    const pid = parseInt((await fs.readFile(pidFile, 'utf8')).trim(), 10);
    if (isNaN(pid) || pid < 1) {
      return -1;
    }
    return pid;
  } catch {
    // pidfile doesn't exist
    return -1;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function socketIsFile(socket: string): boolean {
  return /^\/.+\.sock/.test(socket);
}

function isValidSocket(socket: string): boolean {
  return socketIsFile(socket) || /^\d+$/.test(socket);
}

function isListening(socket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = { path: '/ping' };
    if (socketIsFile(socket)) {
      options.socketPath = socket;
    } else {
      options.host = 'localhost';
      options.port = parseInt(socket, 10);
    }
    const req = http.get(options, (res) => {
      if (res.statusCode === 200) {
        resolve();
      } else {
        const e = new Error('HTTP Error');
        e.cause = res;
        reject(e);
      }
    });
    req.on('error', reject);
    req.end();
  });
}

async function start(opts: Options): Promise<void> {
  const { pidFile, socket, enablePaste, notify } = opts;
  // check if pid file exists
  const existingPid = await getPidFromPidFile(pidFile);
  // check if already running
  if (existingPid > 0 && isRunning(existingPid)) {
    // process already running
    return;
  }

  // clean up previous socket file
  if (socketIsFile(socket)) {
    try {
      await fs.unlink(socket);
    } catch {}
  }

  const args = ['--pidfile', pidFile, '--socket', socket];
  if (enablePaste) {
    args.push('--enable-paste');
  }
  if (notify) {
    args.push('--notify');
  }

  // spawn detached process
  const subprocess = childProcess.spawn(process.argv[0], [process.argv[1], 'server', ...args], {
    detached: true,
    stdio: 'ignore',
  });

  // detach process fully
  subprocess.unref();

  // wait for socket ready
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      await isListening(socket);
      ready = true;
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 20));
  }

  if (!ready) {
    // kill process and exit
    try {
      subprocess.kill();
    } catch {}
    throw new Error('Unable to start server');
  }

  // write child pid to file
  await createBaseDir(pidFile);
  await fs.writeFile(pidFile, String(subprocess.pid), 'utf8');
}

async function stop(opts: Options): Promise<void> {
  const { pidFile } = opts;
  // check if pid file exists
  const existingPid = await getPidFromPidFile(pidFile);
  // check if already running
  if (existingPid <= 0 || !isRunning(existingPid)) {
    // process not running, clean up
    try {
      await fs.unlink(pidFile);
    } catch {}
    return;
  }
  // kill child process
  process.kill(existingPid, 'SIGHUP');
  // clean up pid file
  try {
    await fs.unlink(pidFile);
  } catch {}
}

async function server(opts: Options): Promise<void> {
  const { socket, enablePaste, notify } = opts;
  if (socketIsFile(socket)) {
    await createBaseDir(socket);
    // cleanup
    process.on('SIGHUP', () => {
      try {
        fsSync.unlinkSync(socket);
      } catch {}
      process.exit();
    });
  }

  const srv = http.createServer({});
  srv.on('error', (err) => console.error(err));
  // API is unauthenticated; bind TCP to loopback and require an SSH -R tunnel for remote access.
  srv.on('request', async (req, res) => {
    try {
      switch (req.url) {
        case '/clipboard':
          if (req.method === 'GET') {
            if (notify) {
              showNotification('Clipboard read').catch(() => {
                // empty
              });
            }
            res.setHeader('content-type', 'application/octet-stream');
            if (enablePaste) {
              await getClipboard(res);
            } else {
              res.statusMessage = 'Forbidden';
              res.statusCode = 403;
              res.end();
            }
          } else if (req.method === 'POST') {
            if (notify) {
              showNotification('Clipboard written').catch(() => {
                // empty
              });
            }
            res.setHeader('content-type', 'text/plain');
            res.statusCode = 200;
            await setClipboard(req);
            res.end();
          } else {
            throw new Error('Unknown request method');
          }
          break;
        case '/ping':
          res.setHeader('content-type', 'text/plain');
          res.statusCode = 200;
          res.end('ok\n');
          break;
        default:
          res.statusMessage = 'Not Found';
          res.statusCode = 404;
          res.end();
          break;
      }
    } catch {
      res.statusMessage = 'Forbidden';
      res.statusCode = 500;
      res.end();
    }
  });
  const listenArgs: unknown[] = socketIsFile(socket) ? [socket] : [{ port: parseInt(socket, 10), host: '127.0.0.1' }];
  (srv.listen as (...a: unknown[]) => http.Server)(...listenArgs, () => console.log('ready'));
}

function help(): string {
  return `
Usage: clipboard-server COMMAND [OPTION]...
Forward clipboard access over an HTTP socket.

Commands:
  start                      run the server in the background
  stop                       stop the server if it is running
  restart                    restart the server
  server                     start the server in the foreground

Mandatory arguments to long options are also mandatory for the
corresponding short options.

Options:
  -e, --enable-paste         allow remote clipboard reads; disabled by default
  -n, --notify               show a notification when the clipboard is accessed
  -p, --pidfile FILE         write the background server PID to FILE
                               default: ~/.config/clipboard-server/clipboard-server.pid
  -s, --socket FILE|PORT     listen on FILE or TCP PORT (TCP binds to 127.0.0.1
                               only; tunnel via SSH -R for remote access)
                               default: ~/.config/clipboard-server/clipboard-server.sock
  -h, --help                 display this help and exit

Examples:
  clipboard-server start --enable-paste
  clipboard-server server --socket 29009

Using over SSH

  Via binding a socket on the remote host
  ssh -o StreamLocalBindMask=0177 -R /tmp/clipboard-server.sock:$HOME/.config/clipboard-server/clipboard-server.sock user@HOST
  If the remote host doesn't have StreamLocalBindUnlink=yes in sshd_config, it will not clean up the socket file, in
  this case use a port instead

  Via binding a port on the remote host
  ssh -R 127.0.0.1:29009:$HOME/.config/clipboard-server/clipboard-server.sock user@HOST

  This server is integrated with the dotfiles provided pbcopy/pbpaste commands when used over ssh, additionally a env
  var must be exported on the remote host to make use of this server:

  The dotfiles pbcopy/pbpaste wrappers pick up the remote server when one
  of these is exported on the remote host:
    export CLIPBOARD_SERVER_PORT=29009      # the remote bound port
    export CLIPBOARD_SERVER_SOCK=/tmp/clipboard-server.sock  # or a socket

Testing

  To read from the clipboard
  curl -sSLi --unix-socket ~/.config/clipboard-server/clipboard-server.sock -X GET http://localhost/clipboard

  To write to the clipboard
  date | curl -i -sSL --unix-socket ~/.config/clipboard-server/clipboard-server.sock http://localhost/clipboard --data-binary @-
`.trim();
}

async function main(argv: string[]): Promise<void> {
  const [, , subcommand, ...args] = argv;
  const userInfo = os.userInfo();
  let showHelp = subcommand === '--help' || subcommand === '-h';
  const opts: Options = {
    pidFile: `${userInfo.homedir}/.config/clipboard-server/clipboard-server.pid`,
    socket: `${userInfo.homedir}/.config/clipboard-server/clipboard-server.sock`,
    enablePaste: false,
    notify: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-e':
      case '--enable-paste':
        opts.enablePaste = true;
        break;
      case '-n':
      case '--notify':
        opts.notify = true;
        break;
      case '-p':
      case '--pidfile':
        opts.pidFile = args[++i]!;
        break;
      case '--socket':
      case '-s':
        opts.socket = args[++i]!;
        if (!isValidSocket(opts.socket)) {
          throw new Error('socket must be a file or a port.');
        }
        break;
      case '-h':
      case '--help':
        showHelp = true;
        break;
    }
  }

  if (showHelp) {
    console.log(help());
    return;
  }

  switch (subcommand as Subcommand | undefined) {
    case 'start':
      await start(opts);
      break;
    case 'stop':
      await stop(opts);
      break;
    case 'restart':
      try {
        await stop(opts);
      } catch {}
      await start(opts);
      break;
    case 'server':
      await server(opts);
      break;
    default:
      throw new Error('Unknown command');
  }
}

main(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
