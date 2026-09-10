# Spellbook tab update

Apply from the existing vtt project root:

```bash
unzip -o ~/Downloads/spellbook-tab-update.zip -d .
node run-tests.js unit
```

Then hard-refresh the browser. The archive merges into public/ and replaces matching files; it does not include or remove unrelated project files. It includes the previous inventory controls update.

Changes:
- Spellbook tab beside Inventory, with the existing controls moved into the sheet.
- Themed spell and source dropdowns, plus Learn spell.
- Level-grouped learned spells, school/source labels, description snippets, and full read views on name activation.
- Prepared toggles and confirmed Forget spell in the More actions disclosure.
- Learned/prepared counts; only spells not already learned remain in the picker.
- GM/owning-player actions; read-only views for other PCs; projected NPC books remain unavailable.
- Inline request errors, duplicate-submit prevention, captured actor IDs, and stale-response protection.
- Sheet refresh preserves the active tab. Tab changes preserve the character draft.
- Empty books and unavailable books have distinct states. No spell-slot automation or schema changes.

Files: public/game.html, public/actors.html, public/js/actors.js, public/js/sheet.js, public/css/inventory.css, public/css/spellbook.css, test-actors-ui.js, test-sheet-ui.js, test-game-ui.js.

Validation: 19 unit/UI suites passed (1664 assertions). A final empty-state correction and regression check were then verified in the actor UI suite (185 passed, 0 failed). Harness ID union is now 154. No database suites or browser visual QA were run.
