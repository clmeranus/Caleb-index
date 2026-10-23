# The Caleb Index

A members-only register of people named Caleb. People apply with a username and
password, a reviewer verifies their name, and verified members get a permanent,
sequential **Caleb Number** and access to the searchable index.

## How membership works

1. **Apply** at `/register`: choose a username and password and fill in a listing.
2. **Get verified** in either of two ways, from the application page (`/pending`):
   - **Vouching.** Verified members see open applications under `/applicants` and can
     vouch for people they know. Two vouches (configurable) approve the applicant
     automatically. Admins can see who vouched for whom, and a rejection clears an
     applicant's vouches.
   - **Admin review.** An admin checks the optional evidence the applicant gave
     (for example, a link to a profile that shows their name) at `/admin` and approves
     or rejects it. Rejected applicants see the reason and can resubmit.
3. **Verified members** get the next Caleb Number and can browse the index, profiles,
   statistics and applicants, and edit their own listing at `/account`.

Every page except login and sign-up requires a logged-in member, and everything but the
application page requires a verified one. Only admins see usernames and verification evidence.

## Admins

There are three roles:

- **Owner:** the account named by `ADMIN_USERNAME`. An admin that nobody else can demote or remove.
- **Admin:** can review applications, remove members, and give or take away admin permission.
- **Member:** everyone else.

To make someone an admin, open their profile while logged in as an admin and tick
**Admin permission**. The checkbox only appears for admins, and never on your own
profile or the owner's. Profiles of admins show an "Admin" badge to all members.

## Security

- Passwords are hashed with scrypt and a per-user salt. Plain passwords are never stored.
- Sessions use a random token in an `HttpOnly`, `SameSite=Lax` cookie and last 30 days.
  Only a hash of the token is stored. Changing your password logs out your other devices.
- Write requests must be sent as JSON, which blocks cross-site form submissions.
- Rate limits: 5 sign-ups per hour per IP, and 10 login attempts per 15 minutes per
  IP and username. There's also a honeypot field against bots.
- Set `COOKIE_SECURE=1` when serving over HTTPS (always do this in production).

## Running it

Requires Node.js 22.13 or newer. There are no npm dependencies: it uses Node's built-in
HTTP server, crypto and SQLite.

```sh
ADMIN_USERNAME=admin ADMIN_PASSWORD='a long secret password' npm start   # http://localhost:3000
npm test
```

| Variable         | Default     | Purpose                                                        |
| ---------------- | ----------- | -------------------------------------------------------------- |
| `PORT`           | `3000`      | Port to listen on                                              |
| `DATABASE_PATH`  | `calebs.db` | SQLite database file                                           |
| `ADMIN_USERNAME` | (unset)     | Owner account to create, or an existing account to promote     |
| `ADMIN_PASSWORD` | (unset)     | Password used when the owner account is first created          |
| `COOKIE_SECURE`  | (unset)     | Set to `1` to mark the session cookie `Secure` (HTTPS only)    |
| `VOUCHES_REQUIRED` | `2`       | Vouches needed to approve an applicant                         |
| `TRUST_PROXY_HOPS` | `0`       | Reverse proxies in front of the app; used to find visitors' IPs for rate limits |
| `CLIENT_IP_HEADER` | (unset)   | Header your host's proxy sets to the visitor's IP (`Fly-Client-IP` on Fly.io) |

The owner account is created on first start. After that, `ADMIN_PASSWORD` is not
needed, and changing it has no effect: change the password from the account page.
If you are a Caleb yourself, you can apply like anyone else and then restart with
`ADMIN_USERNAME` set to your username to make yourself the owner.

## Deploying to Fly.io

The repository includes [`fly.toml`](fly.toml) and a `Dockerfile`.

1. **Owner account.** In the Fly dashboard, open the app's **Secrets** and add
   `ADMIN_USERNAME` and `ADMIN_PASSWORD`, or run
   `fly secrets set ADMIN_USERNAME=you ADMIN_PASSWORD='a long password'`.
2. **Deploy** with the dashboard's **Deploy app** button, or `fly deploy`. The first
   deploy creates the `caleb_data` volume that holds the database.
3. **One machine only.** The database is a file on a volume, and a volume belongs to a
   single machine. If the **Machines** tab shows more than one machine, remove the
   extras (or run `fly scale count 1`), or members will be split between databases.
4. Log in at `https://caleb-index.fly.dev`, then delete the `ADMIN_PASSWORD` secret.
   It's only needed the first time, and you can change your password from the account page.

The app stops when idle and starts on the next visit, so the first page after a quiet
spell takes a moment to load. The volume and machine are in Amsterdam (`ams`); to move
them closer to your members, change `primary_region` before the first deploy.

Rate limits are counted per visitor IP. On Fly the app reads it from the `Fly-Client-IP`
header, which Fly's proxy sets (`CLIENT_IP_HEADER` in `fly.toml`). On other hosts,
`TRUST_PROXY_HOPS` reads it from `X-Forwarded-For` instead.

## API

| Method   | Path                              | Who                 | Notes                                         |
| -------- | --------------------------------- | ------------------- | --------------------------------------------- |
| `POST`   | `/api/auth/register`              | anyone              | Apply; logs you in                            |
| `POST`   | `/api/auth/login`                 | anyone              | `{ username, password }`                      |
| `POST`   | `/api/auth/logout`                | logged in           |                                               |
| `GET`    | `/api/me`                         | logged in           | Your account and application status           |
| `PATCH`  | `/api/me`                         | logged in           | Edit listing; resubmits a rejected application |
| `POST`   | `/api/me/password`                | logged in           | `{ current_password, new_password }`          |
| `DELETE` | `/api/me`                         | logged in           | `{ password }`                                |
| `GET`    | `/api/calebs`                     | verified member     | `q`, `spelling`, `country`, `sort`, `limit`, `offset` |
| `GET`    | `/api/calebs/:number`             | verified member     |                                               |
| `GET`    | `/api/stats`                      | verified member     |                                               |
| `GET`    | `/api/spellings`                  | anyone              | Accepted spellings of the name                |
| `GET`    | `/api/config`                     | anyone              | Number of vouches required                    |
| `GET`    | `/api/applicants`                 | verified member     | Open applications, with vouch counts          |
| `POST`   | `/api/applicants/:id/vouch`       | verified member     | Vouch; may approve the applicant              |
| `DELETE` | `/api/applicants/:id/vouch`       | verified member     | Withdraw a vouch                              |
| `PUT`    | `/api/calebs/:number/admin`       | admin               | `{ "admin": true }` or `{ "admin": false }`   |
| `GET`    | `/api/admin/pending`              | admin               | Applications awaiting review                  |
| `POST`   | `/api/admin/members/:id/verify`   | admin               | Approve and assign a Caleb Number             |
| `POST`   | `/api/admin/members/:id/reject`   | admin               | `{ reason }`                                  |
| `DELETE` | `/api/calebs/:number`             | admin               | Remove a member                               |

## Layout

```
src/db.js        storage, validation, passwords, sessions, verification, vouching
src/server.js    HTTP server, access control, API routes, static files
public/          pages (login, register, pending, index, caleb, stats, applicants, account, admin)
test/            API tests (node:test)
```
