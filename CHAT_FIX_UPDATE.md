# Chat and dice fixes

- Speaking-as list now floats outside the blurred sidebar so its screen coordinates are correct. GM and owned-player character selection, and the GM/Player reset, are tested.
- Game chat boot awaits the signed-in user before filtering controlled characters.
- Restore the compact pre-redesign message styles only. Other chat controls and default-open player status stay in place.
- Enable text selection and normal browser copying inside the chat log.
- Right-click a die button or stack tag to subtract one die. Removing the final die removes that stack. The existing × still clears the complete stack.

Install from your vtt folder:

    unzip -o ~/Downloads/chat-dice-fix.zip -d .
    node run-tests.js unit

Hard-refresh the game page to reload the JavaScript and styles. No migration required.
