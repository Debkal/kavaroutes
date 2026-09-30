# Docker stale-build audit — local workstation vs `kavaroutes-dev-01`

Date: 2026-09-19 (America/Los_Angeles)

Scope: Docker image stores on **this workstation** and the **GCP VM `kavaroutes-dev-01`**
(project `kavaroutes`, zone `us-west1-b`).

## Method

- `docker images --no-trunc` / `docker system df -v` against the local Docker Desktop daemon.
- The same read-only commands on the VM over IAP SSH (`gcloud compute ssh ... --tunnel-through-iap`).
- The VM's accepted image was read from `/opt/kavaroutes/runtime/vm.env` and cross-checked against
  `docker compose ps` and the running containers' image IDs.
- Local tags were mapped to digests with `docker images --digests` for a 1:1 comparison with the VM's digest-pinned images.

## Reference: what the VM actually runs

| Fact | Value |
| --- | --- |
| Accepted image (`vm.env`) | `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime@sha256:faf8d862212649dd6618ec21b5ae548a7e3232a2d224c75b8d2593230c508d90` |
| Build id | `f40988c-20260918T160716Z` (commit `f40988c`, the current HEAD) |
| Containers on that image | `kavaroutes-cloud-api-1`, `kavaroutes-cloud-worker-1`, `kavaroutes-cloud-gateway-1` — all `Up 22 hours (healthy)` |
| Pinned infrastructure image | `postgis/postgis:17-3.5@sha256:624f5195…` (postgres container) |
| VM image store | 50 images, 11.36 GB total, **9.675 GB reclaimable (85%)** |

Only **two** images on the VM are in use: the accepted runtime digest and the pinned PostGIS image.
Every other runtime image is a superseded promotion target left behind by `docker pull`.

> `/opt/kavaroutes/runtime/vm.env.pre-*` and `/opt/kavaroutes/backups/*.dump` are configuration/database
> rollback artifacts, **not** image rollback targets. `cloud-rollback.py` restores *configuration* to the
> accepted image and explicitly does not downgrade images, so none of the stale images below are needed for rollback.

## VM findings — 48 stale runtime images

The VM pulls each promotion by digest, so these images carry no tag (`<none>`) and are identified by digest.
All 48 are unused (`Containers = 0`). The accepted runtime and PostGIS are excluded.

