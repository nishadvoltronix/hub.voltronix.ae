import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const directory = new URL('../deploy/ubuntu/', import.meta.url);
const read = name => readFileSync(new URL(name, directory), 'utf8');
const root = '/var/www/hub.voltronix_ae';

function service() {
  const source = read('hub-crm.service');
  assert.match(source, /MANUAL TEMPLATE ONLY/);
  const section = source.split('[Service]')[1]?.split('[Install]')[0];
  assert.ok(section);
  return { source, section };
}

test('STATIC single Hub unit has a dedicated identity and preserves other applications', () => {
  const item = service();
  assert.match(item.section, /^User=hub-crm$/m);
  assert.match(item.section, /^Group=hub-crm$/m);
  assert.ok(item.section.includes(`WorkingDirectory=${root}/hub-current`));
  assert.doesNotMatch(item.section, /^EnvironmentFile=|^Environment=/m);
  assert.ok(item.section.includes(`InaccessiblePaths=-${root}/hub-current/server/.local-data`));
  assert.ok(item.section.includes(`InaccessiblePaths=-${root}/hub-current/server/.env`));
  for (const line of ['ProtectSystem=strict', 'ProtectHome=true', 'PrivateTmp=true', 'NoNewPrivileges=true',
    'UMask=0077', 'Restart=on-failure', 'KillSignal=SIGTERM', 'KillMode=mixed', 'TimeoutStopSec=30',
    'ProtectProc=invisible', 'CapabilityBoundingSet=', 'AmbientCapabilities=']) {
    assert.ok(item.section.split('\n').includes(line), line);
  }
  assert.ok(item.section.includes(`ReadOnlyPaths=${root}/hub-current`));
  const writable = item.section.split('\n').filter(line => line.startsWith('ReadWritePaths='));
  assert.deepEqual(writable, [`ReadWritePaths=${root}/hub-current/.next/cache`]);
  const dependencies = item.source.split('\n').filter(line => /^(?:After|Wants|Requires)=/.test(line));
  for (const line of dependencies) assert.equal(line.slice(line.indexOf('=') + 1), 'network-online.target');
  assert.doesNotMatch(item.source, /\/srv\/voltronix|voltronix-crm|mysql\.service|crm\.voltronix\.ae|hub-crm-(?:api|web)\.service/);
  assert.match(item.source, /root:hub-crm mode 0640/);
});

test('STATIC one startup command uses app-local Node and combined validation without provisioning', () => {
  const item = service();
  const commands = item.section.split('\n').filter(line => line.startsWith('Exec'));
  assert.deepEqual(commands, [
    `ExecStartPre=${root}/runtime/node/bin/node ${root}/hub-current/tools/run-hub.mjs check`,
    `ExecStart=${root}/runtime/node/bin/node ${root}/hub-current/tools/run-hub.mjs start`,
  ]);
  assert.doesNotMatch(commands.join('\n'), /\/usr\/bin\/node|\b(?:php|mysql|mysqldump|bash|sh|seed|migrate|reset)\b/);
  assert.doesNotMatch(item.section, /3001|3002/);
  assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.service')), ['hub-crm.service']);
  assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.env.example')), []);
});

test('STATIC one root environment keeps persistence disabled and aligns both internal listeners', () => {
  const source = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const pairs = source.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => {
    const split = line.indexOf('=');
    assert.ok(split > 0);
    return [line.slice(0, split), line.slice(split + 1)];
  });
  const config = Object.fromEntries(pairs);
  assert.equal(pairs.length, Object.keys(config).length, 'duplicate environment keys are refused');
  assert.equal(config.NODE_ENV, 'production');
  assert.equal(config.CRM_DATABASE_MODE, 'disabled');
  assert.equal(config.CRM_MYSQL_NETWORK_DISABLED, '1');
  assert.equal(config.ZOHO_ENABLED, 'false');
  assert.equal(config.NEXT_TELEMETRY_DISABLED, '1');
  assert.equal(config.CRM_API_INSTANCE_ID, 'hub-crm');
  assert.equal(config.APP_ORIGIN, 'https://hub.voltronix.ae');
  assert.equal(config.CRM_API_ENVIRONMENT, 'production');
  assert.equal(config.CRM_FRONTEND_BACKEND, 'express');
  assert.equal(config.CRM_EXPRESS_ORIGIN, `http://${config.CRM_API_HOST}:${config.CRM_API_PORT}`);
  assert.equal(config.CRM_WEB_HOST, '127.0.0.1');
  assert.equal(config.CRM_WEB_PORT, '3301');
  assert.equal(config.CRM_API_PORT, '3302');
  assert.ok(Object.keys(config).every(key => !/PASSWORD|TOKEN|SECRET|RUNTIME_PROFILE|RUNTIME_ENABLE/.test(key)));
});

