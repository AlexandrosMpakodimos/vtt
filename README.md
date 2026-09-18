# Virtual Tabletop

A browser-based tabletop application for a GM and players, with campaigns,
scenes, tokens, actors, inventory, combat, chat, and image assets.

The backend uses Node.js/CommonJS, Express, Passport, PostgreSQL/Knex,
express-session/connect-pg-simple, and Socket.IO. The frontend is HTML, CSS,
and browser JavaScript; no frontend build step is configured.

## Current status

The bounded local audit is complete. The September 17, 2026 handoff records
PR #11 as merged and pulled, all 69 suites / 3,772 assertions passing, and
independent GM/player browser checks passing for open, close, and explicit
re-entry after reopening. These are recorded results, not a new run or a
production-readiness certification.

[FINAL-AUDIT-STATUS.md](FINAL-AUDIT-STATUS.md) preserves the audit history;
its final automated-verification section supersedes earlier pending results.
The browser result and merge status above come from the handoff.

The documentation PR is merged. Campaign mutations now use importable operations
and HTTP handlers, with the affected controlled tests importing production code.
Socket-lifecycle extraction remains planned; authentication is unchanged.
See [the bounded plan](docs/architecture.md#bounded-refactoring-plan).

## Local development

Use the existing local PostgreSQL development database and privately configured
`DATABASE_URL` and `SESSION_SECRET`. Do not put real values in documentation,
patches, or terminal output shared for review. The observed working runtime in
the handoff is Node v24.14.0; `package.json` does not declare an engine range.
The tracked lockfile describes dependencies; this documentation does not require
a dependency upgrade or reinstall in an already working checkout.

For a new local checkout, install the locked dependencies with `npm ci`, then
apply migrations to the intended development database with
`NODE_ENV=development npm run migrate`. Do not use these steps to initialize the
isolated test database; see [testing](docs/testing.md).

For the existing development environment, run:

```sh
NODE_ENV=development PORT=3000 BASE_URL=http://localhost:3000 MEDIA_HOST=media.test MEDIA_ORIGIN=http://media.test:3000 npm run dev
```

Open `http://localhost:3000`. Media delivery also needs `media.test` to resolve
locally; the command does not configure DNS or hosts entries. Optional external
storage/email behavior and the remaining production configuration work are
described in [deployment](docs/deployment.md).

## Existing commands

Run commands from the repository root. Test setup and safety requirements are
in [docs/testing.md](docs/testing.md).

| Command | Current purpose |
| --- | --- |
| `npm run dev` | Development server through nodemon |
| `npm start` | Start the same server through Node; does not configure production |
| `npm run dev:test` | Start the isolated server on `127.0.0.1:3001` |
| `npm test` | Registered unit group; no external server or database required |
| `npm run test:db` | Registered database/integration group through the isolated wrapper |
| `npm run test:sec` | Registered adversarial group through the isolated wrapper |
| `npm run test:all` | All registered groups through the isolated wrapper |
| `npm run migrate` | Apply Knex migrations for the selected environment |
| `npm run migrate:make -- NAME` | Create a migration |
| `npm run seed` | Knex seed command; this snapshot contains no seed files |
| `npm run clean:bucket` | Bucket maintenance script; review operational prerequisites first |

## Maintainer guide

- [Architecture and bounded refactoring](docs/architecture.md)
- [Permission, transaction, and socket invariants](docs/invariants.md)
- [Tests and isolation](docs/testing.md)
- [Configuration and deployment backlog](docs/deployment.md)

Existing untracked backups and diagnostic files are outside the source archive.
Review them with their owner before moving, deleting, or staging them. Use
explicit file paths when staging this work, not `git add .` or `git clean`.
