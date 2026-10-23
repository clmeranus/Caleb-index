# The Caleb Index

A members-only register of people named Caleb. People apply with a username and
password, a reviewer verifies their name, and verified members get a permanent,
sequential **Caleb Number** and access to the searchable index.

## How membership works

1. **Apply** at `/register`: choose a username and password, fill in a listing, and
   explain how your name can be verified (for example, a link to a public profile
   that shows your name, or someone who can vouch for you).
2. **Wait for review.** Applicants can log in, but they only see their application
   page (`/pending`), where they can update their details.
3. **An admin reviews** each application at `/admin` and approves or rejects it,
   optionally giving a reason. Rejected applicants see the reason and can resubmit.
4. **Approved members** get the next Caleb Number and can browse the index, profiles
   and statistics, and edit their own listing at `/account`.

Every page except login and sign-up requires a logged-in, verified member. Only
reviewers see an applicant's username and verification evidence. Other members
see the listing fields only.

Name verification here is a human review of the evidence an applicant provides.
It does not check official ID documents.

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
| `ADMIN_USERNAME` | (unset)     | Admin account to create, or an existing account to promote     |
| `ADMIN_PASSWORD` | (unset)     | Password used when the admin account is first created          |
| `COOKIE_SECURE`  | (unset)     | Set to `1` to mark the session cookie `Secure` (HTTPS only)    |

The admin account is created on first start. After that, `ADMIN_PASSWORD` is not
needed, and changing it has no effect: change the password from the account page.
If you are a Caleb yourself, you can apply like anyone else and then restart with
`ADMIN_USERNAME` set to your username to make yourself the admin.

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
| `GET`    | `/api/admin/pending`              | admin               | Applications awaiting review                  |
| `POST`   | `/api/admin/members/:id/verify`   | admin               | Approve and assign a Caleb Number             |
| `POST`   | `/api/admin/members/:id/reject`   | admin               | `{ reason }`                                  |
| `DELETE` | `/api/calebs/:number`             | admin               | Remove a member                               |

## Layout

```
src/db.js        storage, validation, passwords, sessions, verification
src/server.js    HTTP server, access control, API routes, static files
public/          pages (login, register, pending, index, caleb, stats, account, admin)
test/            API tests (node:test)
```
