# VPS releases

`compose.vps.yml` packages the current API/worker, Dispatch and Driver web apps,
homepage and Admin. The runtime image is shared by the API, worker and migration
job; the other three images contain their own current app assets/dependencies.
The Android/iOS wrapper is released separately and continues to use
`https://driver.kavaroutes.com`.

Use an x64 Linux VPS with Docker Engine and Compose v2.24 or newer. This composition
uses host networking because the current services deliberately bind to localhost.
Start with at least 4 GB RAM; configured service memory ceilings total roughly
2.7 GB before Docker, the tunnel and host overhead. Building needs more memory.
Docker and Compose behavior: [services](https://docs.docker.com/reference/compose-file/services/),
[external volumes](https://docs.docker.com/reference/compose-file/volumes/).

## Host configuration

Copy `infra/vps/.env.example` to a private `.env.vps`, or to
`/etc/kavaroutes/vps.env` for CD. Use mode 0600. It contains paths, numeric
container UIDs/GIDs, the release ID and the exact PostgreSQL volume name, never
API keys or passwords. For an existing installation, retain its volume name;
`kavaroutes-cloud_database` is the existing cloud stack's default. For a new host,
choose a new name and explicitly create it with `docker volume create NAME`.
The database volume is external and will not be recreated or removed by Compose.

Restore/provision these private files and directories before starting:

| Host setting | Required content |
| --- | --- |
| `KR_SECRETS_DIRECTORY` | `postgres-password`, `database-passwords.json`, `admin.json`, `api.json`, `worker.json`, `business-identity.json`, `driver-admins.json`, `geoapify.env`, `site.env` |
| `KR_DRIVER_ACCESS_DIRECTORY` | Existing `access.json` and `sessions.json`; retain the entire directory |
| `KR_GOOGLE_DIRECTORY` | Protected `service-account.json` for Firebase Admin on a VPS; may be empty when Firebase is unconfigured |
| `KR_SITE_DIRECTORY` | Homepage SQLite database and any WAL/SHM sidecars |
| `KR_REGISTRATIONS_DIRECTORY` | Shared business registration exports |
| `KR_ADMIN_DIRECTORY` | Existing `config.json`, Admin SQLite data, `trip-reports/` and other Admin files |

All runtime JSON configuration files must be mode 0600, owned by the process UID
that reads them. Runtime API/worker configs must use `business-authenticated`,
database host `127.0.0.1:5432`, database `kavaroutes_cloud` and the corresponding
`kr_cloud_api`/`kr_cloud_worker`/`kr_cloud_admin` role. API port must be **58082**,
worker **58081**. Retain existing ETag/cursor/session signing keys and passwords;
do not regenerate them during a migration. `admin.json` here is the runtime
migration config, distinct from the dashboard's `config.json`.

`geoapify.env` contains `GEOAPIFY_API_KEY` (server only). `site.env` contains
the site's `KR_SITE_FIREBASE_*` settings. Empty env files are accepted when these
providers are deferred; missing providers do not create synthetic logins. Business
identity must still have a configured provider: retain TestPony's narrowly scoped
Cloudflare test provider until real business Firebase tenant settings exist.
The Google service-account credentials are mounted read-only and never copied
into an image or supplied as build arguments. Give the account only the needed
Firebase permissions. Admin remains Cloudflare authenticated; regular businesses
and Driver use their existing application authentication.

For newly created writable directories, set the appropriate owner and mode 0700.
The shared registrations directory needs the site's UID and shared GID with mode
2750; exports inherit its group for Admin to read. Driver access needs the API UID
and API GID with mode 2770 so the Admin process can manage access. For an existing
host, set the UID/GID variables to match existing owners instead of changing data
ownership indiscriminately. The Admin user joins the API group. Mounts refuse to
silently create missing paths.

An entirely new Driver access directory also needs an `access.json` with mode
0640 and the API UID/GID. Initialize it only when no existing file exists:

```json
{"version":1,"codes":[],"devices":[],"events":[],"driverTokens":[]}
```

This contains no credentials/accounts. Business access codes must subsequently be
issued through the existing business setup flow. Always restore the real file
when migrating an installation.

For a new Admin store, build first, then run the existing offline operator inside
the Admin container (with the real issuer/audience):

```sh
docker compose --env-file .env.vps -f compose.vps.yml --profile admin run --rm --no-deps admin node bin/operator.mjs init --directory /var/lib/kavaroutes-admin --mode cloudflare --issuer https://TEAM.cloudflareaccess.com --audience ADMIN_APPLICATION_AUD
```

Keep the resulting owner-enrollment file private and complete enrollment normally.
This command refuses to overwrite an existing Admin database.

## Build and start

```sh
docker compose --env-file .env.vps -f compose.vps.yml --profile admin config --quiet
docker compose --env-file .env.vps -f compose.vps.yml --profile admin build
docker compose --env-file .env.vps -f compose.vps.yml up -d --wait postgres
docker compose --env-file .env.vps -f compose.vps.yml --profile initialize run --rm initialize
docker compose --env-file .env.vps -f compose.vps.yml --profile admin up -d --no-build --pull never --wait --wait-timeout 180
```

Backup an existing database before migrations. A new empty database receives only
schema/roles, never fake drivers or trips; business/driver enrollment remains an
explicit operation. Omit `--profile admin` until its store is initialized.
Do not run this alongside the existing stack on the same ports/volume. When
migrating the existing host, back up the PostgreSQL database and stop the old
Compose/systemd services before the cutover; SQLite and Driver files must be
copied while their writers are stopped. CD is for an already provisioned VPS
composition and refuses a first deployment without healthy existing services.

## Tunnel endpoints

Keep the tunnel on the host. Preserve the original hostname/Host header.

| Public hostname | Host origin |
| --- | --- |
| `kavaroutes.com` | `http://127.0.0.1:58110` |
| `app.kavaroutes.com` | `http://127.0.0.1:58080` |
| `driver.kavaroutes.com` | `http://127.0.0.1:58080` |
| `admin.kavaroutes.com` | `http://127.0.0.1:58100` |

HTTPS terminates at Cloudflare. Keep Admin's Access policy and only TestPony's
existing test Access exception. No Cloudflare login is needed for Driver, whose
business gate and individual Driver authentication remain enforced. Never route
the public tunnel directly to API 58082, worker 58081 or PostgreSQL 5432.

Admin reports and request/access logs retain their existing storage. The existing
trip-report host timer must also be moved/reconfigured if migrating to a new VPS;
the web stack does not generate those exported report files itself. Stripe and
outbound Gmail remain deferred until explicitly configured.

## CI/CD activation

`.github/workflows/ci.yml` runs affected application checks on pull requests, all
checks on pushes to `main`, and full verification on manual dispatch. It builds
the four VPS images from one revision, verifies runtime source/dependency evidence,
runs disposable PostgreSQL command integration and the complete production-profile
Compose smoke test. Browser accessibility/acceptance must pass when selected.
Release dependency auditing remains a blocking gate on manual release runs.
Android/iOS interface bundles and native contract/type checks remain separate from
server deployment; those bundles are not signed APK/IPA releases.

Release images are exported together in `images.tar.gz`: shared layers are stored
once, and the VPS imports the exact tested bytes without rebuilding or registry
credentials. A manifest records the source commit, image IDs, executable
configuration/layer fingerprints and SHA-256 checksums. Fingerprints allow the
same archive to be verified across Docker's classic and containerd image stores.
Push artifacts are retained for three days. Pull requests never reach the VPS
runner or publish deployable artifacts.

After provisioning the VPS stack above:

1. Register a GitHub Actions self-hosted Linux x64 runner on the VPS with label
   `kavaroutes-vps` (repository Settings → Actions → Runners → New self-hosted runner).
   Follow GitHub's generated commands for its current runner version/token, and
   install the runner as a service. Only the manual deployment job uses this runner.
2. Put the private Compose environment at `/etc/kavaroutes/vps.env`, mode 0600.
   Use absolute paths and simple `KR_NAME=value` entries. It must describe the
   healthy running VPS stack. Keep production credentials on the host.
3. Create the initial release pointer after the manual stack is healthy:

   ```sh
   sudo install -d -m 0700 /opt/kavaroutes-vps/releases/bootstrap
   sudo install -m 0600 compose.vps.yml /opt/kavaroutes-vps/releases/bootstrap/compose.vps.yml
   sudo ln -s bootstrap /opt/kavaroutes-vps/releases/current
   ```

4. Create the GitHub `production` environment and restrict deployment branches to
   `main`. Optional environment variables `KR_VPS_ENV_FILE` and
   `KR_VPS_RELEASE_ROOT` override the defaults above. The deployment runner must
   have Docker access, Python 3.10+ and noninteractive sudo for the trusted deployment
   script. Give the runner its own Unix account, separate from application UIDs.
   Configure this only for a dedicated runner controlled by the repository
   owner; pull-request jobs stay on GitHub-hosted runners.
5. Push the local commit. In Actions → KavaRoutes CI → Run workflow, select `main`
   and enable **deploy_vps**. Leaving it disabled builds/verifies a release only.

Deployment takes a host lock, checks the currently running services, verifies the
release hashes and loaded image IDs, then stops application writers and backs up
PostgreSQL plus the homepage/Admin/Driver state. It migrates and starts the new
images, checks health and image IDs, and advances the release pointer only after
success. Database dumps/imports are streamed; no dump is buffered in memory.
On failure it restores the previous image IDs/configuration and pre-release state,
preserving the attempted database and files for review. A failed rollback leaves
an explicit operator-review status. Deploy during a maintenance window, outside
live shifts. Keep sufficient free disk space for release images and full backups;
prune reviewed old backups/releases manually, never automatically during promotion.