| # | Image ID (short) | Created (UTC) | Unique size |
| --- | --- | --- | --- |
| 1 | `4e21198041d3` | 2026-09-18 00:40:03 +0000 UTC | 237.1MB |
| 2 | `d71b0df69b88` | 2026-09-18 00:16:46 +0000 UTC | 237.1MB |
| 3 | `800348c4b4c8` | 2026-09-17 23:52:31 +0000 UTC | 237.1MB |
| 4 | `d4cc0a358887` | 2026-09-17 23:19:11 +0000 UTC | 237MB |
| 5 | `255ca955fd2f` | 2026-09-17 22:57:16 +0000 UTC | 237MB |
| 6 | `769777faadb9` | 2026-09-17 22:20:56 +0000 UTC | 237MB |
| 7 | `0659c43e4ea7` | 2026-09-17 21:24:08 +0000 UTC | 237MB |
| 8 | `12b9155d1f6a` | 2026-09-17 21:11:15 +0000 UTC | 237MB |
| 9 | `c4c2f6a659b3` | 2026-09-17 20:45:15 +0000 UTC | 237MB |
| 10 | `dec88b9bf4bf` | 2026-09-17 20:31:26 +0000 UTC | 237MB |
| 11 | `ecd91376ee10` | 2026-09-17 20:13:54 +0000 UTC | 237MB |
| 12 | `acd228716f58` | 2026-09-17 20:08:54 +0000 UTC | 237MB |
| 13 | `9c417e190fcc` | 2026-09-17 19:53:49 +0000 UTC | 2.063kB |
| 14 | `815343956039` | 2026-09-17 19:53:49 +0000 UTC | 2.063kB |
| 15 | `91afc1cfb16c` | 2026-09-17 19:53:49 +0000 UTC | 2.063kB |
| 16 | `62642390fbd5` | 2026-09-17 19:50:18 +0000 UTC | 236.9MB |
| 17 | `20f1f6e64e38` | 2026-09-17 19:44:27 +0000 UTC | 236.9MB |
| 18 | `bd8bb1be521d` | 2026-09-17 19:35:38 +0000 UTC | 236.9MB |
| 19 | `fb647e05deb0` | 2026-09-17 19:23:35 +0000 UTC | 236.9MB |
| 20 | `11d120eac896` | 2026-09-17 16:06:00 +0000 UTC | 236.9MB |
| 21 | `b3dda6c46408` | 2026-09-17 16:02:59 +0000 UTC | 236.9MB |
| 22 | `c12991f62ed0` | 2026-09-17 16:00:42 +0000 UTC | 236.9MB |
| 23 | `da873e39cbd9` | 2026-09-17 15:50:56 +0000 UTC | 236.9MB |
| 24 | `fc11114a61d6` | 2026-09-17 15:48:01 +0000 UTC | 236.9MB |
| 25 | `fc47cd6a8a8d` | 2026-09-17 15:43:39 +0000 UTC | 236.9MB |
| 26 | `2240bceb16e0` | 2026-09-17 15:31:31 +0000 UTC | 236.9MB |
| 27 | `ceb9916732db` | 2026-09-17 15:28:16 +0000 UTC | 236.9MB |
| 28 | `46ae9b78b703` | 2026-09-17 15:23:03 +0000 UTC | 236.9MB |
| 29 | `71b1b72163c9` | 2026-09-17 15:19:56 +0000 UTC | 236.9MB |
| 30 | `da94b038a0ba` | 2026-09-17 15:18:23 +0000 UTC | 236.9MB |
| 31 | `d4865a78d810` | 2026-09-17 15:11:13 +0000 UTC | 236.9MB |
| 32 | `6aec58245854` | 2026-09-17 15:05:55 +0000 UTC | 236.9MB |
| 33 | `2577d462511e` | 2026-09-17 15:04:03 +0000 UTC | 236.9MB |
| 34 | `979df0afece4` | 2026-09-17 15:01:16 +0000 UTC | 236.9MB |
| 35 | `df8a921bbf37` | 2026-09-17 14:46:23 +0000 UTC | 236.8MB |
| 36 | `b9b51af142d4` | 2026-09-17 14:21:15 +0000 UTC | 236.8MB |
| 37 | `d077af449f45` | 2026-09-17 06:02:51 +0000 UTC | 236.8MB |
| 38 | `2cb42e2fde78` | 2026-09-15 20:35:05 +0000 UTC | 147.7MB |
| 39 | `115324ba9ee7` | 2026-09-15 20:23:42 +0000 UTC | 147.7MB |
| 40 | `d7a1ecb9bb17` | 2026-09-15 19:49:13 +0000 UTC | 147.7MB |
| 41 | `1922f81610a3` | 2026-09-15 19:01:46 +0000 UTC | 147.6MB |
| 42 | `34837ec026aa` | 2026-09-15 00:55:56 +0000 UTC | 147.4MB |
| 43 | `9614c95ff32f` | 2026-09-14 19:20:24 +0000 UTC | 147.3MB |
| 44 | `463db7fcef5f` | 2026-09-14 14:18:01 +0000 UTC | 147.2MB |
| 45 | `a0c0f12a6544` | 2026-09-13 21:45:00 +0000 UTC | 146.8MB |
| 46 | `54547631f283` | 2026-09-13 21:23:36 +0000 UTC | 146.8MB |
| 47 | `68daf1e5d726` | 2026-09-13 21:07:53 +0000 UTC | 146.8MB |
| 48 | `fd28e55ae370` | 2026-09-12 17:47:45 +0000 UTC | 146.6MB |

**Estimated reclaim: 9.68 GB** — consistent with `docker system df` on the VM (9.675 GB reclaimable of 11.36 GB).

Recommended VM cleanup (removes only images not referenced by any container):

```bash
# on kavaroutes-dev-01
sudo docker image prune -a --force   # 48 unused runtime images, ~9.7 GB
sudo docker system df
```

A blunter `sudo docker image prune --force` (untagged only) reclaims the same 48 images, because every
stale VM image is untagged; it just can never touch a tagged image.

## Local findings

