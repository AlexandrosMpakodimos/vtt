# Virtual Tabletop

A browser-based tabletop for a GM and players: campaigns, scenes, tokens, fog,
characters, inventory, combat, chat and image assets. Built with Node.js/CommonJS,
Express, PostgreSQL/Knex and Socket.IO, with plain HTML/CSS/JavaScript and no
frontend build step.

## Local development

Use a private `.env` with the intended development database and signing secrets.
Never share that file or put real credentials in source. For a new checkout,
install the locked dependencies with `npm ci`, then apply migrations to the
intended development database with `NODE_ENV=development npm run migrate`.
The isolated test database has separate setup and credentials; see the test guide.

For the existing development environment:

```sh
NODE_ENV=development PORT=3000 BASE_URL=http://localhost:3000 MEDIA_HOST=media.test MEDIA_ORIGIN=http://media.test:3000 npm run dev
```

Open `http://localhost:3000`. Configure local resolution of `media.test` separately
for image delivery; setting the variables does not create a DNS/hosts entry.
Normal startup also starts maintenance jobs. `npm start` starts the same server
without nodemon; it does not establish a production configuration.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server through nodemon |
| `npm run dev:test` | Isolated server on `127.0.0.1:3001`, memory storage |
| `npm test` | Unit suites, without an external server/database |
| `npm run test:db` | Integration suites through the isolated wrapper |
| `npm run test:sec` | Adversarial suites through the isolated wrapper |
| `npm run test:all` | All registered suites, sequentially |
| `npm run migrate` | Apply migrations for the selected environment |
| `npm run migrate:make -- NAME` | Create a migration |
| `npm run clean:bucket` | Storage maintenance; read the operational guide first |

## Maintainer guide

- [Architecture and repository layout](docs/architecture.md)
- [Permission, transaction and socket contracts](docs/invariants.md)
- [Tests, fixtures and isolation](docs/testing.md)
- [Configuration, operations and deployment backlog](docs/deployment.md)

The application is locally tested; public deployment remains unfinished.
Historical audit evidence is in [the audit archive](docs/history/authorization-audit.md).
Current verification records belong in the test guide and the relevant PR.

Share committed source with `git archive`, not a ZIP of the working directory.
Installed dependencies, private configuration, local diagnostics and recovery
backups do not belong in source packages. Git archives contain tracked files;
ignore rules alone do not remove a file that was already tracked.