test('STATIC Hub Nginx routes only its exact host to the explicit private web example port', () => {
  const source = read('nginx.conf.example');
  assert.match(source, /MANUAL TEMPLATE ONLY/);
  assert.match(source, /server 127\.0\.0\.1:3301;/);
  assert.deepEqual([...source.matchAll(/^\s*proxy_pass\s+([^;]+);/gm)].map(match => match[1]), ['http://hub_crm_next']);
  assert.deepEqual([...source.matchAll(/^\s*server_name\s+([^;]+);/gm)].map(match => match[1]), ['hub.voltronix.ae', 'hub.voltronix.ae']);
  assert.match(source, /^\s*proxy_set_header Host hub\.voltronix\.ae;$/m);
  assert.doesNotMatch(source, /^\s*listen .*default_server|crm\.voltronix\.ae|127\.0\.0\.1:300[12]/m);
  for (const name of ['Forwarded', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Real-IP']) {
    assert.ok(source.includes(`proxy_set_header ${name} "";`));
  }
  assert.doesNotMatch(source, /^\s*proxy_set_header (?:Origin|Cookie|Sec-Fetch-Site|X-CSRF-Token)\s/im);
  assert.match(source, /location \^~ \/api\/v1\/ \{ return 404; \}/);
  const sourceTreeRule = source.split('\n').find(line => line.includes('server|src|resources|tests|scripts|node_modules'));
  assert.ok(sourceTreeRule?.includes('backend|frontend'));
  assert.ok(sourceTreeRule.includes('{ return 404; }'));
  assert.match(source, /client_max_body_size 52m;/);
  for (const setting of ['proxy_request_buffering off;', 'proxy_buffering off;', 'proxy_cache off;', 'proxy_connect_timeout 3s;', 'proxy_read_timeout 35s;']) assert.ok(source.includes(setting));
  assert.doesNotMatch(source, /^\s*(?:fastcgi_pass|uwsgi_pass|alias|proxy_hide_header Content-Security-Policy)\b/m);
});

test('STATIC TLS and logs avoid request contents and leave HSTS for verified HTTPS acceptance', () => {
  const source = read('nginx.conf.example');
  assert.match(source, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
  assert.match(source, /ssl_certificate \/etc\/letsencrypt\/live\/hub\.voltronix\.ae\/fullchain\.pem;/);
  assert.match(source, /ssl_certificate_key \/etc\/letsencrypt\/live\/hub\.voltronix\.ae\/privkey\.pem;/);
  assert.doesNotMatch(source, /^\s*add_header Strict-Transport-Security/m);
  assert.match(source, /# add_header Strict-Transport-Security "max-age=31536000" always;/);
  assert.match(source, /frame-ancestors 'none'/);
  const logFormat = /log_format hub_crm_safe ([\s\S]*?);/.exec(source)?.[1];
  assert.ok(logFormat);
  assert.doesNotMatch(logFormat, /\$(?:request(?:\b|_(?!method\b|time\b))|args|query_string|uri|cookie|http_|remote_addr)/);
  assert.match(logFormat, /\$status/);
  assert.match(logFormat, /\$upstream_status/);
  assert.match(source, /error_log stderr crit;/);
  assert.match(source, /error records cannot use the redacted access format and can include a URI/);
});

test('STATIC guide creates only a new root environment and scopes rollback to the combined Hub unit', () => {
  const guide = readFileSync(new URL('../docs/manual-deployment-guide.md', import.meta.url), 'utf8');
  assert.match(guide, /None of these deployment commands was run/);
  for (const value of ['CRM_DATABASE_MODE=disabled', 'CRM_MYSQL_NETWORK_DISABLED=1', 'ZOHO_ENABLED=false']) assert.ok(guide.includes(value));
  assert.match(guide, /sudo install -o root -g hub-crm -m 0640 "\$release_dir\/\.env\.example" "\$release_dir\/\.env"/);
  assert.match(guide, /tar --exclude='\.\/\.env'/);
  assert.match(guide, /sudo systemctl stop hub-crm\.service/);
  assert.match(guide, /sudo nginx -t/);
  assert.doesNotMatch(guide, /hub-(?:web|api)\.env\.example|\/etc\/hub-crm\/(?:frontend|backend)\.env|hub-crm-(?:api|web)\.service/);
  assert.doesNotMatch(guide, /(?:npm run|node\s+\S+)\s+(?:mysql:migrate|db:migrate|sqlite:migrate|mysql:operator|zoho:setup)/);
  assert.doesNotMatch(guide, /systemctl\s+(?:stop|restart|disable)\s+(?:nginx|mysql|crm\b|voltronix-crm)/);
  assert.doesNotMatch(guide, /rm\s+-rf|git\s+(?:clean|reset\s+--hard)|sudo\s+(?:chown|chmod)\s+-R/);
});
