# Images library redesign

- Two-column artwork gallery with larger, uncropped thumbnails, readable filenames, category and source labels.
- Click a thumbnail to open a large preview with keyboard-accessible Close.
- Category filters: All images, Portraits, Token art, Item art, Maps, Avatars, Campaign covers.
- Search by filename or category; combines with category filtering and updates the result count.
- Upload and pasted-link controls live in an Add image disclosure. New-image category uses the shared themed dropdown.
- Copy URL and trash controls use the app's button styling. Deletion is confirmed and offered to the image owner or campaign GM as appropriate.
- External thumbnails retain no-referrer; broken thumbnails have a readable fallback.
- Existing data model and upload endpoints are unchanged. No migration needed.
- Static harness ID union remains 155; image controls are created dynamically.

Install from the vtt repository root:

    unzip -o ~/Downloads/images-library-update.zip -d .
    node run-tests.js unit

Hard-refresh the game page after installing.
