# The Caleb Index

A public register of people named Caleb. Each Caleb who signs up gets a permanent,
sequential **Caleb Number**, a profile page, and a place in the searchable index.

## Features

- **Index**: browse, search (surname, place, occupation, bio), filter by spelling, and sort.
- **Register**: only the first name is required. Caleb and recognized spellings
  (Kaleb, Calev, Kalev, Cayleb, Calebe, …) are accepted; other names are rejected.
- **Profiles**: one page per Caleb at `/caleb?n=<number>`.
- **Self-service edits**: registering returns a one-time edit key, which lets the Caleb
  edit or remove their own entry. Only a hash of the key is stored.
- **Statistics**: counts by spelling, country, and decade of birth.
- **Spam protection**: a rate limit of 5 registrations per hour per IP, plus a honeypot field.
- **Moderation**: set `ADMIN_TOKEN` and use it as the edit key to edit or remove any entry.

## Running it

Requires Node.js 22.13 or newer. There are no npm dependencies: it uses Node's built-in
HTTP server and SQLite.

```sh
npm start          # http://localhost:3000
npm test
```

| Variable        | Default     | Purpose                                  |
| --------------- | ----------- | ---------------------------------------- |
| `PORT`          | `3000`      | Port to listen on                        |
| `DATABASE_PATH` | `calebs.db` | SQLite database file                     |
| `ADMIN_TOKEN`   | (unset)     | Master edit key for moderation           |

## API

| Method   | Path                  | Notes                                                   |
| -------- | --------------------- | ------------------------------------------------------- |
| `GET`    | `/api/calebs`         | `q`, `spelling`, `country`, `sort` (`number`, `newest`, `surname`, `oldest`), `limit`, `offset` |
| `POST`   | `/api/calebs`         | Register; returns `{ caleb, token }`                    |
| `GET`    | `/api/calebs/:number` | One entry                                               |
| `PATCH`  | `/api/calebs/:number` | Requires `X-Edit-Token` header                          |
| `DELETE` | `/api/calebs/:number` | Requires `X-Edit-Token` header                          |
| `GET`    | `/api/stats`          | Aggregate statistics                                    |
| `GET`    | `/api/spellings`      | Accepted spellings                                      |

## Layout

```
src/db.js        storage, validation, queries
src/server.js    HTTP server, API routes, static files
public/          pages (index, register, caleb, stats), CSS, and shared JS
test/            API tests (node:test)
```