> **Update (2026-09-19, after this report was first written):** a local cleanup has already been applied.
> The image count fell from **72 to 9** and the `kavaroutes-wp005` Compose project is gone. The stale
> kavaroutes runtime tags, HIG-011, alpine/hello-world, playwright, `docker:cli`, `node:24`, the Supabase
> edge-runtime pair and `searxng/searxng` are **already removed** — the tables below are the pre-cleanup
> snapshot kept for the record. Still outstanding locally as of the re-check: the two `kavaroutes-wp005-*`
> images, the WP005/WP006 volumes (now both orphaned), the WP006 project, `searxng`, the three `kr-*`
> audit-probe containers (next section) and the BuildKit cache (now ~31 GB).

The workstation holds 72 images / 76 tags, 51.12 GB of layers, of which `docker system df` reports
**48.31 GB reclaimable (94%)**. The BuildKit cache adds a further **20.3 GB** reclaimable (577 entries).

### Matches the VM — keep

| Tag | Image ID | Note |
| --- | --- | --- |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit24-20260917` | `faf8d8622126` | exactly the digest the VM runs |

### Referenced by a local container

| Image | Containers | Keep? |
| --- | --- | --- |
| `kavaroutes-local-web:dev` (`9de429b7bc24`) | 1 running | keep |
| `kavaroutes-local-runtime:dev` (`f445addbb873`) | 3 running + 1 exited init | keep |
| `postgis/postgis:17-3.5` (`624f5195…`) | 1 running | keep |
| `node:<none>` (`3638d9a6…`, the digest `kavaroutes-local-credentials-1` references) | 1 exited | keep while that container exists |
| `kavaroutes-wp005-api:latest`, `kavaroutes-wp005-worker:latest` | 2 exited, ~2 weeks old | **stale** — remove with the WP005 project |

### Stale kavaroutes runtime builds — remove

Earlier promotion targets plus two local-only CQ-003 builds. None is used by a container. Several are
aliases of the same image ID, and the two `kavaroutes-runtime`/`kavaroutes-cloud-runtime` entries are
duplicate local tags of images that also exist under the registry repo.

| Tag | Created (local) | Unique size | Digest (short) |
| --- | --- | --- | --- |
| `kavaroutes-cloud-runtime:cld007-local` | 2026-09-12 10:47:45 -0700 PDT | 227.1MB | `fd28e55ae370` |
| `kavaroutes-runtime:client-integration-20260913` | 2026-09-13 14:07:53 -0700 PDT | 227.2MB | `68daf1e5d726` |
| `kavaroutes-runtime:driver-shift-20260913` | 2026-09-13 14:23:36 -0700 PDT | 227.2MB | `54547631f283` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:driver-realtime-20260913` | 2026-09-13 14:45:00 -0700 PDT | 227.2MB | `a0c0f12a6544` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:sol004-20260914` | 2026-09-14 07:18:01 -0700 PDT | 227.7MB | `463db7fcef5f` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:sol005-20260914` | 2026-09-14 12:20:24 -0700 PDT | 227.7MB | `9614c95ff32f` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:sol006-20260914` | 2026-09-14 17:55:56 -0700 PDT | 227.9MB | `34837ec026aa` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:sol007-20260915` | 2026-09-15 12:01:46 -0700 PDT | 228.1MB | `1922f81610a3` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:sol008-20260915` | 2026-09-15 12:49:13 -0700 PDT | 228.1MB | `d7a1ecb9bb17` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:sol009-20260915` | 2026-09-15 13:23:42 -0700 PDT | 228.2MB | `115324ba9ee7` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:sol009b-20260915` | 2026-09-15 13:35:05 -0700 PDT | 228.2MB | `2cb42e2fde78` |
| `kavaroutes-local-runtime:cq003-0917` | 2026-09-16 18:39:24 -0700 PDT | 108.1MB | `c76433e63451` |
| `kavaroutes-local-runtime:cq003-verify-0917` | 2026-09-16 18:39:24 -0700 PDT | 108.1MB | `4ce81dc5f816` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:clientintake-20260917` | 2026-09-16 23:02:51 -0700 PDT | 317.2MB | `d077af449f45` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:assign-reasons-20260917` | 2026-09-17 07:21:15 -0700 PDT | 317.2MB | `b9b51af142d4` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:driver-flow-20260917` | 2026-09-17 07:46:23 -0700 PDT | 317.2MB | `df8a921bbf37` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:driver-logins-20260917` | 2026-09-17 08:01:16 -0700 PDT | 317.3MB | `979df0afece4` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:driver-logins2-20260917` | 2026-09-17 08:04:03 -0700 PDT | 317.3MB | `2577d462511e` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:driver-logins3-20260917` | 2026-09-17 08:05:55 -0700 PDT | 317.3MB | `6aec58245854` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:driver-login-ui-20260917` | 2026-09-17 08:11:13 -0700 PDT | 317.3MB | `d4865a78d810` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:driver-login-fix-20260917` | 2026-09-17 08:18:23 -0700 PDT | 317.3MB | `da94b038a0ba` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:driver-login-fix2-20260917` | 2026-09-17 08:19:56 -0700 PDT | 317.3MB | `71b1b72163c9` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:driver-login-fix3-20260917` | 2026-09-17 08:23:03 -0700 PDT | 317.3MB | `46ae9b78b703` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:driver-remove-20260917` | 2026-09-17 08:28:16 -0700 PDT | 317.3MB | `ceb9916732db` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:driver-remove2-20260917` | 2026-09-17 08:31:31 -0700 PDT | 317.3MB | `2240bceb16e0` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit-fixes-20260917` | 2026-09-17 08:43:39 -0700 PDT | 317.4MB | `fc47cd6a8a8d` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit-fixes2-20260917` | 2026-09-17 08:48:01 -0700 PDT | 317.4MB | `fc11114a61d6` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit-fixes3-20260917` | 2026-09-17 08:50:56 -0700 PDT | 317.4MB | `da873e39cbd9` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit-fixes4-20260917` | 2026-09-17 09:00:42 -0700 PDT | 317.4MB | `c12991f62ed0` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit-fixes5-20260917` | 2026-09-17 09:02:59 -0700 PDT | 317.4MB | `b3dda6c46408` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit-fixes6-20260917` | 2026-09-17 09:06:00 -0700 PDT | 317.4MB | `11d120eac896` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit-fixes7-20260917` | 2026-09-17 12:23:35 -0700 PDT | 317.4MB | `fb647e05deb0` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit8-20260917` | 2026-09-17 12:35:38 -0700 PDT | 317.4MB | `bd8bb1be521d` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit9-20260917` | 2026-09-17 12:44:27 -0700 PDT | 317.4MB | `20f1f6e64e38` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit10-20260917` | 2026-09-17 12:50:18 -0700 PDT | 317.4MB | `62642390fbd5` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit12-20260917` | 2026-09-17 12:53:49 -0700 PDT | 108.1MB | `91afc1cfb16c` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit11-20260917` | 2026-09-17 12:53:49 -0700 PDT | 108.1MB | `9c417e190fcc` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit13-20260917` | 2026-09-17 12:53:49 -0700 PDT | 108.1MB | `815343956039` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit14-20260917` | 2026-09-17 13:08:54 -0700 PDT | 317.4MB | `acd228716f58` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit15-20260917` | 2026-09-17 13:13:54 -0700 PDT | 317.4MB | `ecd91376ee10` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit16-20260917` | 2026-09-17 13:31:26 -0700 PDT | 317.4MB | `dec88b9bf4bf` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit17-20260917` | 2026-09-17 13:45:15 -0700 PDT | 317.4MB | `c4c2f6a659b3` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit18-20260917` | 2026-09-17 14:11:15 -0700 PDT | 317.4MB | `12b9155d1f6a` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit19-20260917` | 2026-09-17 14:24:08 -0700 PDT | 317.4MB | `0659c43e4ea7` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:driveracct-20260917` | 2026-09-17 15:20:56 -0700 PDT | 317.5MB | `769777faadb9` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:dropoffs-20260917` | 2026-09-17 15:57:16 -0700 PDT | 317.5MB | `255ca955fd2f` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit20-20260917` | 2026-09-17 16:19:11 -0700 PDT | 317.5MB | `d4cc0a358887` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit21-20260917` | 2026-09-17 16:52:31 -0700 PDT | 317.6MB | `800348c4b4c8` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit22-20260917` | 2026-09-17 17:16:46 -0700 PDT | 317.6MB | `d71b0df69b88` |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit23-20260917` | 2026-09-17 17:40:03 -0700 PDT | 317.6MB | `4e21198041d3` |

