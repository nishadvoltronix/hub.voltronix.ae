# Manual Hub CRM deployment and rollback

**2026-10-20 superseding scope update:** The owner confirmed that the database identity configured in the private root `.env` belongs to the existing production instance on `webserver01`. Preserve that configuration and database. Current work remains local preparation only; the owner will deploy manually. No server connection, deployment, routing change or production service action is authorized by this local task. The commands below remain future operator instructions.

`127.0.0.1:3306` addresses the machine running Hub. On the Windows PC it now reaches a separately provisioned local MySQL 8.4.11 engine with a different identity; that engine has not been selected as Hub's database. On `webserver01` it addresses that server's own MySQL listener. Earlier Windows connection failures do not prove the production database is absent. Before activation, the host operator must verify the existing target's version, configured UUID, native v1–v5 schema, runtime grants, administrator and actor bindings using read-only checks. Missing or incompatible components require a separate reviewed change; do not provision a replacement schema, bootstrap an administrator or run migrations as part of deployment.

**Earlier 2026-10-20 routing observation:** The public hostname answered with API service `bills-crm-api`, while this release requires `hub-crm-api`. The local-only follow-up did not repeat that probe. Anonymous health and readiness from that service do not accept this Hub release. Bring up and verify the new Hub API and web listeners on their own loopback ports before any separately approved Nginx routing change; the Hub web identity check will reject the existing API. The owner will perform the host deployment manually.

