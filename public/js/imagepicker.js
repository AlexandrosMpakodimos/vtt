// Image picker — choose a stored image, or add one, from anywhere that takes
// an image URL.
//
// Four fields consume an image address: the new-character form, the token
// placement bar, the scene's map, and the character sheet. Before this, every
// one of them was a text box, so the workflow was "upload on one page, copy the
// URL, navigate to another page, paste it". The images existed; nothing could
// reach them.
//
// ---------------------------------------------------------------------------
// WHY A MODULE RATHER THAN A PANEL PER PAGE
// ---------------------------------------------------------------------------
// The alternative was to copy the library markup into each page that needs it.
// That would mean the upload conversation — presign, PUT direct to the bucket,
// confirm — existing in three places, and the three drifting. This project has
// spent several audits on rules that were correct in one place and absent in
// another; duplicating an upload flow across pages is the same trap with a
// different subject.
//
// So the picker BUILDS ITS OWN DOM on first use and appends it to the document.
// A page opts in with one script tag and one button. Nothing is added to any
// page's markup, which matters because two of the three call sites are covered
// by jsdom suites that assert on the elements those pages contain.
//
// It degrades honestly: a page that does not load this file still has a working
// text field, and a call site checks for the global before offering the button.
// The picker is a convenience over the field, never a replacement for it —
// pasting a URL directly remains supported, and remains the only option when
// storage is unconfigured.

