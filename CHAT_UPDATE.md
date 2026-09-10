# Chat update

- Refined conversation log and composer using existing theme colours and controls.
- Speaking as offers the GM/Player role plus controlled characters (GM: all campaign characters). Messages show username (character), or username (GM/Player) when reset. Existing server-side authorization and historical snapshots are retained.
- Refresh speaker choices after actor updates/deletions and party changes; stale choices reset to role.
- Themed whisper recipient checkboxes preserve multiple recipients and offer an Everyone reset. Chat and dice share the same recipients.
- Player status starts open and remains collapsible; refreshes preserve the user's choice.
- Regression coverage for labels, whispers and presence. No static IDs added; harness union remains 155.

Install from your vtt repository root:

    unzip -o ~/Downloads/chat-update.zip -d .
    node run-tests.js unit

Reload the game page. No database migration or server change required.