Count: **50 tags**, ~13.8 GB of unique layers (shared base layers mean the real reclaim is a little lower).

Recommended local cleanup (keeps every image a container references, the VM-matching tag is re-pullable):

```bash
docker image prune -a --force     # every tag not used by a container
docker builder prune --force      # 20.3 GB BuildKit cache
docker system df
```

To keep the VM-matching `audit24-20260917` tag as a local reference, pull it back afterwards, or prune
the registry tags explicitly:

```bash
docker images --format '{{.Repository}}:{{.Tag}}' \
  | grep 'kavaroutes-wp013/runtime' \
  | grep -v audit24-20260917 \
  | xargs -r docker image rm
```

### Other local candidates (superseded, not part of the VM comparison)

| Image | Size | Status | Why it is stale |
| --- | --- | --- | --- |
| `kavaroutes-hig011-api:latest`, `kavaroutes-hig011-worker:latest` | 443 MB each | no containers | Aug 24 HIG-011 slice, superseded by the promoted runtime image |
| `kavaroutes-wp005-api:latest`, `kavaroutes-wp005-worker:latest` | 1.31 GB each | two ~2-week-old exited WP005 containers | superseded Compose-era builds; remove the Compose project containers first |
| `kavaroutes-cloud-runtime:cld007-local` | 475 MB | no containers | duplicate local tag of the Sep 12 `cld007` digest (the registry copy is already covered above) |
| dangling `9d2407e083f0`, `d02d19d758e5`, `77472f747eb8` | 565 / 565 / 647 MB | `9d2407e0` referenced by the stopped `kr-a010b` container | superseded audit-probe builds |
| `ghcr.io/supabase/edge-runtime:v1.74.2`, `public.ecr.aws/supabase/edge-runtime:v1.74.2` | 1.12 GB each (same image, two tags) | no containers | old Supabase edge-runtime pair |
| `searxng/searxng:latest` | 381 MB | no containers | base image superseded by `searxng-custom:latest`, which is also unused |
| `alpine:latest`, `alpine:3.20`, `hello-world:latest` | 12–20 MB each | no containers | probe images |
| `node:24` | 1.63 GB | no containers | superseded by the digest-pinned Node slim image the credentials container uses |
| `mcr.microsoft.com/playwright:v1.62.1-noble` | 3.52 GB | no containers | keep if the browser lane is still active, otherwise a large reclaim |
| `docker:cli` | 237 MB | no containers | keep if any script relies on it |

