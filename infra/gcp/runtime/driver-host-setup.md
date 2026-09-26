# Driver host and business driver admins

`driver.kavaroutes.com` uses the existing `kavaroutes` Cloudflare Tunnel with a
Published application route to `http://127.0.0.1:58080`. The Driver hostname
must have no Cloudflare Access application. Keep Access on `app.kavaroutes.com`
and `admin.kavaroutes.com`. The gateway serves only the separate Driver bundle,
the driver login and work APIs, and the business driver-admin API. All other
paths, including Dispatch, return 404.

The business driver-admin login is separate from a driver's own credential and
from the platform admin dashboard. Admin records are stored as scrypt hashes in
`/opt/kavaroutes/secrets/driver-admins.json` on the VM, readable by the API
container and not served by either web host. The VM provisioning command reads
the new password from stdin so it never appears in shell history:

```
sudo python3 /opt/kavaroutes/web/provision-driver-admin.py \
  /opt/kavaroutes/secrets/driver-admins.json BUSINESS_UUID ADMIN_LOGIN_ID
```

The deployment bundle's copy of the helper is at
`infra/gcp/runtime/provision-driver-admin.py`; install it on the VM before
using that command for another business. Provision each business with its own
business UUID and unique admin login ID. For `test_pony`, the seeded business
UUID is `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, and the first admin login ID
is `test_pony_admin`. Give the initial password privately to the business
admin. The admin signs in at `/driver-admin`, creates an invitation and gives
the driver the setup link and one-time code. Existing active drivers such as
Joel keep their current login ID and password at `/driver`; no migration or
reset of driver credentials is required.

Driver sessions are process-local and expire after 12 hours. Restarting the
API asks drivers to sign in again. The native app sends the same DriverSession
for background GPS; it never needs a Cloudflare Access cookie.
