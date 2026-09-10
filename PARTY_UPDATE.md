# Player navigation and party roster

Apply this update on top of the previous character-card and spellbook updates.

1. Stop the running app server before replacing server files.
2. From the vtt project root:

```bash
unzip -o ~/Downloads/party-roster-update.zip -d .
npm run migrate
node run-tests.js unit
```

3. Restart the server with your usual command, then hard-refresh the browser.
4. As GM, use Add to party on the character cards to choose party members. Clicking In party removes that membership. Type and ownership are unchanged.
5. With your local server and Postgres running, run the updated database suite:

```bash
SKIP_HIBP=1 node test-actors.js
```

The migration adds actors.in_party (default false). The party initially starts empty; existing archived characters are not automatically enrolled. New characters require the GM to add them too. The migration must run before the new party actions are used.

Players have only Chat & Dice and Characters in the sidebar, with evenly distributed tab widths and keyboard navigation that skips Library. Their character roster includes only party members. The GM retains Library and the entire roster, plus All / In party / Not in party filter chips.

Party membership is separate from ownership and statistic disclosure. Party NPCs appear even when they have no map token, but their statistics, inventory and spellbook remain private. Non-party token-linked actors still function on the canvas. This is a roster/navigation change, not a new restriction on catalogue endpoints used by inventory and spell learning.

Membership is validated and writable only by the GM. Party changes and deletion trigger a roster refresh without broadcasting private actor contents. Existing create/edit/delete and draft protection remain intact.

Validation: 19 unit/UI suites passed, 1693 assertions, 0 failed; expanded test-actors.js covers party defaults, GM authoring, player and stranger refusals, off-map NPC list/detail projections, inventory/spellbook privacy, removal, and socket invalidation. Database tests and browser visual QA require local verification.