## Where the disk actually goes (re-checked 2026-09-19)

`docker system df` is misleading here: its **Images** line said `33.32 GB`, but the per-image rows in
`docker system df -v` add up to only **5.58 GB**. The summary counts layers that the BuildKit cache also
holds, so the same bytes are reported twice. Your "<10 GB of image data" read is the correct one.

Real, de-duplicated content:

| Store | Size | Entries | Notes |
| --- | --- | --- | --- |
| **BuildKit build cache** | **32.86 GB** | 577 | 100% reclaimable, nothing `InUse` |
| **Anonymous volumes** | **11.20 GB** | 112 | 110 of them unlinked to any container |
| Named volumes | 0.77 GB | 11 | `kavaroutes-local_*` (keep), WP005/WP006/supabase fixtures |
| Images (de-duplicated) | 5.58 GB | 8 | what you counted |
| Containers | 0.007 GB | 9 | writable layers |
| **Total content** | **~50.4 GB** | | |

### Build cache breakdown (32.86 GB)

| Layer kind | Entries | Size |
| --- | --- | --- |
| `COPY --from=build` staged output | 229 | 17.85 GB |
| `npm ci` / `tsc` / web build | 32 | 11.63 GB |
| `COPY` of source (build stage) | 284 | 3.03 GB |
| pulled base layers | 5 | 0.33 GB |
| everything else | 27 | 0.02 GB |

It is dominated by repeated `npm ci …` layers of ~469 MB each — roughly 25 of them from the Sep 17
runtime promotions — plus two stale multi-GB entries from ~2 weeks ago. Nothing here is referenced by a
running container; it exists only so an identical rebuild would be fast.

### Anonymous volumes (11.20 GB)

112 volumes, 93 of them ~120 MB, i.e. Postgres data directories created by throwaway `docker run
postgis…` probes. 110 are unlinked (`Links = 0`) and were left behind when their containers were
removed. They are safe to prune; only 2 are still attached.

### The VHDX itself