(function imagePickerModule() {
  const KINDS = ['portrait', 'token', 'item', 'map', 'avatar', 'cover'];

  let root = null;
  let state = null;   // { campaignId, kind, onChoose }
  let assets = [];

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  function el(tag, opts = {}) {
    const n = document.createElement(tag);
    if (opts.text !== undefined) n.textContent = opts.text;
    if (opts.cls) n.className = opts.cls;
    return n;
  }

  // Styles are injected rather than added to each page's stylesheet, for the
  // same reason the markup is: a page opts in with a script tag and nothing
  // else. Scoped under one class so nothing here can affect a host page.
  function ensureStyles() {
    if (document.getElementById('vtt-picker-style')) return;
    const style = document.createElement('style');
    style.id = 'vtt-picker-style';
    // Themed to match the app's dialogs (the ID card in particular): dark surface,
    // gold accents, the page's own font. Draws entirely from the shared tokens so
    // it follows light/dark. Scoped under .vttpick so nothing leaks to host pages.
    style.textContent = `
      .vttpick-back { position: fixed; inset: 0; background: var(--scrim, rgba(0,0,0,0.55));
                      -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
                      z-index: 80; display: none; align-items: center; justify-content: center; }
      .vttpick-back.on { display: flex; }
      .vttpick { position: relative; background: var(--surface-raised); color: var(--text);
                 border: 1px solid var(--accent); border-radius: 8px;
                 box-shadow: 0 24px 60px rgba(0,0,0,0.5);
                 padding: 1.6rem 1.8rem; width: 34rem; max-width: 94vw; max-height: 88vh; overflow-y: auto; }
      .vttpick h3 { margin: 0 0 1.1rem; font-size: 1.4rem; text-transform: uppercase;
                    letter-spacing: 0.04em; color: var(--accent); }
      .vttpick .muted { color: var(--text-muted); font-size: 0.78rem; }

      /* Upload + URL rows share one grid template so the two inputs are exactly
         the same width and the two buttons line up. Label spans the top; the
         input and its button share the row below, vertically centred on each
         other (not dropped to the bottom). */
      .vttpick .field-row {
        display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto;
        gap: 0.35rem 0.6rem; align-items: center; margin-top: 0.9rem;
      }
      .vttpick .field-row label { grid-column: 1 / -1; }
      .vttpick label { display: block; font-size: 0.8rem; font-weight: 600; text-transform: uppercase;
                       letter-spacing: 0.05em; color: var(--text-muted); }
      .vttpick input {
        width: 100%; font: inherit; padding: 0.65rem 0.75rem; border-radius: 2px; min-height: 44px;
        border: 1px solid var(--border); background: var(--surface); color: var(--text); box-sizing: border-box;
      }
      .vttpick input:focus-visible { border-color: var(--accent); outline: 2px solid var(--focus); outline-offset: 1px; }
      /* Both action buttons: identical look, identical size, centred on the input. */
      .vttpick .field-row button {
        font: inherit; font-size: 0.8rem; letter-spacing: 0.03em; text-transform: uppercase; cursor: pointer;
        min-width: 7rem; min-height: 44px; border-radius: 3px; align-self: center;
        border: 1px solid var(--accent); background: transparent; color: var(--accent);
      }
      .vttpick .field-row button:hover {
        background: var(--accent); color: var(--on-accent); border-color: var(--accent);
        box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 80%, transparent),
                    0 0 22px color-mix(in srgb, var(--accent) 45%, transparent);
      }
      .vttpick .field-row button:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }

      /* Footer buttons (Clear / Cancel): quieter, they aren't the primary action. */
      .vttpick .foot { display: flex; gap: 0.6rem; margin-top: 1.2rem; }
      .vttpick .foot button {
        font: inherit; font-size: 0.8rem; letter-spacing: 0.03em; text-transform: uppercase; cursor: pointer;
        padding: 0.55rem 0.9rem; min-height: 44px; border-radius: 3px;
        border: 1px solid var(--border); background: transparent; color: var(--text-muted);
      }
      .vttpick .foot button:hover {
        background: var(--accent); color: var(--on-accent); border-color: var(--accent);
        box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 80%, transparent),
                    0 0 22px color-mix(in srgb, var(--accent) 45%, transparent);
      }
      .vttpick .foot button:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }

      /* Modal close ✕ — styled like the account modal's .card-close. */
      .vttpick-close {
        position: absolute; top: 0.6rem; right: 0.6rem; width: 44px; height: 44px;
        display: grid; place-items: center; padding: 0;
        background: transparent; border: none; color: var(--text-muted);
        font-size: 1.5rem; line-height: 1; cursor: pointer; border-radius: 2px;
      }
      .vttpick-close:hover { color: var(--accent); }

      /* Image carousel: a single horizontal row that scrolls when it overflows. */
      .vttpick-grid { display: flex; flex-wrap: nowrap; gap: 0.7rem; margin-top: 1.1rem;
                      overflow-x: auto; padding-bottom: 0.4rem; scroll-snap-type: x proximity; }
      .vttpick-item {
        position: relative; flex: 0 0 auto; width: 7.5rem; scroll-snap-align: start;
        border: 1px solid var(--border); border-radius: 4px; padding: 0.35rem;
        cursor: pointer; background: var(--surface); line-height: 0;
      }
      .vttpick-item:hover { border-color: var(--accent);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent); }
      .vttpick-item img { width: 100%; height: 4.4rem; object-fit: cover; border-radius: 3px;
                          background: var(--surface-raised); display: block; }
      /* The image currently in use gets a distinct gold outline. */
      .vttpick-item.current {
        border-color: var(--accent);
        box-shadow: 0 0 0 2px var(--accent), 0 0 10px color-mix(in srgb, var(--accent) 35%, transparent);
      }

      /* Per-image delete ✕ — styled like the expanded game modal's .cp-close. */
      .vttpick-del {
        position: absolute; top: 0.3rem; right: 0.3rem; width: 1.6rem; height: 1.6rem; min-height: 0;
        display: flex; align-items: center; justify-content: center; padding: 0; z-index: 1;
        border: none; border-radius: 50%; background: rgba(0,0,0,0.45); color: #fff;
        font-size: 1rem; line-height: 1; cursor: pointer;
        opacity: 0; transition: opacity 0.14s var(--ease);
      }
      .vttpick-item:hover .vttpick-del, .vttpick-del:focus-visible { opacity: 1; }
      .vttpick-del:hover { background: rgba(0,0,0,0.65); color: var(--danger); }
      .vttpick .msg { font-size: 0.8rem; margin-top: 0.6rem; min-height: 1.1rem; }
    `;
    document.head.appendChild(style);
  }

  function build() {
    ensureStyles();
    const back = el('div', { cls: 'vttpick-back' });
    const box = el('div', { cls: 'vttpick' });

    // Top-right close, matching the app's dialogs.
    const xClose = el('button', { cls: 'vttpick-close', text: '\u00d7' });
    xClose.setAttribute('aria-label', 'Close');
    box.appendChild(xClose);

    box.appendChild(el('h3', { text: 'Choose an image' }));

    // Upload row: label (spanning), file input, Upload button — a 2-col grid.
    const upRow = el('div', { cls: 'field-row' });
    upRow.appendChild(el('label', { text: 'Upload a file' }));
    const file = document.createElement('input');
    file.type = 'file';
    // Deliberately the same four types the server allows, and deliberately not
    // SVG. This is a hint rather than a control — the bytes are checked
    // regardless — but a picker that offers a file the server will reject is a
    // picker that wastes an upload.
    file.accept = 'image/png,image/jpeg,image/webp,image/gif';
    file.className = 'vttpick-file';
    upRow.appendChild(file);
    const upBtn = el('button', { text: 'Upload' });
    upRow.appendChild(upBtn);
    box.appendChild(upRow);

    // URL row: same grid template, so the input matches the file input's width
    // and the button lines up under Upload.
    const linkRow = el('div', { cls: 'field-row' });
    linkRow.appendChild(el('label', { text: 'Paste a URL' }));
    const link = document.createElement('input');
    link.placeholder = 'https://example.com/image.png';
    link.className = 'vttpick-link';
    linkRow.appendChild(link);
    const linkBtn = el('button', { text: 'Add URL' });
    linkRow.appendChild(linkBtn);
    box.appendChild(linkRow);

    const msg = el('div', { cls: 'msg muted' });
    box.appendChild(msg);

    const grid = el('div', { cls: 'vttpick-grid' });
    box.appendChild(grid);

    const foot = el('div', { cls: 'foot' });
    const clear = el('button', { text: 'Clear the field' });
    const close = el('button', { text: 'Cancel' });
    foot.appendChild(clear);
    foot.appendChild(close);
    box.appendChild(foot);

    back.appendChild(box);
    document.body.appendChild(back);

    // Clicking the backdrop closes; clicking the panel does not. Same
    // dismissal behaviour a person expects from any modal.
    back.addEventListener('click', (e) => { if (e.target === back) hide(); });
    close.addEventListener('click', hide);
    xClose.addEventListener('click', hide);
    clear.addEventListener('click', () => { choose(''); });
    upBtn.addEventListener('click', () => doUpload(file, msg));
    linkBtn.addEventListener('click', () => doLink(link, msg));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && root && root.back.classList.contains('on')) {
        // Swallow the Escape so it closes ONLY the picker. Without this the same
        // keypress would also reach the host <dialog> and fire its `cancel`,
        // closing the dialog underneath. (common.js's openDialog cancel handler
        // additionally checks isOpen() as a belt-and-braces buckle.)
        e.preventDefault();
        e.stopPropagation();
        hide();
      }
    });

    return { back, grid, msg, file, link };
  }

  function hide() {
    if (root) root.back.classList.remove('on');
    state = null;
  }

  function choose(url) {
    const cb = state && state.onChoose;
    hide();
    if (cb) cb(url);
  }

  async function refresh() {
    const q = state.campaignId ? `?campaign_id=${encodeURIComponent(state.campaignId)}` : '';
    const r = await api('GET', `/api/assets${q}`);
    const campaignAssets = r.data && Array.isArray(r.data.assets) ? r.data.assets : [];

    // Personal images are a separate scope with a separate quota, so they are a
    // separate request. Offered alongside because a profile picture is a
    // perfectly reasonable thing to use as a portrait.
    let personal = [];
    if (state.campaignId) {
      const mine = await api('GET', '/api/assets');
      personal = mine.data && Array.isArray(mine.data.assets) ? mine.data.assets : [];
    }
    assets = [...campaignAssets, ...personal];
    renderGrid();
  }

  function renderGrid() {
    const { grid } = root;
    grid.textContent = '';
    if (!assets.length) {
      grid.appendChild(el('p', { cls: 'muted', text: 'no images yet — upload one or paste a URL' }));
      return;
    }
    for (const a of assets) {
      const isCurrent = state && state.current && a.url === state.current;
      // The `external` class is kept purely as a hook for the referrer policy
      // below — it no longer carries any visual distinction. Tiles show only the
      // image (plus the delete ✕ and the current-image outline).
      const item = el('div', { cls: 'vttpick-item'
        + (a.source === 'external' ? ' external' : '')
        + (isCurrent ? ' current' : '') });
      const img = document.createElement('img');
      img.src = a.url;
      img.alt = '';
      // A pasted link is fetched from a third party by every viewer. This does
      // not hide the viewer's address — nothing can, short of proxying — but it
      // stops this application's URLs being handed to that host.
      if (a.source === 'external') img.referrerPolicy = 'no-referrer';
      item.appendChild(img);
      item.addEventListener('click', () => choose(a.url));

      // Every stored asset (hosted OR pasted-link) is a real row and can be
      // deleted by its owner/GM — the ✕ in the corner.
      if (a.id) {
        const del = el('button', { cls: 'vttpick-del', text: '\u00d7' });
        del.setAttribute('aria-label', 'Delete this image');
        del.addEventListener('click', (e) => {
          e.stopPropagation();          // don't also "choose" the image
          doDelete(a, root.msg);
        });
        item.appendChild(del);
      }

      grid.appendChild(item);
    }
  }

  // Delete a hosted asset: remove the row + object server-side, then drop it from
  // the grid. A 404 means it's already gone (or not ours) — reflect that too.
  function doDelete(asset, msg) {
    if (msg) { msg.textContent = ''; msg.className = 'msg muted'; }
    api('DELETE', '/api/assets/' + asset.id).then((r) => {
      if (r.status === 200 || r.status === 404) {
        assets = assets.filter((x) => x.id !== asset.id);
        renderGrid();
      } else if (msg) {
        msg.textContent = (r.data && r.data.error) || 'Could not delete that image.';
      }
    }).catch(() => { if (msg) msg.textContent = 'Could not delete that image.'; });
  }

  // The three-step upload, in one place. See routes/assets.js for why the
  // middle step does not involve the application at all.
  async function doUpload(fileInput, msg) {
    const f = fileInput.files && fileInput.files[0];
    if (!f) { msg.textContent = 'choose a file first'; return; }

    const body = { kind: state.kind, mime: f.type, bytes: f.size };
    if (state.kind !== 'avatar') {
      if (!state.campaignId) { msg.textContent = 'no campaign loaded'; return; }
      body.campaign_id = state.campaignId;
    }

    msg.textContent = 'requesting authorisation…';
    const pres = await api('POST', '/api/assets/presign', body);
    if (pres.status === 503) {
      msg.textContent = 'image storage is not configured on this server — paste a link instead';
      return;
    }
    if (pres.status !== 201) {
      msg.textContent = (pres.data && pres.data.error) || 'upload was not authorised';
      return;
    }

    msg.textContent = 'uploading…';
    try {
      const put = await fetch(pres.data.upload.url, {
        method: pres.data.upload.method,
        headers: pres.data.upload.headers,
        body: f,
      });
      if (!put.ok) { msg.textContent = `the storage service refused the upload (${put.status})`; return; }
    } catch (err) {
      // A network error here is almost always the bucket's CORS policy or the
      // page's connect-src, neither of which is visible from the server.
      msg.textContent = `upload failed (${err.message}) — check the bucket CORS policy and connect-src`;
      return;
    }

    msg.textContent = 'verifying…';
    const done = await api('POST', `/api/assets/${pres.data.asset.id}/confirm`);
    if (done.status !== 200) {
      msg.textContent = (done.data && done.data.error) || 'verification failed';
      return;
    }

    // Chosen immediately. Somebody who has just uploaded an image into a picker
    // wants that image, and making them find it in the grid afterwards is a
    // step with no purpose.
    fileInput.value = '';
    choose(done.data.asset.url);
  }

  async function doLink(linkInput, msg) {
    const url = linkInput.value.trim();
    if (!url) { msg.textContent = 'paste a link first'; return; }

    const body = { kind: state.kind, url };
    if (state.kind !== 'avatar') {
      if (!state.campaignId) { msg.textContent = 'no campaign loaded'; return; }
      body.campaign_id = state.campaignId;
    }
    const r = await api('POST', '/api/assets/external', body);
    if (r.status !== 201) {
      msg.textContent = (r.data && r.data.error) || 'that link was not accepted';
      return;
    }
    linkInput.value = '';
    choose(r.data.asset.url);
  }

  // open({ campaignId, kind, onChoose })
  //
  // `kind` decides the size limit and who may create — a map is GM-only, a
  // portrait follows the same permission as setting one by hand. The picker
  // does not enforce that; the server does, and the picker reports what it says.
  function open(opts) {
    if (!root) root = build();
    state = {
      campaignId: opts.campaignId || null,
      kind: KINDS.includes(opts.kind) ? opts.kind : 'portrait',
      onChoose: typeof opts.onChoose === 'function' ? opts.onChoose : null,
      current: opts.current || null,   // the URL currently in use → gold outline
    };
    // A <dialog> opened with showModal() lives in the browser's top layer, which
    // sits above every normal-flow z-index. A fixed overlay on document.body
    // would therefore render BEHIND the modal and be unclickable. So mount the
    // picker inside the open dialog (also top layer) when there is one; fall
    // back to <body> for pages that use the picker outside any dialog.
    var host = document.querySelector('dialog[open]') || document.body;
    if (root.back.parentNode !== host) host.appendChild(root.back);
    root.msg.textContent = '';
    root.link.value = '';
    root.file.value = '';
    root.back.classList.add('on');
    assets = [];
    renderGrid();
    refresh();
  }

  // Attach a "choose…" button beside a text field. The field keeps working on
  // its own; this only adds a way to fill it without typing.
  function attach(inputOrId, opts) {
    // Accept an element directly (per-card inputs share a class, not an id) or
    // an id string (the original callers).
    const input = (inputOrId && inputOrId.nodeType === 1) ? inputOrId : document.getElementById(inputOrId);
    if (!input || input.dataset.vttPicker) return null;
    input.dataset.vttPicker = '1';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'choose…';
    btn.className = 'vttpick-open';
    btn.addEventListener('click', () => open({
      campaignId: typeof opts.campaignId === 'function' ? opts.campaignId() : opts.campaignId,
      kind: typeof opts.kind === 'function' ? opts.kind() : opts.kind,
      current: input.value || null,      // highlight the image already in the field
      onChoose: (url) => {
        input.value = url;
        // Dispatched so anything listening for edits — a live preview, a dirty
        // flag — reacts exactly as it would to typing.
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        if (opts.onChoose) opts.onChoose(url);
      },
    }));
    input.insertAdjacentElement('afterend', btn);
    return btn;
  }

  // Whether the picker overlay is currently shown. common.js's openDialog cancel
  // handler consults this to decide whether an Escape belongs to the picker (so
  // it should not also close the host dialog).
  function isOpen() { return !!(root && root.back && root.back.classList.contains('on')); }

  window.VTTImagePicker = { open, attach, KINDS, isOpen };
}());
