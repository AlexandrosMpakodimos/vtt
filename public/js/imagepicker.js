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
    style.textContent = `
      .vttpick-back { position: fixed; inset: 0; background: #0009; z-index: 80;
                      display: none; align-items: center; justify-content: center; }
      .vttpick-back.on { display: flex; }
      .vttpick { background: #fff; border-radius: 6px; padding: 16px; width: 640px;
                 max-width: 92vw; max-height: 86vh; overflow-y: auto;
                 font-family: monospace; }
      .vttpick h3 { margin: 0 0 4px; font-size: 14px; }
      .vttpick .muted { color: #777; font-size: 12px; }
      .vttpick .row { display: flex; gap: 8px; align-items: flex-end; margin-top: 8px; }
      .vttpick .row > div { flex: 1; }
      .vttpick label { display: block; font-size: 11px; margin-bottom: 2px; }
      .vttpick input, .vttpick select { width: 100%; padding: 5px; box-sizing: border-box;
                                        font-family: monospace; }
      .vttpick button { padding: 5px 10px; cursor: pointer; font-family: monospace; }
      .vttpick-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      .vttpick-item { width: 112px; border: 1px solid #ccc; border-radius: 4px; padding: 4px;
                      cursor: pointer; text-align: center; font-size: 11px; background: #fff; }
      .vttpick-item:hover { border-color: #06c; background: #f2f7ff; }
      .vttpick-item img { width: 100%; height: 70px; object-fit: cover; border-radius: 3px;
                          background: #eee; display: block; }
      .vttpick-item.external { border-color: #a40; }
      .vttpick-item.external .src { color: #a40; }
      .vttpick .msg { font-size: 12px; margin-top: 6px; min-height: 16px; }
    `;
    document.head.appendChild(style);
  }

  function build() {
    ensureStyles();
    const back = el('div', { cls: 'vttpick-back' });
    const box = el('div', { cls: 'vttpick' });

    box.appendChild(el('h3', { text: 'Choose an image' }));
    box.appendChild(el('p', {
      cls: 'muted',
      text: 'Click one to use it. An upload goes straight from your browser to the '
          + 'bucket and is checked server-side before it can be used. A pasted link is '
          + 'stored as-is — every player who views it connects to that host directly.',
    }));

    const upRow = el('div', { cls: 'row' });
    const fileWrap = el('div');
    fileWrap.appendChild(el('label', { text: 'upload a file' }));
    const file = document.createElement('input');
    file.type = 'file';
    // Deliberately the same four types the server allows, and deliberately not
    // SVG. This is a hint rather than a control — the bytes are checked
    // regardless — but a picker that offers a file the server will reject is a
    // picker that wastes an upload.
    file.accept = 'image/png,image/jpeg,image/webp,image/gif';
    file.className = 'vttpick-file';
    fileWrap.appendChild(file);
    upRow.appendChild(fileWrap);
    const upBtn = el('button', { text: 'upload' });
    upRow.appendChild(upBtn);
    box.appendChild(upRow);

    const linkRow = el('div', { cls: 'row' });
    const linkWrap = el('div');
    linkWrap.appendChild(el('label', { text: '…or paste a link' }));
    const link = document.createElement('input');
    link.placeholder = 'https://example.com/image.png';
    link.className = 'vttpick-link';
    linkWrap.appendChild(link);
    linkRow.appendChild(linkWrap);
    const linkBtn = el('button', { text: 'add link' });
    linkRow.appendChild(linkBtn);
    box.appendChild(linkRow);

    const msg = el('div', { cls: 'msg muted' });
    box.appendChild(msg);

    const grid = el('div', { cls: 'vttpick-grid' });
    box.appendChild(grid);

    const foot = el('div', { cls: 'row' });
    const clear = el('button', { text: 'clear the field' });
    const close = el('button', { text: 'cancel' });
    foot.appendChild(clear);
    foot.appendChild(close);
    box.appendChild(foot);

    back.appendChild(box);
    document.body.appendChild(back);

    // Clicking the backdrop closes; clicking the panel does not. Same
    // dismissal behaviour a person expects from any modal.
    back.addEventListener('click', (e) => { if (e.target === back) hide(); });
    close.addEventListener('click', hide);
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
      grid.appendChild(el('p', { cls: 'muted', text: 'no images yet — upload one or paste a link' }));
      return;
    }
    for (const a of assets) {
      const item = el('div', { cls: 'vttpick-item' + (a.source === 'external' ? ' external' : '') });
      const img = document.createElement('img');
      img.src = a.url;
      img.alt = '';
      // A pasted link is fetched from a third party by every viewer. This does
      // not hide the viewer's address — nothing can, short of proxying — but it
      // stops this application's URLs being handed to that host.
      if (a.source === 'external') img.referrerPolicy = 'no-referrer';
      item.appendChild(img);
      item.appendChild(el('div', { text: a.kind }));
      item.appendChild(el('div', {
        cls: 'src muted',
        text: a.source === 'external' ? 'external' : 'hosted',
      }));
      item.addEventListener('click', () => choose(a.url));
      grid.appendChild(item);
    }
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
  function attach(inputId, opts) {
    const input = document.getElementById(inputId);
    if (!input || input.dataset.vttPicker) return null;
    input.dataset.vttPicker = '1';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'choose…';
    btn.className = 'vttpick-open';
    btn.addEventListener('click', () => open({
      campaignId: typeof opts.campaignId === 'function' ? opts.campaignId() : opts.campaignId,
      kind: typeof opts.kind === 'function' ? opts.kind() : opts.kind,
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