`docker_data.vhdx` under `%LOCALAPPDATA%\Docker\wsl\disk\` is **69,294,096,384 bytes (~64.5 GiB)**.
A Docker Desktop VHDX is grow-only: deleting images/volumes/cache frees space *inside* the ext4
filesystem but does not shrink the file on Windows. After pruning you must compact it separately, or
Windows keeps showing ~65 GB allocated.

## WP005 / WP006 (`wp0x`) and WP013 (`wp1`)

A name-level check of everything matching `wp0*` / `wp1*` on both stores:

| Item | Where | State | Verdict |
| --- | --- | --- | --- |
| `kavaroutes-wp005-api:latest` | local | built 2026-09-03, 1.31 GB (277.6 MB unique), no running container | stale |
| `kavaroutes-wp005-worker:latest` | local | built 2026-09-03, 1.31 GB (277.6 MB unique), no running container | stale |
| `kavaroutes-wp005-api-1`, `-worker-1`, `-postgres-1` | local | all `Exited (0) 2 weeks ago` | stale containers |
| `kavaroutes-wp006-postgres-1` | local | `Exited (255) 23 hours ago` | stale container |
| `kavaroutes-wp005_wp005-postgres` | local volume | 113.5 MB, linked to the exited WP005 postgres | removable with the project |
| `kavaroutes-wp005-verify-20260824_wp005-postgres` | local volume | 111.9 MB, **orphan** (that compose project no longer exists) | removable |
| `kavaroutes-wp006_wp006-postgres` | local volume | 368.6 MB, linked to the exited WP006 postgres | removable with the project |
| `kavaroutes-wp005_default`, `kavaroutes-wp006_default` | local networks | both `bridge`, no running endpoints | removable |
| compose project `kavaroutes-wp005` | local | `exited(3)` | stale |
| compose project `kavaroutes-wp006` | local | `exited(1)` | stale |
| `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:*` | local + VM | the promoted runtime repository | **not stale** — this is WP013, the live work package |
| anything `wp005`/`wp006` | VM | none | — |

**WP0x (WP005/WP006) are old local Postgres/Compose verification fixtures**, not part of the deployment:

- WP005 has two hand-built app images (`infra/wp005/api.Dockerfile`, `infra/wp005/worker.Dockerfile`) from Sep 3.
- WP006 has **no app image at all** — `infra/wp006/compose.yaml` only starts a pinned PostGIS container.
- Neither project has run in at least two weeks; only their Postgres volumes still hold data.
- Estimated reclaim if the whole WP0x fixture set is dropped: **~1.1 GB** (2 images ≈ 555 MB unique + 3 volumes ≈ 594 MB).

**WP1 (WP013) is the current one.** `kavaroutes-wp013` is just the Artifact Registry repository name; every
`audit*` / `sol*` / `driver-*` image lives under it. The one to keep is the accepted `audit24-20260917`
(`faf8d862…`) already called out above — the rest of that repository's local tags are the stale promotion
targets listed in the previous section.

Cleanup for the WP0x fixtures (destructive — drops the WP005/WP006 Postgres data):

```bash
docker compose -f infra/wp005/compose.yaml down -v
docker compose -f infra/wp006/compose.yaml down -v
docker volume rm kavaroutes-wp005-verify-20260824_wp005-postgres   # orphaned verify volume
docker image rm kavaroutes-wp005-api:latest kavaroutes-wp005-worker:latest
docker network rm kavaroutes-wp005_default kavaroutes-wp006_default
```

`infra/wp005/` and `infra/wp006/` are tracked in git, so the Docker cleanup does not delete the fixtures —
they can be rebuilt/re-created from source whenever they are needed again.

## Leftover audit-probe containers: `kr-a010b`, `kr-a010-db3`, `kr-cq010-db`

These three are hand-run cloud-audit probes, not part of any Compose project or tracked script
(nothing in the repo references `a010` or `cq010`). They survive because a stopped container pins its
image and volumes.

| Container | Image | Created | State | Attached storage |
| --- | --- | --- | --- | --- |
| `kr-a010b` | `sha256:9d2407e083f0` (dangling kavaroutes runtime, `node infra/gcp/runtime/main.mjs api …`) | 2026-09-17T04:08:16Z | `Exited (255)`, no restart | bind `/tmp/kr-a010b-secrets` (now empty), host network |
| `kr-a010-db3` | `postgis/postgis:17-3.5@sha256:624f5195…` | 2026-09-17T04:06:50Z | `Exited (255)`, no restart | anonymous volume `02eb4b73…` — 118.9 MB |
| `kr-cq010-db` | `postgis/postgis:17-3.5@sha256:624f5195…` | 2026-09-17T04:18:32Z | `Exited (255)`, no restart | anonymous volume `52a027be…` — 105 MB |

All three were killed at the **same instant** (`FinishedAt 2026-09-17T14:18:34Z`) — that is the Docker/WSL
daemon restart, not a clean shutdown, which is why each carries exit code 255.

Nothing else references them: each anonymous volume is linked only to its own container, and the
kavaroutes image `9d2407e083f0` has no tags and no other user, so it becomes dangling the moment
`kr-a010b` is removed. **The VM has none of these.**

Reclaim: ~224 MB of Postgres volumes + ~565 MB of dangling runtime image + a few kB of container layers
≈ **~790 MB**.

Cleanup (order matters — the image cannot be removed while `kr-a010b` exists):

```bash
docker rm kr-a010b kr-a010-db3 kr-cq010-db
docker image rm 9d2407e083f0
docker volume rm 02eb4b732f2947c90e9f6560b2b384e550a2baf0a9d950bfa65403aba7935be6 \
                52a027be7571e885042602d0cfa8fddc023d4e39919a16d7e7b528e180cbb41c
