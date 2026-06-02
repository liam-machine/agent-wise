# Wiseway Mock Phone+PIN OIDC Provider (`wiseway-idp`)

A **simulated** OpenID Connect identity provider for the Wiseway Staff Assistant
demo. It looks and behaves like a real corporate "staff sign in" — a mobile
number + PIN page — and issues a standards-compliant OIDC ID token. It performs
**no real authentication and provides no real security**. It exists so the demo
can show role-scoped access (warehouse / driver / office / hr-admin) flowing
from login → LibreChat → the role-gated document search, without standing up a
real identity system.

Built on [`node-oidc-provider`](https://github.com/panva/node-oidc-provider) v9
+ Express.

- **Service name:** `wiseway-idp`
- **Host port:** `9000`
- **Issuer:** `http://host.docker.internal:9000` (see the caveat below — this is
  the important part)
- **Client:** LibreChat only
  - `client_id`: `librechat`
  - `client_secret`: `wiseway-demo-secret`
  - `redirect_uri`: `http://localhost:3080/oauth/openid/callback`
  - `scopes`: `openid profile email`

## ID token claims

After a successful login the ID token carries:

| Claim                | Value                                              |
| -------------------- | -------------------------------------------------- |
| `sub`                | stable per-user subject, e.g. `wiseway\|0412345678` |
| `name`               | display name, e.g. `Sam Tran (Warehouse)`          |
| `email`              | e.g. `sam.tran@wiseway.demo`                        |
| `preferred_username` | the **mobile number** (LibreChat's username claim) |
| `role`               | the business role string (see below)               |

`role` is the business/demo role. **LibreChat does not use the OIDC `role`
claim to set its own user role** — its OIDC strategy lands every new user as
LibreChat role `USER`. The business role (`warehouse` / `driver` / `office` /
`hr-admin`) that gates document access is the **user-document role string seeded
in Mongo per user**, which then flows to the MCP doc-search tool via
`{{LIBRECHAT_USER_ROLE}}`. See the orchestration `README.md` for the
`seed-roles.sh` step. (The `role` claim is still emitted here so the seed step
can be cross-checked, and so a future LibreChat version that maps it can pick
it up.)

## Demo staff logins

| Mobile        | PIN    | Role        | Name                    | Email                    |
| ------------- | ------ | ----------- | ----------------------- | ------------------------ |
| `0412345678`  | `1234` | `warehouse` | Sam Tran (Warehouse)    | sam.tran@wiseway.demo    |
| `0423456789`  | `2345` | `driver`    | Dee Okafor (Driver)     | dee.okafor@wiseway.demo  |
| `0434567890`  | `3456` | `office`    | Olivia Park (Office)    | olivia.park@wiseway.demo |
| `0445678901`  | `4567` | `hr-admin`  | Hannah Reed (HR Admin)  | hannah.reed@wiseway.demo |

The sign-in page also shows a small "Demo simulation" hint with two of these
logins, so anyone driving the demo can sign in without this README.

## The `host.docker.internal` issuer caveat (read this)

OIDC requires that the **issuer string is identical everywhere**:

1. the value the **browser** is redirected to during the authorization request, and
2. the value **LibreChat** (running inside Docker) validates the discovery
   document and ID token against (`OPENID_ISSUER`).

Both are set to `http://host.docker.internal:9000`.

- **Inside containers**, Docker Desktop already resolves
  `host.docker.internal` to the host, so LibreChat can reach the IdP and
  validate the issuer with no extra setup.
- **The macOS browser does not** resolve `host.docker.internal` by default —
  it has no idea what that host is. During the login redirect the browser is
  sent to `http://host.docker.internal:9000/...`, so the browser must resolve
  it too, to the **same** host (your Mac, `127.0.0.1`).

If you instead used `localhost:9000` for the browser and
`host.docker.internal:9000` for the container, the two issuer strings would
differ and OIDC validation would fail with an issuer mismatch. So both sides
use the single string `http://host.docker.internal:9000`, and you make the
browser resolve it by adding one line to your hosts file:

```sh
# one-time, on the macOS host:
echo "127.0.0.1 host.docker.internal" | sudo tee -a /etc/hosts
```

After that line is present, `http://host.docker.internal:9000` resolves to your
Mac in the browser **and** to the host inside containers — one issuer string,
valid in both places.

> Quick check: `curl http://host.docker.internal:9000/.well-known/openid-configuration`
> from your Mac should return JSON whose `"issuer"` is
> `http://host.docker.internal:9000`.

## Run it

In the demo this runs as the `wiseway-idp` service from the top-level
`docker-compose.yml`. To run it standalone for development:

```sh
# from this directory
npm install
npm start
# -> mock OIDC provider listening on :9000
#    discovery = http://host.docker.internal:9000/.well-known/openid-configuration
```

Environment variables:

| Var      | Default                             | Notes                                   |
| -------- | ----------------------------------- | --------------------------------------- |
| `ISSUER` | `http://host.docker.internal:9000`  | Must match LibreChat `OPENID_ISSUER`.   |
| `PORT`   | `9000`                              | Listen port (also `EXPOSE`d in Docker). |

## Endpoints

- Discovery: `/.well-known/openid-configuration`
- JWKS: `/jwks`
- Authorization: `/auth`
- Token: `/token`
- UserInfo: `/me`
- Login UI (custom): `/interaction/:uid`

## Files

| File                | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `server.js`         | Express + `oidc-provider` setup, custom phone+PIN interaction, claims.  |
| `staff.js`          | The four demo staff (mobile → pin/role/name/email/sub) + auth helpers.  |
| `views/login.html`  | Wiseway-branded "Staff Sign In" page (EJS template, inline CSS).        |
| `package.json`      | Deps (`express`, `oidc-provider`, `ejs`) + `start` script.             |
| `Dockerfile`        | `node:20-alpine` image, `EXPOSE 9000`, `CMD node server.js`.            |

## Notes / not-for-production

- The RSA signing key and cookie key in `server.js` are **committed demo
  throwaways**, not secrets. Never reuse them anywhere real.
- There is no rate limiting, no account lockout, no PIN hashing — it is a
  simulation. Do not point anything real at it.
