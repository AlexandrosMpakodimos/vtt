# Library refinements

- Images reuses the Items search/filter styles: inline search icon, Filter toggle, collapsible category chips and active-filter badge.
- Add image is one visual group with a shared category above the upload and URL alternatives. Both existing request paths use this category.
- The Library scroll container reserves a stable scrollbar gutter across Images, Items and Spells. Browsers without scrollbar-gutter support keep a scrollbar track reserved via overflow-y: scroll.
- Existing category filtering, search and image actions are retained.

Install from the vtt repository root:

    unzip -o ~/Downloads/library-polish-update.zip -d .
    node run-tests.js unit

Hard-refresh the game page. No migration required.

Validation: test-actors-ui.js (224 passed), test-game-ui.js (132 passed).