**Historical scope, 2026-10-19 — superseded:** The owner previously selected a new empty native Hub database. The [native operator procedure](mysql-production-operator-guide.md) and [first-administrator instructions](backend-production-environment.md#create-the-first-native-administrator-explicitly) document that earlier path and apply only to a separately approved fresh target. They are not instructions to replace or initialize the now-selected existing production database. The outbound Zoho profile and inbound importer/poller remain supported; use the actual verified existing local administrator ID as sync principal, never a guessed ID. The disabled template remains useful for a preliminary UI/liveness preview and is not the final working-CRM configuration.

**Future owner-operated host instructions only. None of these deployment commands was run.** Local isolated MySQL and separately authorized Zoho tests are recorded in the environment guide; they do not establish the deployment host's state. Existing `crm.voltronix.ae`, PHP source, historical database, uploads, sessions and backups remain unchanged. Use the [current release checklist](final-release-checklist.md) for existing-target compatibility and host acceptance.

The proposed target layout uses one project directory, one root `.env`, one dependency installation and one start command. **The Hub server path, hostname, DNS and certificate have not been verified.** These names are configuration templates, not evidence that server resources already exist:

```text
/var/www/hub.voltronix_ae/          proposed path: verify first, preserve any contents
  runtime/node/                     NEW app-local, verified Node 24.x
  hub-releases/<release-id>/       NEW immutable release; never overlay
    package.json / package-lock.json
    .env.example                    reviewed safe template
    .env                            NEW root:hub-crm 0640 configuration
    src/ server/ public/ shared/     one application tree
  hub-current -> hub-releases/<release-id>  NEW Hub-only symlink
```

The template uses Nginx `hub.voltronix.ae` -> web `127.0.0.1:3301` -> API `127.0.0.1:3302`. Earlier host notes reported ports 3001/3002 occupied; all ports require a fresh host check. The current local root configuration uses web port 3090 and API port 3002. If those values are retained on the host, set the dedicated Nginx upstream to `127.0.0.1:3090` and verify both listeners first. Substitute the chosen ports in every loopback command below. No API or database listener is exposed publicly. One `hub-crm` service account and one `hub-crm.service` run the combined launcher. It owns both processes and verifies API identity and selected dependencies before starting Next. There is no second dependency installation or separate backend project to deploy.

## 1. Read-only preflight and stop conditions

The operator first confirms the actual host, maintenance scope, backup custodian and available resources. These are future manual commands, not a request for this agent to connect:

```bash
cat /etc/os-release
uname -m
id
free -h
df -hT /var/www /var/backups
df -i /var/www
ss -ltnp
systemctl --type=service --state=running
systemctl --version
nginx -v
sudo nginx -t
sudo stat /var/www/hub.voltronix_ae
sudo find /var/www/hub.voltronix_ae -maxdepth 1 -printf '%M %u:%g %f\n'
getent passwd hub-crm
getent group hub-crm
systemctl list-unit-files 'hub-crm*'
```

Record results privately. Confirm 3301 and 3302 have no listener and are reserved for Hub; do not terminate any owner of a conflicting port. Confirm that `runtime`, `hub-releases`, `hub-current`, the proposed user/group/service and the new Hub Nginx filename are absent, including dangling symlinks. If any exists, stop and review its owner and purpose; never reuse or overwrite it blindly. Any pre-existing application units need a separately reviewed transition; this guide does not remove or restart them. If the target is absent, record that fact and obtain approval to create a new empty Hub directory before continuing; do not rename or copy another application's live directory. If it is a symlink, mounted application volume or a different directory than expected, obtain a reviewed layout first. Later installation commands require an operator-verified ordinary target directory.

Inspect the existing Hub/CRM virtual hosts privately before choosing a separate filename. A second `server_name hub.voltronix.ae` is a conflict even when `nginx -t` exits zero with a warning. Existing `crm.voltronix.ae` configuration, global Nginx files, system-wide Node, firewall rules and other application processes are outside this change. Record baseline service state and approved existing health evidence; do not use business mutations as probes.

## 2. Backups and preservation evidence before changes

Have the existing backup owner verify the current CRM database backup and an isolated recovery receipt through their established procedure. This runbook issues **no database command**, opens no connection and supplies no dump/restore/migration command. A directory tarball is not proof of a consistent live database backup.

Choose and record a new release identifier whether the Hub target exists or is absent:

```bash
set -euo pipefail
release_id=hub-foundation-20261017-01   # choose a NEW recorded identifier
```

If the Hub target already exists, create a private backup before adding any child paths. If it is absent, record the absence instead of backing up an unrelated application path. Use an approved backup filesystem with adequate space, outside `/var/www/hub.voltronix_ae`. The following example applies only to an existing, verified Hub target and a new backup destination:

```bash
backup_dir=/var/backups/hub-crm-preparation/$release_id
test ! -e "$backup_dir"
test ! -L "$backup_dir"
sudo install -d -m 0700 "$backup_dir"
sudo tar --acls --xattrs --one-file-system -cpf "$backup_dir/hub-before.tar" \
  -C /var/www hub.voltronix_ae
sudo tar --compare --acls --xattrs -f "$backup_dir/hub-before.tar" -C /var/www
sudo sha256sum "$backup_dir/hub-before.tar"
```

Review warnings/exit codes; changing files or excluded submounts require the backup owner's consistent-copy procedure before continuing. Store the archive hash, file permissions, existing symlink targets and existing service/configuration baseline privately. Verify recoverability on an isolated location, never by restoring over live files. Do not include the backup or its contents in a release, Git commit or chat. Retain any failure evidence.

## 3. Prepare, verify and transfer a fresh source candidate

Run local checks from the separate preparation checkout; do not package the retained original workspace. The allowlisted exporter includes required source/configuration and selected approved assets, omits real environments, databases, uploads, sessions, private PDF marks, Git history, dependencies and build outputs. Read `hub-crm-source/FILE-MANIFEST.json` for exact exclusions. An old candidate does not cover new code changes. The exporter verifies the exact ZIP contents as well as the source directory; do not repackage its result or transfer its tests/source checkout instead.

Local PowerShell commands from `G:\hub.voltronix.ae` after reviewing the source changes and current [clean-project verification record](clean-project-verification.md):

```powershell
$candidate = (node tools/prepare-hub-package.mjs --create | ConvertFrom-Json).output
if ($LASTEXITCODE -ne 0 -or -not $candidate) { throw 'Package creation failed' }
node tools/prepare-hub-package.mjs --verify $candidate
if ($LASTEXITCODE -ne 0) { throw 'Package verification failed' }
$archive = Join-Path $candidate 'hub-crm-source.zip'
tar -tf $archive
if ($LASTEXITCODE -ne 0) { throw 'Archive inspection failed' }
Get-FileHash -LiteralPath $archive -Algorithm SHA256
```

Review the archive list against the verified manifest and the checksum via an independently trusted channel. Transfer **only the archive and checksum** to an operator-created NEW private incoming directory; never copy the working tree, `.git`, node_modules, existing production env or retained private files. Replace the example SSH alias and incoming path only after explicit deployment approval:

```powershell
scp $archive "$archive.sha256" hub-approved-host:/approved/new-private-incoming/
```

That command is documented only and was not executed. The incoming directory must be owned by the approved build operator, mode 0700, outside public document roots. Record the actual archive basename and checksum.

## 4. App-local Node and Linux build

Provision a reviewed official Node **24.x** distribution for the host architecture into the NEW `/var/www/hub.voltronix_ae/runtime/node` path. Verify its release checksum/signature under the operator's approved provenance process. Do not run a remote installer script, replace `/usr/bin/node`, change shell profiles, change global package links or upgrade another app. If the runtime path exists, stop. Version-selection, download and certificate authenticity are manual prerequisites; no network installation occurred during this task.

```bash
node_bin=/var/www/hub.voltronix_ae/runtime/node/bin/node
npm_cli=/var/www/hub.voltronix_ae/runtime/node/lib/node_modules/npm/bin/npm-cli.js
"$node_bin" --version
"$node_bin" "$npm_cli" --version
```

Verify Node reports 24.x, then work as a nonroot build operator in a new private directory on the same Linux architecture as the target. Substitute the recorded source archive basename:

```bash
set -euo pipefail
incoming=/approved/new-private-incoming
archive_name=hub-crm-source.zip
cd "$incoming"
sha256sum -c "$archive_name.sha256"
unzip -Z1 "$archive_name"   # verify only the hub-crm-source/ root
build_root=$(mktemp -d /tmp/hub-build.XXXXXXXX)
chmod 0700 "$build_root"
unzip -q -n "$incoming/$archive_name" -d "$build_root"
source_root=$build_root/hub-crm-source
cd "$source_root"
```

Continue the following sections in the same dedicated operator shell so the recorded paths remain available; use `set -euo pipefail` and stop on every failure. The independently reviewed, checksummed archive must contain regular files/directories only. After extraction, verify each source hash before installing dependencies:

```bash
"$node_bin" --input-type=module -e '
import fs from "node:fs";
import crypto from "node:crypto";
const manifest = JSON.parse(fs.readFileSync("FILE-MANIFEST.json", "utf8"));
for (const f of manifest.files) {
  if (typeof f.path !== "string" || /[\\:\x00-\x1f\x7f]/.test(f.path)
    || f.path.split("/").some(p => !p || p === "." || p === "..")) throw Error("Invalid manifest path");
  const parts = f.path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const parent = fs.lstatSync(parts.slice(0, i).join("/"));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error("Unexpected parent directory");
  }
  const s = fs.lstatSync(f.path);
  if (!s.isFile() || s.isSymbolicLink()) throw Error("Unexpected file type");
  const b = fs.readFileSync(f.path);
  if (b.length !== f.bytes || crypto.createHash("sha256").update(b).digest("hex") !== f.sha256) throw Error("Hash mismatch");
}
console.log("Source manifest hashes verified:", manifest.files.length);
'
```

Use the lockfile without unrelated upgrades. Installation may need approved registry access; skipped dependency lifecycle scripts mean native-module requirements must be verified separately. Do not copy Windows node_modules or compiled native binaries. Create this new build directory's root `.env` only from the verified safe template. `env -i` prevents unrelated inherited app settings from overriding it:

```bash
test ! -e .env
test ! -L .env
install -m 0600 .env.example .env
env -i HOME="$HOME" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  "$node_bin" "$npm_cli" ci --ignore-scripts --include=dev --no-audit --no-fund
env -i HOME="$HOME" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  "$node_bin" "$npm_cli" run build
env -i HOME="$HOME" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  "$node_bin" "$npm_cli" run hub:check
test -f .next/BUILD_ID
test -f server/dist/server.js
test -d shared/contracts/dist
```

The Linux build is required even when local Windows checks passed. The host must already have an approved ZIP extraction utility; this guide does not install operating-system packages. Runtime needs `.next/`, `server/dist/`, `shared/contracts/` and its `dist/`, Linux `node_modules`, root configuration/package files, startup tools and the approved public/PDF font assets. Keep the immutable source manifest and build receipt. Private PDF marks and historical attachments are not provisioned by this foundation. No migration, seed, demo initializer or Zoho setup command belongs in install/build/start.

## 5. New release, one root environment and one service

Only after all new path/user checks pass, create Hub-only resources. These commands fail their prerequisites when names already exist; do not bypass the checks:

```bash
target=/var/www/hub.voltronix_ae
release_dir=$target/hub-releases/$release_id
test -d "$target"
test ! -L "$target"
for path in "$target/hub-releases" "$target/hub-current"; do
  test ! -e "$path"
  test ! -L "$path"
done
if getent passwd hub-crm; then exit 1; fi
if getent group hub-crm; then exit 1; fi
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin hub-crm
sudo install -d -m 0755 "$target/hub-releases" "$release_dir"
tar --exclude='./.env' -C "$source_root" -cf - . | sudo tar --no-same-owner -xf - -C "$release_dir"
sudo chmod 0755 "$release_dir"
test ! -e "$release_dir/.env"
test ! -L "$release_dir/.env"
sudo install -o root -g hub-crm -m 0640 "$release_dir/.env.example" "$release_dir/.env"
sudo install -d -o hub-crm -g hub-crm -m 0700 "$release_dir/.next/cache"
sudo ln -s "$release_dir" "$target/hub-current"
sudo -u hub-crm test -r "$release_dir/.env"
sudo -u hub-crm test -r "$release_dir/.next/BUILD_ID"
sudo -u hub-crm test -r "$release_dir/server/dist/server.js"
```

Review access modes in the NEW release: the service user needs read/traverse access to source, dependencies and compiled assets; only the Next cache is service-writable. Never recursively chown/chmod the existing target or its legacy children. Node native modules may require executable files; preserve build modes. The new root `.env` starts as an ordinary safe template. For a preliminary disabled preview, retain `CRM_DATABASE_MODE=disabled`, `CRM_MYSQL_NETWORK_DISABLED=1` and `ZOHO_ENABLED=false`. For the chosen working CRM, transfer the reviewed existing production configuration privately into this new release and verify its native target using [the environment contract](backend-production-environment.md). Verify existing administrator access and outbound actor bindings; do not run bootstrap or binding `apply` automatically. A missing account or binding requires review before any write. Select the Zoho profile only after its documented acceptance passes. Preserve existing private values when editing; do not replace the owner's root `.env` with this template during an update. Keep all application settings in this one file; do not create `server/.env` or `/etc` web/API environment files.

Run `hub:check` again after the native settings are installed and before starting the service, keeping `ZOHO_SYNC_ENABLED=false` until the existing target and a single bounded import have been accepted. A failed native readiness check is a deployment stop; do not switch back to the disabled preview and report a working CRM. The sync and binding operator utilities use the root's installed `tsx` dependency, so retain the documented `--include=dev` installation for these tools or run them from a separately protected matching operator copy. Follow the separate [check → one run → review → enable sequence](backend-production-environment.md#guarded-manual-activation-on-the-existing-target) for polling. The normal compiled service never bootstraps users or applies migrations automatically.

Check the proposed unit path is absent, inspect exact unit text, then validate and install only the combined Hub service:

```bash
test ! -e /etc/systemd/system/hub-crm.service
test ! -L /etc/systemd/system/hub-crm.service
sudo systemd-analyze verify "$release_dir/deploy/ubuntu/hub-crm.service"
sudo install -o root -g root -m 0644 "$release_dir/deploy/ubuntu/hub-crm.service" /etc/systemd/system/hub-crm.service
sudo systemctl daemon-reload
sudo systemctl start hub-crm.service
sudo systemctl status hub-crm.service --no-pager
```

Do not enable boot startup or change public routing until isolated acceptance. A failed configuration/port/identity preflight is a stop signal; inspect only Hub logs (`journalctl -u hub-crm`) privately, never dump `.env` or credential-bearing requests. The service runs the same combined `start` entrypoint as `npm start`; its preflight runs the same combined check as `npm run hub:check`.

### Private quotation assets

The source ZIP excludes company quotation backgrounds, signatures and stamps. The local restoration described in [the asset guide](runtime-excluded-assets.md#local-restoration-and-private-deployment) does not put those images in the archive. Before accepting quotation workflows on a native database, transfer only `databg.png`, `switchgear_bg4.png`, `sign.jpg` and `stamp.jpg` through the operator's private channel. Verify their hashes against the approved originals. Do not place them in `public/`, expose a static alias, or transfer the historical test-only `.private-legacy/` and `assets/` trees.

For an already verified new `$release_dir`, select the private staging directory explicitly and install only those four files. This step refuses any existing destination rather than overwriting it:

```bash
private_pdf_dir=/operator-selected/private/quotation-pdf
for asset in databg.png switchgear_bg4.png sign.jpg stamp.jpg; do
  test -f "$private_pdf_dir/$asset"
  test ! -L "$private_pdf_dir/$asset"
  test ! -e "$release_dir/server/assets/quotation-pdf/$asset"
  test ! -L "$release_dir/server/assets/quotation-pdf/$asset"
  sudo install -o root -g hub-crm -m 0640 "$private_pdf_dir/$asset" "$release_dir/server/assets/quotation-pdf/$asset"
done
```

Keep staging private and retain the verification receipt outside the source package. If the retained reference renderer is needed, perform the same exact-file installation into the new release's `resources/quotation-pdf/`, checking those destination paths first. Validate actual authorized PDF generation and denied access after native database acceptance; installing images alone does not establish working authentication or data workflows.

## 6. Loopback smoke checks

These future operator probes use only the new loopback listeners and do not log in, create records or contact the legacy database:

```bash
curl --noproxy '*' --fail --silent --show-error http://127.0.0.1:3302/api/v1/health/live
curl --noproxy '*' --fail --silent --show-error http://127.0.0.1:3302/api/v1/health/identity
curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:3302/api/v1/health/ready
curl --noproxy '*' --fail --silent --show-error http://127.0.0.1:3301/api/health/live
curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:3301/api/health/ready
curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:3301/login
curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:3301/api/auth/me
```

Expect API liveness 200, the configured exact instance ID/origin, and web liveness/login 200. A deliberately disabled preview returns readiness 503 and authentication 503. The chosen enabled native deployment must return **readiness 200 through both API and web**, with unauthenticated `/api/auth/me` denied as 401. A native readiness failure requires investigation; do not replace it with a liveness-only success. Inspect Hub logs for redacted diagnostics. Login and authenticated workflows must then be tested over approved HTTPS with secure cookies; a login page alone does not establish working authentication.

## 7. DNS, certificate and separate Nginx configuration

The owner must verify DNS A/AAAA records, actual server addresses, domain control, certificate hostname/chain/expiry, key permissions and renewal before applying the HTTPS template. No certificate is assumed to exist. Provision certificates through an independently reviewed procedure that does not modify any existing site's configuration. Do not start the HTTPS example with nonexistent certificate paths. Its bounded ACME directory is optional; no challenge client or public directory is created by this task.

Review `deploy/ubuntu/nginx.conf.example`: only `hub.voltronix.ae`, dedicated upstream/log names, no `default_server` or wildcard, no PHP handler, no public API/database upstream and no alias to uploads or source. It must be included exactly once in the existing `http {}` context. Confirm no conflicting Hub virtual host already exists; if there is one, stop for an explicit, separately reviewed traffic-switch plan. The template does not replace `/etc/nginx/nginx.conf` or `crm.voltronix.ae` configuration.

After private loopback acceptance, TLS prerequisites and approval to expose the accepted Hub service, install a NEW dedicated file/link only if both paths are absent:

```bash
test ! -e /etc/nginx/sites-available/hub-crm.conf
test ! -L /etc/nginx/sites-available/hub-crm.conf
test ! -e /etc/nginx/sites-enabled/hub-crm.conf
test ! -L /etc/nginx/sites-enabled/hub-crm.conf
sudo install -o root -g root -m 0644 "$release_dir/deploy/ubuntu/nginx.conf.example" /etc/nginx/sites-available/hub-crm.conf
sudo ln -s /etc/nginx/sites-available/hub-crm.conf /etc/nginx/sites-enabled/hub-crm.conf
sudo nginx -t
# Only after a successful test with no conflicting-host warnings and approval:
sudo systemctl reload nginx
```

A reload affects the shared Nginx master, so it requires explicit operator approval and configuration review even though only a new Hub virtual host is added. Never restart Nginx or unrelated services as a shortcut. If `nginx -t` fails, do not reload; follow the scoped rollback below. After acceptance, optional HSTS is a deliberate edit to the new Hub file only (without `includeSubDomains` or preload), followed by another `nginx -t` and approved reload.

The operator's HTTPS checks must verify hostname/certificate, redirects, secure headers, asset loading, native readiness, real login/logout and intended workflows, while confirming the existing CRM through its established nonmutating health checks. A disabled preview must continue to show readiness 503. This release requires acceptance of the selected existing database and its bindings; a replacement database or PHP-data import is outside this scope. Enable `hub-crm.service` at boot only after the intended deployment mode passes acceptance.

## 8. Roll back only the newly introduced Hub components

Keep receipts of every new file/symlink/service and previous Hub release target. Stop only the new combined Hub unit, which stops both processes it owns:

```bash
sudo systemctl stop hub-crm.service
```

If this procedure introduced the Nginx link, verify it resolves to the exact new Hub file, then unlink just that link, validate the full configuration and request the approved reload:

```bash
test "$(readlink /etc/nginx/sites-enabled/hub-crm.conf)" = /etc/nginx/sites-available/hub-crm.conf
sudo unlink /etc/nginx/sites-enabled/hub-crm.conf
sudo nginx -t
sudo systemctl reload nginx
```

Run that block only when the recorded new link exists; never remove an older operator-managed host. If the new Hub service was enabled after acceptance, disable only that unit. Preserve the release, runtime, root `.env` and failure logs privately for review. For a first installation, verify `hub-current` still points to the recorded `$release_dir` before unlinking it; do not remove directories or original files. For a later Hub-only upgrade, switch only this dedicated symlink back to the recorded accepted Hub release and its own `.env`, then start only `hub-crm.service` and repeat the loopback checks.

Do not restore, roll back or touch the preserved legacy database. For a disabled preview, confirm the database veto stayed enabled. For an enabled native deployment, preserve the existing Hub database, operation journals, sync checkpoints and evidence; service rollback does not undo native or Zoho writes. An earlier release must be compatible with the installed v5 schema before reuse. Follow the native operator recovery procedure for any separately reviewed database recovery, never an automatic restore or destructive reset. Legitimate legacy activity may continue; do not freeze or overwrite it to make a checksum match.
