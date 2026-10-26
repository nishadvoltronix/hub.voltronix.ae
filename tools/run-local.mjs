import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = resolve(projectRoot, 'server');
const nextCli = resolve(projectRoot, 'node_modules/next/dist/bin/next');
const self = fileURLToPath(import.meta.url);

export function assertLocalStartupEnvironment(command, environment) {
  if (['dev', 'start', 'web:dev', 'web:start', 'api:foundation', 'api:foundation-dev'].includes(command)
    && (environment.CRM_DATABASE_MODE !== undefined || environment.NODE_ENV === 'production'
      || environment.CRM_API_ENVIRONMENT === 'production' || /^https:/i.test(environment.APP_ORIGIN?.trim() ?? ''))) {
    throw Error('Hub production settings require tools/run-hub.mjs; local startup cannot discard them.');
  }
}

export function localPorts(args) {
  const result = { web: 3001, api: 3002 };
  const seen = new Set();
  for (const argument of args) {
    const match = /^--(web|api)-port=([1-9][0-9]{3,4})$/.exec(argument);
    if (!match || seen.has(match[1])) throw Error('Invalid local port option.');
    const port = Number(match[2]);
    if (port < 1024 || port > 65535) throw Error('Invalid local port.');
    seen.add(match[1]); result[match[1]] = port;
  }
  if (result.web === result.api) throw Error('Local web and API ports must differ.');
  return result;
}

/** Default local startup never inherits integration/database selection or reads server/.env. */
export function localEnvironment(ambient, ports, productionWeb = false) {
  const environment = Object.fromEntries(Object.entries(ambient).filter(([name]) =>
    !/^(?:CRM_|ZOHO_|NEXT_PUBLIC_|APP_ORIGIN$|NODE_OPTIONS$)/i.test(name)));
  return { ...environment, NODE_ENV: productionWeb ? 'production' : 'development', NEXT_TELEMETRY_DISABLED: '1',
    CRM_FRONTEND_BACKEND: 'express', CRM_EXPRESS_ORIGIN: `http://127.0.0.1:${ports.api}`,
    APP_ORIGIN: `http://127.0.0.1:${ports.web}`, CRM_MYSQL_NETWORK_DISABLED: '1',
    CRM_API_ENVIRONMENT: 'development', CRM_API_HOST: '127.0.0.1', CRM_API_PORT: String(ports.api),
    ZOHO_ENABLED: 'false' };
}

export function serverCommand(command, args) {
  const tests = {
    'test:server': ['--import', 'tsx', '--test', 'tests/*.test.ts'],
    'test:demo': ['--import', 'tsx', '--test', 'demo-sqlite/*.test.ts'],
    'test:mysql-auth:offline': ['--import', 'tsx', '--test', ...['guards', 'runner', 'runner-metadata', 'observer', 'live-cases', 'browser-harness'].map(suffix => `tests/mysql-auth-${suffix === 'guards' ? 'harness-guards' : suffix === 'browser-harness' ? 'browser-harness' : suffix}.test.ts`)],
  };
  if (tests[command]) {
    if (args.length) throw Error('Test command takes no additional arguments.');
    return { args: tests[command], cwd: serverRoot };
  }
  if (command !== 'server:script' && command !== 'server:built') return null;
  const [entry, ...forwarded] = args;
  if (!entry || !/^(?:scripts|demo-sqlite|dist)\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:ts|js)$/.test(entry)
    || (command === 'server:built' ? !entry.startsWith('dist/') || !entry.endsWith('.js') : entry.startsWith('dist/') || !entry.endsWith('.ts'))
    || !existsSync(resolve(serverRoot, entry))) throw Error('Unknown explicit server command.');
  return { args: [...(command === 'server:script' ? ['--import', 'tsx'] : []), entry, ...forwarded], cwd: serverRoot };
}

async function runChildren(plans) {
  const children = new Set();
  let shuttingDown = false;
  let outcome = 0;
  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
      if (process.platform === 'win32') {
        // Only the exact process tree started by this launcher; no name/port-wide cleanup.
        await new Promise(done => {
          const cleanup = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          cleanup.once('error', done); cleanup.once('close', done);
        });
      } else child.kill('SIGTERM');
    }
  };
  const interrupt = () => { void stop(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    await Promise.all(plans.map(plan => new Promise(done => {
      const child = spawn(process.execPath, plan.args, { cwd: plan.cwd ?? projectRoot, env: plan.env ?? process.env, stdio: 'inherit', windowsHide: true });
      children.add(child);
      child.once('error', () => { outcome = 1; children.delete(child); void stop(); done(); });
      child.once('close', code => {
        children.delete(child);
        if (!shuttingDown && code !== 0) outcome = typeof code === 'number' ? code : 1;
        void stop(); done();
      });
    })));
  } finally {
    await stop(); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  }
  return outcome;
}

async function foundation(command, ports) {
  const source = command === 'api:foundation-dev';
  const module = await import(new URL(source ? '../server/src/server.ts' : '../server/dist/server.js', import.meta.url));
  const instance = await module.startServer({ environment: 'development', host: '127.0.0.1', port: ports.api,
    appOrigin: `http://127.0.0.1:${ports.web}` });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void instance.stop().catch(() => { process.exitCode = 1; });
  };
  process.on('SIGINT', close); process.on('SIGTERM', close);
  instance.server.once('close', () => {
    process.off('SIGINT', close); process.off('SIGTERM', close);
    if (instance.failed) process.exitCode = 1;
  });
  console.log(`Express listening at http://127.0.0.1:${ports.api}. Database/integrations are NOT connected; authentication and CRM data readiness remain unavailable.`);
}

export async function main(command, args) {
  assertLocalStartupEnvironment(command, process.env);
  const explicit = serverCommand(command, args);
  if (explicit) return runChildren([explicit]);
  const ports = localPorts(args);
  const portArgs = [`--web-port=${ports.web}`, `--api-port=${ports.api}`];
  if (command === 'api:foundation' || command === 'api:foundation-dev') { await foundation(command, ports); return 0; }
  if (!['dev', 'start', 'web:dev', 'web:start'].includes(command)) throw Error('Unknown local command.');
  const production = command === 'start' || command === 'web:start';
  if (production && !existsSync(resolve(projectRoot, '.next/BUILD_ID'))) throw Error('Run npm run build before starting the production build locally.');
  if (command === 'start' && !existsSync(resolve(serverRoot, 'dist/server.js'))) throw Error('Build the Express API first.');
  const web = { args: [nextCli, production ? 'start' : 'dev', '--hostname', '127.0.0.1', '--port', String(ports.web)],
    env: localEnvironment(process.env, ports, production) };
  if (command.startsWith('web:')) return runChildren([web]);
  console.log('Starting the real Next.js + Express application with no database, seed, mock account, or Zoho connection.');
  console.log(`Web: http://127.0.0.1:${ports.web}. Protected workflows require a separately configured persistence runtime.`);
  const api = { args: [...(production ? [] : ['--import', 'tsx']), self, production ? 'api:foundation' : 'api:foundation-dev', ...portArgs],
    env: localEnvironment(process.env, ports) };
  return runChildren([api, web]);
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  main(process.argv[2], process.argv.slice(3)).then(code => { if (code) process.exitCode = code; }).catch(() => {
    console.error('Local command failed. Check the requested command, ports, dependencies and build. For Hub production settings use tools/run-hub.mjs. No automatic database setup or unrelated process cleanup was attempted.');
    process.exitCode = 1;
  });
}
