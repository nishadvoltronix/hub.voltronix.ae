import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const backend = fileURLToPath(new URL("../", import.meta.url));
const basePreload = `import fs from 'node:fs';import cp from 'node:child_process';import net from 'node:net';
  import {syncBuiltinESMExports} from 'node:module';import {EventEmitter} from 'node:events';
  const calls={privateFiles:0,network:0,spawn:0,kill:0};
  for(const key of ['openSync','readFileSync','lstatSync','statSync','existsSync','readdirSync','realpathSync']){
    const original=fs[key];fs[key]=function(path,...args){const value=String(path);
      if(value.includes('.local-data')||/(?:^|[\\\\/])\\.env(?:$|\\.)/.test(value)){calls.privateFiles++;throw new Error('Forbidden synthetic private access');}
      return original.call(this,path,...args);};}
  globalThis.fetch=async()=>{calls.network++;throw new Error('Forbidden synthetic network');};
  net.createServer=()=>{calls.network++;throw new Error('Forbidden synthetic listener');};
  cp.spawn=()=>{calls.spawn++;throw new Error('Forbidden synthetic child');};
  process.once('exit',()=>process.stdout.write(JSON.stringify({guard:calls})+'\\n'));
`;
function run(args: string[], extra: NodeJS.ProcessEnv = {}, preload = "", wrapped = false) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemDrive"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { CRM_MYSQL_NETWORK_DISABLED: "1", ZOHO_NETWORK_DISABLED: "1", TSX_DISABLE_CACHE: "1", ...extra });
  if (!wrapped) env.CRM_LOCAL_ZOHO_IMPORT = "isolated-inbound";
  return spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(basePreload + preload + "\nsyncBuiltinESMExports();")}`,
    "--import", "tsx", "demo-sqlite/zoho-import.ts", ...args], { cwd: backend, env, encoding: "utf8", windowsHide: true, timeout: 20_000 });
}
function guard(result: ReturnType<typeof run>) {
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  const lines = result.stdout.trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1)!) as { guard: { privateFiles: number; network: number; spawn: number; kill: number } };
}
function preflightRefusal(result: ReturnType<typeof run>) {
  assert.equal(result.status, 1); assert.deepEqual(guard(result), { guard: { privateFiles: 0, network: 0, spawn: 0, kill: 0 } });
  const receipt = JSON.parse(result.stderr.trim()) as { status: string; phase: string; code: string };
  assert.equal(receipt.status, "ZOHO_LOCAL_IMPORT_STOPPED"); assert.equal(receipt.phase, "preflight");
  assert.equal(receipt.code, "LOCAL_PREFLIGHT_FAILED");
}

test("Zoho local import CLI invalid arguments refuse before private files, database, network or child calls", () => {
  for (const args of [[], ["sync"], ["--help"], ["preview", "unexpected"], ["apply"], ["apply", "not-a-uuid"],
    ["apply", "../escape"], ["apply", "00000000-0000-4000-8000-000000000000", "extra"]]) preflightRefusal(run(args));
});

test("Zoho local import direct child debug settings refuse before reading any private configuration", () => {
  for (const key of ["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "PWDEBUG"]) {
    preflightRefusal(run(["preview"], { [key]: "synthetic-debug-marker" }));
  }
});

test("Zoho local import explicit offline preview refuses before local DB or grant access", () => {
  preflightRefusal(run(["preview"]));
});

test("Zoho local import wrapper creates only its sanitized hidden child and preserves explicit offline disable", () => {
  const preload = `cp.spawn=(exe,args,options)=>{calls.spawn++;
    if(exe!==process.execPath||options.shell||!options.windowsHide||options.stdio!=='inherit')throw new Error('Invalid child boundary');
    if(options.env.CRM_LOCAL_ZOHO_IMPORT!=='isolated-inbound'||options.env.ZOHO_NETWORK_DISABLED!=='1'||options.env.CRM_MYSQL_NETWORK_DISABLED!=='1')throw new Error('Lost offline boundary');
    for(const key of ['ZOHO_CLIENT_SECRET','CRM_MYSQL_PASSWORD','DEBUG','NODE_DEBUG','NODE_OPTIONS'])if(key in options.env)throw new Error('Inherited private/debug setting');
    if(!args.includes('preview')||args[0]!=='--import')throw new Error('Lost explicit command');
    const child=new EventEmitter();process.nextTick(()=>child.emit('exit',0));return child;};`;
  const result = run(["preview"], { ZOHO_CLIENT_SECRET: "synthetic-private-secret", CRM_MYSQL_PASSWORD: "synthetic-private-password", DEBUG: "synthetic-debug" }, preload, true);
  assert.equal(result.status, 0); assert.equal(result.stderr, "");
  assert.deepEqual(guard(result), { guard: { privateFiles: 0, network: 0, spawn: 1, kill: 0 } });
});

test("Zoho local import wrapper forwards interruption only to its owned child", () => {
  const preload = `cp.spawn=()=>{calls.spawn++;const child=new EventEmitter();child.exitCode=null;child.signalCode=null;
    child.kill=signal=>{if(signal!=='SIGTERM')throw new Error('Unexpected signal');calls.kill++;process.nextTick(()=>child.emit('exit',null,signal));return true;};
    process.nextTick(()=>process.emit('SIGTERM'));return child;};`;
  const result = run(["preview"], {}, preload, true);
  assert.equal(result.status, 1); assert.equal(result.stderr, "");
  assert.deepEqual(guard(result), { guard: { privateFiles: 0, network: 0, spawn: 1, kill: 1 } });
});