rm -rf /tmp/kr-a010b-secrets    # already empty
```

## What should be removed — ranked

1. **VM: 48 unused runtime images → ~9.68 GB.** Zero-risk: the running stack pins its image by digest.
2. **Local: 50 stale kavaroutes runtime tags → ~13.8 GB unique.** All older than the VM's accepted build.
3. **Local: 32.9 GB BuildKit cache** (`docker builder prune --force`) — the single biggest consumer; regenerable. See the disk-usage section above.
4. **Local: superseded project/tool images** — HIG-011, the WP005/WP006 (`wp0x`) fixture images/volumes (~1.1 GB, see the section above), cld007-local, the Supabase edge-runtime pair, `node:24`, `searxng/searxng`, the probe images.
5. **Local: 11.2 GB of orphaned anonymous volumes** (`docker volume prune --force`) — Postgres data from disposable probes.
6. **Local: the three `kr-*` audit-probe containers** (`kr-a010b`, `kr-a010-db3`, `kr-cq010-db`) **→ ~790 MB**, including the dangling `9d2407e0` image and two anonymous Postgres volumes — see the section above.

## Do not remove

- VM: `sha256:faf8d862…` (accepted runtime) and `postgis/postgis:17-3.5@sha256:624f5195…`.
- VM: `/opt/kavaroutes/runtime/vm.env`, `vm.env.pre-*` and `/opt/kavaroutes/backups/*.dump`.
- Local: `kavaroutes-local-runtime:dev`, `kavaroutes-local-web:dev`, `postgis/postgis:17-3.5`, the Node digest the credentials container uses.
- Local: `us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:audit24-20260917` — the only local image matching the VM.
- Registry: deleting a local/VM image never deletes the registry tag; the accepted `vm.env` digest stays pullable.

## Caveats

- Docker reports per-image *unique* size; the runtime images share most base layers, so summing unique sizes
  slightly over-estimates the space freed when they are deleted together. `docker system df` afterwards is authoritative.
- Local `docker image prune -a` does **not** remove images referenced by stopped containers. The WP005 and
  `kr-a010b` images survive until those containers are removed, even though they are stale.
- The VM image store is separate from `us-west1-docker.pkg.dev`; pruning the VM does not delete registry tags
  and does not affect the accepted `vm.env` digest.

## Reproduce

```bash
# local
docker images --no-trunc --format '{{.Repository}}|{{.Tag}}|{{.ID}}|{{.CreatedAt}}|{{.Size}}|{{.Digest}}'
docker system df -v

# VM
export CLOUDSDK_CONFIG=/home/chewy/kavaroutes/.tooling/gcloud-config
gcloud compute ssh kavaroutes-dev-01 --project=kavaroutes --zone=us-west1-b --tunnel-through-iap \
  --command="sudo cat /opt/kavaroutes/runtime/vm.env; sudo docker ps; sudo docker system df"
```
