# Reviewed assets and excluded private inputs

This guide describes the clean source at `G:\hub.voltronix.ae`. Original assets remain untouched in `G:\crm.voltronix.ae`. Inclusion uses exact reviewed file paths and bytes; it is not permission to copy the original `assets/`, uploads, resources or public tree wholesale. The [project audit](project-audit.md) records the selection and [verification report](clean-project-verification.md) records actual tests.

## Included quotation fonts and notices

Each of `server/assets/quotation-pdf/` and `resources/quotation-pdf/` retains these six reviewed source assets:

```text
Roboto-Regular.ttf
Roboto-Bold.ttf
Roboto-LICENSE.txt
DejaVuSansCondensed.ttf
DejaVuSansCondensed-Bold.ttf
DejaVuinfo.txt
```

Keep the notices with the fonts. The two directories are required by distinct retained renderer paths: Express uses `server/assets/quotation-pdf/`; web/reference compatibility code uses root `resources/quotation-pdf/`. Their similar names do not make either copy disposable. These files are not served as an unrestricted public directory.

The public source package excludes the private quotation files `databg.png`, `switchgear_bg4.png`, `sign.jpg`, `stamp.jpg` and internal `README.md` provenance from each directory. Backgrounds can themselves contain signature/stamp material. Font inclusion does not authorize publishing those marks. A deployment without the four private images cannot render affected saved quotations; no fabricated replacement is supplied.

### Local restoration and private deployment

On 19 October 2026, the four original quotation images were restored locally into both renderer directories to repair the requested PDF workflows. Each copy was verified byte-for-byte against the preserved original; existing files were not overwritten and originals were unchanged. These eight local files remain ignored and excluded from the source ZIP. Local private receipts are retained under `.local-data/`.

For manual deployment, transfer the approved four images privately and install them separately in the new release's `server/assets/quotation-pdf/`. Also install them in `resources/quotation-pdf/` if the retained reference renderer is needed. Keep them outside `public/`; the service needs read access, not write access. Check their hashes against the privately retained approved originals before starting the release. The [manual deployment guide](manual-deployment-guide.md#private-quotation-assets) gives the bounded installation step. The source archive does not contain these images, even when local PDF tests pass.

Local historical-source tests also require specific preserved originals. Only the 22 files referenced by those tests were restored under ignored `.private-legacy/source-20261014/` after credential-pattern checks, together with six exact original image/font comparison files under ignored `assets/`. These are private test prerequisites, not application runtime or deployment inputs. No environment files, database, customer uploads or complete legacy application were copied. They remain excluded from source packaging; the test assertions and preservation path resolver were not changed.

## Included public UI assets: 23 files

These paths are relative to `public/`:

```text
legacy/assets/css/hrms.css
legacy/assets/css/jquery.dataTables.min.css
legacy/assets/css/select2.min.css
legacy/assets/css/style.css
legacy/assets/css/style-preset.css
legacy/assets/css/plugins/phosphor-icons.css
legacy/assets/css/plugins/tabler-icons.min.css
legacy/assets/css/plugins/Phosphor.svg
legacy/assets/css/plugins/Phosphor.ttf
legacy/assets/css/plugins/Phosphor.woff
legacy/assets/css/plugins/Phosphor.woff2
legacy/assets/css/plugins/fonts/tabler-icons.ttf
legacy/assets/css/plugins/fonts/tabler-icons.woff
legacy/assets/css/plugins/fonts/tabler-icons.woff2
legacy/assets/images/civilgif.gif
legacy/assets/images/electricgif.gif
legacy/assets/images/favicon_voltronix.png
legacy/assets/images/logo-voltronix.png
legacy/assets/images/Maintenancemtn.gif
legacy/assets/images/PM.gif
legacy/assets/images/switchgear.gif
legacy/assets/images/voltronix_logo.png
legacy/assets/images/authentication/img-auth-bg-2.jpg
```

These styles, icon fonts and images are referenced by the application and are retained as reviewed source assets. Existing Voltronix company/PDF terminology is preserved. This boundary does not claim rights to unrelated historical files.

`public/legacy/manifest.json` remains excluded because it is internal provenance. On 19 October 2026, the user requested the same red Voltronix browser-tab icon as the Dashboard. The exact `public/legacy/assets/images/favicon_voltronix.png` is now included with SHA-256 `23adf63d7c14b8e97206afd933c976bdc7ddfb1ce7ab318b6dbe9c50a332d037`, and the app metadata references it. The auditor permits only this path and hash to match the historical `original-uploads` category; other private-content and credential findings still reject it. This approval does not include other historical uploads, attachments or customer files.

## Remaining external prerequisites

The exact private characterization files and quotation images described above are present in ignored local directories. They remain outside the source package and Git candidates, as do local databases, sessions and backups. A fresh checkout must obtain its approved private prerequisites separately. No fixture resolver was redirected to the original sibling to make tests pass. Keep genuinely missing-input failures visible in the verification report.

Any future provisioning needs approved exact bytes, ownership, private delivery paths and independent acceptance in a new isolated release. It must not modify originals, weaken authorization, recalculate historical quotation values or turn an uploads directory into a public alias. See the [legacy compatibility analysis](legacy-production-compatibility.md) and [release checklist](final-release-checklist.md).
