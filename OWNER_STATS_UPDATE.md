# Owner stat editing

From the project root, apply:

```bash
unzip -o ~/Downloads/owner-stats-update.zip -d .
node run-tests.js unit
```

Restart the app server to load the updated server permissions, then hard-refresh the browser. No database migration is required.

Players can edit level, class, ancestry, size, max HP, AC, speed, all six ability scores, current/temp HP, death saves, and descriptive fields on characters they control. The server accepts the same gameplay fields on creation. The simple player creation modal remains an initial setup; all stats can be completed in the sheet.

Ownership assignment, PC/NPC status, and party membership remain GM-managed. Editing other players' characters is still refused. Existing bounds, types, and NPC projections are preserved.

Validation: the updated sheet suite passes 183 checks; the other 18 UI suites passed. test-actors.js was updated to cover owner stat creation/editing, invalid stat values, management restrictions, and other-character protection. Run it locally with the restarted server and Postgres:

```bash
SKIP_HIBP=1 node test-actors.js
```

Database tests and browser visual QA were not run in the sandbox.
