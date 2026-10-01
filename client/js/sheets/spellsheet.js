// Spell editor (VTTSpellSheet) — GM-only authoring.
//
// This is VTTItemSheet's sibling, deliberately: a campaign-scoped catalogue the
// GM authors, edited through one single-flow form with a draft, dirty tracking
// and a themed discard confirm. It is SIMPLER than the item sheet because the
// data model is simpler — the `spells` table has name, level (int 0–9),
// description and a free `properties` JSONB blob, and that is all. There is NO
// image column, so nothing here frames, crops or blurs a picture; and there is
// NO `identified` flag, so there is no player-vs-GM projection to keep in step —
// the catalogue is a rules reference every member reads in full. The
// confidentiality that matters (which spells a character has PREPARED) lives on
// the spellbook join, gated on the server, and this file never touches it.
//
// Data model: name / level / description are real columns. school, casting_time,
// range, components and duration are OPTIONAL descriptive sub-keys of
// `properties`. Nothing here is computed or enforced — level is a bound, not a
// rule; the five detail fields are recorded text, never parsed. Unknown/legacy
// keys already on a spell's `properties` are seeded into the draft at render and
// pass through save untouched, so editing a spell never drops data the GM (or a
// future feature) put there.

window.VTTSpellSheet = (function () {
  // Level 0 is the cantrip; 1–9 are spell levels. A bound the server validates
  // (validateSpellLevel: int 0–9), never a slot table.
  const LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const levelLabel = (n) => (Number(n) === 0 ? 'Cantrip' : 'Level ' + n);

  // The eight schools, plus an explicit "not specified" (stored as the empty
  // string / absent key). Accents are tuned toward the item-rarity palette so
  // the two sections feel like one product; colour is ALWAYS paired with the
  // readable text label, never load-bearing on its own. An unrecognised or
  // custom school gets NEUTRAL_ACCENT and is preserved, never rewritten.
  const SCHOOLS = ['abjuration', 'conjuration', 'divination', 'enchantment',
    'evocation', 'illusion', 'necromancy', 'transmutation'];
  const SCHOOL_LABELS = {
    '': 'Not specified',
    abjuration: 'Abjuration', conjuration: 'Conjuration', divination: 'Divination',
    enchantment: 'Enchantment', evocation: 'Evocation', illusion: 'Illusion',
    necromancy: 'Necromancy', transmutation: 'Transmutation',
  };
  const SCHOOL_COLOR = {
    abjuration: '#3d7fd6',      // blue
    conjuration: '#c8892f',     // amber
    divination: '#b8973a',      // gold
    enchantment: '#c95a86',     // rose
    evocation: '#c25a2f',       // coral
    illusion: '#a24fd6',        // violet
    necromancy: '#4f9d5a',      // muted green
    transmutation: '#2f9c9c',   // teal
  };
  const NEUTRAL_ACCENT = 'var(--border)';

  // properties sub-keys this editor OWNS a field for. Everything else on
  // properties is a legacy/unknown key that must survive a round-trip.
  const DETAIL_KEYS = ['school', 'casting_time', 'range', 'components', 'duration'];
  const DETAIL_LABELS = {
    casting_time: 'Casting time', range: 'Range', components: 'Components', duration: 'Duration',
  };
  const DETAIL_MAX = 120;         // per free-text detail field
  const NAME_MAX = 100;           // validateSpellName
  const DESC_MAX = 5000;          // validateLongText('description', 5000)
  const MAX_PROPS_BYTES = 8192;   // validateJsonBlob byte cap (server enforces too)

  // The accent for a school value: a known school's colour, else neutral. Custom
  // values fall through to neutral rather than being dropped.
  function schoolColor(v) {
    if (!v) return NEUTRAL_ACCENT;
    return SCHOOL_COLOR[v] || NEUTRAL_ACCENT;
  }
  function schoolLabel(v) {
    if (!v) return SCHOOL_LABELS[''];
    return SCHOOL_LABELS[v] || v;   // custom value shown as-is
  }

  function el(tag, opts = {}) {
    const n = document.createElement(tag);
    if (opts.text !== undefined) n.textContent = opts.text;
    if (opts.cls) n.className = opts.cls;
    return n;
  }

  function canonical(v) {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
      return o;
    }
    return v;
  }
  function sameJson(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }

  // The set of school OPTIONS to offer in the editor dropdown and the filter:
  // the eight known schools plus any custom values already present in the
  // catalogue (so a legacy value stays selectable rather than being silently
  // replaced the next time the spell is edited). Passed in by the caller, which
  // knows the whole catalogue; falls back to the known eight.
  function schoolOptions(customValues) {
    const seen = new Set(SCHOOLS);
    const extra = [];
    (customValues || []).forEach((v) => {
      if (v && !seen.has(v)) { seen.add(v); extra.push(v); }
    });
    // '' (Not specified) first, then the eight, then any customs.
    return [''].concat(SCHOOLS).concat(extra);
  }

  function render(container, ctx) {
    container.textContent = '';
    container.className = 'spell-editor';
    const spell = ctx.spell || null;
    const isNew = !spell;

    // The draft: real columns as scalars, properties as a deep copy so unknown
    // keys ride along untouched.
    const draft = {
      name: spell && spell.name != null ? String(spell.name) : '',
      level: spell && spell.level != null ? Number(spell.level) : 0,
      description: spell && spell.description != null ? String(spell.description) : '',
      properties: JSON.parse(JSON.stringify((spell && spell.properties) || {})),
    };

    const inputs = new Map();     // key -> { node, errNode, get }
    let dirty = false;
    function markDirty() {
      if (!dirty) { dirty = true; if (ctx.onDirtyChange) ctx.onDirtyChange(true); }
      updateSaveState();
    }

    const who = document.getElementById('spellWho');
    if (who) who.textContent = isNew ? 'New spell' : 'Edit spell';

    const errSummary = el('p', { cls: 'ie-err-summary' });
    errSummary.setAttribute('role', 'alert');
    errSummary.hidden = true;
    container.appendChild(errSummary);

    function setProp(key, value) {
      if (value === undefined || value === '' || value === false) delete draft.properties[key];
      else draft.properties[key] = value;
    }

    // ── Identity: name (full-width banner, exactly like the item editor) then
    //    level on its own row below ─────────────────────────────────────────
    const identity = el('div', { cls: 'se-identity' });

    const idMain = el('div', { cls: 'ie-id-main' });
    const nameWrap = el('div', { cls: 'ie-namewrap' });
    const nameLab = el('label', { cls: 'ie-lab', text: 'Name' }); nameLab.setAttribute('for', 'spell-name');
    const nameInput = el('input', { cls: 'ie-name' });
    nameInput.type = 'text'; nameInput.id = 'spell-name'; nameInput.maxLength = NAME_MAX;
    nameInput.placeholder = 'Spell name'; nameInput.value = draft.name;
    const nameErr = el('div', { cls: 'ie-field-err' }); nameErr.id = 'spell-name-err';
    nameInput.setAttribute('aria-describedby', 'spell-name-err');
    nameInput.addEventListener('input', () => { draft.name = nameInput.value; markDirty(); });
    nameWrap.appendChild(nameLab); nameWrap.appendChild(nameInput); nameWrap.appendChild(nameErr);
    inputs.set('name', { node: nameInput, errNode: nameErr, get: () => nameInput.value });
    idMain.appendChild(nameWrap);

    // Level dropdown — the site's .vtt-dd, driven by VTTCommon.initDropdown with
    // the options ARRAY passed directly (never { options }). A hidden input
    // carries the value under #spell-level and fires `change`.
    const levelRow = el('div', { cls: 'ie-row2 se-level-row' });
    const levelCell = ddSelect(
      'level', 'Level',
      LEVELS.map((n) => ({ value: String(n), label: levelLabel(n) })),
      String(draft.level),
      (v) => { draft.level = Number(v); markDirty(); },
    );
    levelRow.appendChild(levelCell.cell);
    idMain.appendChild(levelRow);

    identity.appendChild(idMain);
    container.appendChild(identity);

    // ── Description ──────────────────────────────────────────────────────────
    {
      const cell = el('div', { cls: 'ie-cell wide ie-block' });
      const lab = el('label', { cls: 'ie-lab', text: 'Description' }); lab.setAttribute('for', 'spell-description');
      const ta = el('textarea'); ta.id = 'spell-description'; ta.rows = 5; ta.maxLength = DESC_MAX;
      ta.value = draft.description;
      const errNode = el('div', { cls: 'ie-field-err' }); errNode.id = 'spell-description-err';
      ta.setAttribute('aria-describedby', errNode.id);
      ta.addEventListener('input', () => { draft.description = ta.value; markDirty(); });
      cell.appendChild(lab); cell.appendChild(ta);
      cell.appendChild(el('div', { cls: 'ie-help', text: 'What the spell does. Resolved by the GM — nothing here is rolled.' }));
      cell.appendChild(errNode);
      container.appendChild(cell);
      inputs.set('description', { node: ta, errNode, get: () => ta.value });
    }

    // ── "Spell details" disclosure: school + four free-text fields ───────────
    const detailsDisc = disclosure('Spell details', 'se-disc-details', false);
    const detailsGrid = el('div', { cls: 'ie-grid' });

    // School: a themed dropdown including the known eight, "Not specified", and
    // any custom value already in the catalogue (seeded via ctx.schoolValues).
    const schoolOpts = schoolOptions(ctx.schoolValues);
    const currentSchool = draft.properties.school != null ? String(draft.properties.school) : '';
    const schoolCell = ddSelect(
      'school', 'School',
      schoolOpts.map((v) => ({ value: v, label: schoolLabel(v) })),
      currentSchool,
      (v) => { setProp('school', v || undefined); markDirty(); },
      { path: 'properties' },
    );
    detailsGrid.appendChild(schoolCell.cell);

    // The four free-text detail fields.
    ['casting_time', 'range', 'components', 'duration'].forEach((key) => {
      buildDetailField(detailsGrid, key);
    });

    detailsDisc.body.appendChild(detailsGrid);
    container.appendChild(detailsDisc.root);

    // "Other saved properties": any legacy/unknown key on the spell that this
    // editor has no field for. Shown so the GM knows they exist and that they
    // are preserved on save; clearable explicitly.
    const orphanWrap = el('div', { cls: 'ie-orphan' });
    detailsDisc.body.appendChild(orphanWrap);

    // ── Footer ───────────────────────────────────────────────────────────────
    const footer = el('div', { cls: 'ie-footer' });
    const cancelBtn = el('button', { cls: 'btn small secondary', text: 'Cancel' }); cancelBtn.type = 'button';
    const spacer = el('span', { cls: 'ie-footer-spacer' });
    const status = el('span', { cls: 'ie-status' }); status.setAttribute('aria-live', 'polite');
    const saveBtn = el('button', { cls: 'btn small primary', text: isNew ? 'Create spell' : 'Save changes' }); saveBtn.type = 'button';
    footer.appendChild(cancelBtn); footer.appendChild(spacer);
    footer.appendChild(status); footer.appendChild(saveBtn);
    container.appendChild(footer);

    // ── vtt-dd builder (mirrors itemsheet.ddSelect) ──────────────────────────
    function ddSelect(key, label, ddOptions, value, onChange, opts) {
      opts = opts || {};
      const cell = el('div', { cls: 'ie-cell' });
      const id = 'spell-' + key;
      const lab = el('label', { cls: 'ie-lab', text: label }); lab.setAttribute('for', id);
      const dd = el('div', { cls: 'vtt-dd' }); dd.setAttribute('data-value', value);
      const hidden = el('input'); hidden.type = 'hidden'; hidden.id = id; hidden.value = value;
      const btn = el('button', { cls: 'vtt-dd-btn' }); btn.type = 'button';
      btn.id = id + '-btn';
      btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
      const ul = el('ul', { cls: 'vtt-dd-list' }); ul.setAttribute('role', 'listbox');
      ul.setAttribute('tabindex', '-1'); ul.hidden = true; ul.setAttribute('aria-label', label);
      dd.appendChild(hidden); dd.appendChild(btn); dd.appendChild(ul);
      cell.appendChild(lab); cell.appendChild(dd);
      const initial = ddOptions.find((o) => o.value === value);
      btn.textContent = initial ? initial.label : (ddOptions[0] && ddOptions[0].label) || '';
      hidden.addEventListener('change', () => onChange(hidden.value));
      if (window.VTTCommon && window.VTTCommon.initDropdown) {
        window.VTTCommon.initDropdown(dd, ddOptions);   // ARRAY, not { options }
      }
      inputs.set(key, { node: hidden, errNode: el('div'), get: () => hidden.value, path: opts.path });
      return { cell };
    }

    function buildDetailField(parent, key) {
      const cell = el('div', { cls: 'ie-cell' });
      const id = 'spell-' + key;
      const lab = el('label', { cls: 'ie-lab', text: DETAIL_LABELS[key] || key }); lab.setAttribute('for', id);
      const node = el('input'); node.type = 'text'; node.id = id; node.maxLength = DETAIL_MAX;
      const cur = draft.properties[key];
      node.value = cur === undefined || cur === null ? '' : String(cur);
      const errNode = el('div', { cls: 'ie-field-err' }); errNode.id = id + '-err';
      node.setAttribute('aria-describedby', errNode.id);
      node.addEventListener('input', () => {
        setProp(key, node.value === '' ? undefined : node.value);
        markDirty();
      });
      cell.appendChild(lab); cell.appendChild(node); cell.appendChild(errNode);
      parent.appendChild(cell);
      inputs.set(key, { node, errNode, get: () => node.value, path: 'properties' });
    }

    function disclosure(title, cls, openInitially) {
      const root = el('section', { cls: 'ie-disc ' + cls });
      const btn = el('button', { cls: 'ie-disc-head' }); btn.type = 'button';
      btn.setAttribute('aria-expanded', openInitially ? 'true' : 'false');
      btn.appendChild(el('span', { cls: 'ie-chev', text: '▸' }));
      btn.appendChild(el('span', { cls: 'ie-disc-title', text: title }));
      const summary = el('span', { cls: 'ie-disc-summary' });
      btn.appendChild(summary);
      const body = el('div', { cls: 'ie-disc-body' });
      body.hidden = !openInitially;
      const bodyId = cls + '-body';
      body.id = bodyId; btn.setAttribute('aria-controls', bodyId);
      btn.addEventListener('click', () => setOpen(!isOpen()));
      function isOpen() { return btn.getAttribute('aria-expanded') === 'true'; }
      function setOpen(v) { btn.setAttribute('aria-expanded', v ? 'true' : 'false'); body.hidden = !v; root.classList.toggle('open', v); }
      root.classList.toggle('open', openInitially);
      root.appendChild(btn); root.appendChild(body);
      return { root, body, setOpen, isOpen, setSummary: (t) => { summary.textContent = t || ''; } };
    }

    // Legacy/unknown properties = every key not owned by a DETAIL field.
    function orphanKeys() {
      return Object.keys(draft.properties).filter((k) => DETAIL_KEYS.indexOf(k) === -1);
    }
    function syncOrphans() {
      const keys = orphanKeys();
      orphanWrap.textContent = '';
      if (!keys.length) { orphanWrap.hidden = true; return; }
      orphanWrap.hidden = false;
      orphanWrap.appendChild(el('div', { cls: 'ie-lab', text: 'Other saved properties' }));
      orphanWrap.appendChild(el('div', { cls: 'ie-help', text: 'Kept from earlier edits or an import. They are preserved on save unless you clear them.' }));
      const list = el('div', { cls: 'ie-orphan-list' });
      for (const k of keys) list.appendChild(el('span', { cls: 'ie-orphan-chip', text: k + ': ' + draft.properties[k] }));
      orphanWrap.appendChild(list);
      const clear = el('button', { cls: 'btn small secondary', text: 'Clear these' }); clear.type = 'button';
      clear.addEventListener('click', () => { for (const k of keys) delete draft.properties[k]; markDirty(); syncOrphans(); });
      orphanWrap.appendChild(clear);
    }

    function updateDetailsSummary() {
      const bits = [];
      if (draft.properties.school) bits.push(schoolLabel(String(draft.properties.school)));
      ['casting_time', 'range', 'components', 'duration'].forEach((k) => {
        if (draft.properties[k]) bits.push(String(draft.properties[k]));
      });
      detailsDisc.setSummary(bits.join(' · '));
    }

    // Assemble a clean properties object off the draft: drop empties, keep
    // everything else (owned fields AND orphans) untouched.
    function assembleProps() {
      const next = {};
      for (const k of Object.keys(draft.properties)) {
        const v = draft.properties[k];
        if (v === undefined || v === '' || v === false) continue;
        next[k] = v;
      }
      return next;
    }

    // Reconcile the draft from the live DOM (robust to values set without an
    // input event, e.g. tests).
    function syncDraftFromDom() {
      for (const [key, entry] of inputs) {
        const node = entry.node;
        if (!node) continue;
        if (key === 'name') draft.name = node.value;
        else if (key === 'level') draft.level = Number(node.value);
        else if (key === 'description') draft.description = node.value;
        else if (entry.path === 'properties') {
          if (node.value === '') setProp(key, undefined);
          else setProp(key, node.value);
        }
      }
    }

    function currentPatch() {
      syncDraftFromDom();
      const patch = {};
      const prevName = spell && spell.name != null ? String(spell.name) : '';
      const prevLevel = spell && spell.level != null ? Number(spell.level) : 0;
      const prevDesc = spell && spell.description != null ? String(spell.description) : '';
      if (isNew || draft.name !== prevName) { if (draft.name !== '' || !isNew) patch.name = draft.name; }
      if (isNew || draft.level !== prevLevel) patch.level = draft.level;
      if (isNew || draft.description !== prevDesc) { if (!(isNew && draft.description === '')) patch.description = draft.description; }
      const nextProps = assembleProps();
      if (isNew ? Object.keys(nextProps).length > 0 : !sameJson(nextProps, (spell && spell.properties) || {})) patch.properties = nextProps;
      return patch;
    }

    function updateSaveState() {
      updateDetailsSummary(); syncOrphans();
      if (isNew) { saveBtn.disabled = false; saveBtn.title = ''; return; }
      const patch = currentPatch();
      const nothing = Object.keys(patch).length === 0;
      saveBtn.disabled = nothing;
      saveBtn.title = nothing ? 'No changes' : '';
      if (nothing && dirty) status.textContent = 'No changes';
      else if (!nothing) status.textContent = '';
    }

    function clearErrors() {
      errSummary.hidden = true; errSummary.textContent = '';
      for (const { errNode, node } of inputs.values()) {
        if (errNode) errNode.textContent = '';
        if (node && node.removeAttribute) node.removeAttribute('aria-invalid');
      }
    }
    function fieldError(key, msg) {
      const entry = inputs.get(key);
      if (entry) { if (entry.errNode) entry.errNode.textContent = msg; if (entry.node && entry.node.setAttribute) entry.node.setAttribute('aria-invalid', 'true'); }
    }
    // Route a server error at a named field to that field (opening details when
    // the field lives inside the disclosure), else the summary line.
    const DETAIL_FIELD_SET = new Set(DETAIL_KEYS);
    function showServerError(message) {
      const msg = String(message || 'The spell could not be saved.');
      let placed = false;
      for (const key of inputs.keys()) {
        const entry = inputs.get(key);
        // Only route to a field whose error node is actually in the document —
        // the dropdown fields (level, school) carry a detached err node, so a
        // message mentioning "level" must fall through to the summary rather
        // than vanish into an unmounted node.
        const mounted = entry && entry.errNode && entry.errNode.isConnected;
        if (mounted && msg.includes(key)) {
          fieldError(key, msg);
          if (DETAIL_FIELD_SET.has(key)) detailsDisc.setOpen(true);
          placed = true; break;
        }
      }
      if (!placed) { errSummary.hidden = false; errSummary.textContent = msg; }
    }

    let saving = false;
    saveBtn.addEventListener('click', async () => {
      if (saving) return;                 // no duplicate submissions
      clearErrors();
      syncDraftFromDom();
      let firstBad = null;
      if ((draft.name || '').trim() === '') { fieldError('name', 'A name is required.'); firstBad = firstBad || 'name'; }

      // The 8 KB properties cap (server enforces it too). With no JSON editor to
      // blame, surface it as a summary error pointing at the detail fields.
      const nextProps = assembleProps();
      const bytes = new TextEncoder().encode(JSON.stringify(nextProps)).length;
      if (bytes > MAX_PROPS_BYTES) {
        errSummary.hidden = false;
        errSummary.textContent = 'This spell stores ' + bytes.toLocaleString() + ' bytes of details; the limit is ' + MAX_PROPS_BYTES.toLocaleString() + '. Shorten the detail fields.';
        firstBad = firstBad || 'name';
        detailsDisc.setOpen(true);
      }
      if (firstBad) {
        if (errSummary.hidden) { errSummary.hidden = false; errSummary.textContent = 'Please fix the highlighted field.'; }
        const e = inputs.get(firstBad); if (e && e.node && e.node.focus) e.node.focus();
        return;
      }

      const patch = currentPatch();
      if (!isNew && Object.keys(patch).length === 0) { status.textContent = 'No changes'; return; }
      saving = true; saveBtn.disabled = true;
      const prevLabel = saveBtn.textContent; saveBtn.textContent = 'Saving…'; status.textContent = '';
      try {
        const r = await ctx.onSave(patch, isNew);
        if (r && (r.status === 200 || r.status === 201)) {
          dirty = false; if (ctx.onDirtyChange) ctx.onDirtyChange(false);
          status.textContent = 'Saved';
          saving = false; saveBtn.textContent = prevLabel;
          if (ctx.onDone) ctx.onDone(r);
          return;
        }
        // Keep the draft open on failure; surface an actionable error.
        showServerError(r && r.data && r.data.error);
        status.textContent = 'Not saved';
      } catch (err) {
        errSummary.hidden = false; errSummary.textContent = 'Network error — your edits are kept. Try again.';
        status.textContent = 'Not saved';
      }
      saving = false; saveBtn.disabled = false; saveBtn.textContent = prevLabel;
    });

    cancelBtn.addEventListener('click', () => { if (ctx.requestClose) ctx.requestClose(); });

    // Open the disclosure if the spell already carries any detail/legacy value,
    // so nothing hides on edit.
    if (DETAIL_KEYS.some((k) => draft.properties[k] !== undefined) || orphanKeys().length) detailsDisc.setOpen(true);
    syncOrphans();
    updateSaveState();
  }

  // Read-only detail view — the lightweight card players (and the GM, via a
  // preview) get on activation. Level-forward: a level badge and school label,
  // then the metadata that exists, then the full description. NO learn/prepare
  // controls — this is not the spellbook.
  function renderRead(container, spell) {
    container.textContent = '';
    container.className = 'spell-read';
    const s = spell || {};
    const props = (s.properties && typeof s.properties === 'object') ? s.properties : {};
    const school = props.school != null ? String(props.school) : '';
    const accent = schoolColor(school);

    // Title block: level badge + name + school label.
    const title = el('div', { cls: 'sr-title' });
    const badge = el('span', { cls: 'sr-badge', text: levelLabel(s.level) });
    badge.style.setProperty('--sr-accent', accent);
    title.appendChild(badge);
    const names = el('div', { cls: 'sr-names' });
    names.appendChild(el('h3', { cls: 'sr-name', text: s.name || 'Spell' }));
    if (school) {
      const sl = el('span', { cls: 'sr-school', text: schoolLabel(school) });
      sl.style.color = accent;
      names.appendChild(sl);
    }
    title.appendChild(names);
    container.appendChild(title);

    // Metadata block: only the fields that exist, label over value.
    const metaFields = [];
    ['casting_time', 'range', 'components', 'duration'].forEach((k) => {
      if (props[k]) metaFields.push([DETAIL_LABELS[k] || k, String(props[k])]);
    });
    if (metaFields.length) {
      const grid = el('div', { cls: 'sr-meta' });
      for (const [k, v] of metaFields) {
        const cell = el('div', { cls: 'sr-meta-cell' });
        cell.appendChild(el('span', { cls: 'sr-meta-key', text: k }));
        cell.appendChild(el('span', { cls: 'sr-meta-val', text: v }));
        grid.appendChild(cell);
      }
      container.appendChild(grid);
    }

    // Description prose, full (this view is where a player reads the whole thing).
    if (s.description) {
      container.appendChild(el('div', { cls: 'ir-block-label', text: 'Description' }));
      container.appendChild(el('p', { cls: 'sr-prose', text: s.description }));
    } else {
      container.appendChild(el('p', { cls: 'muted', text: 'No description.' }));
    }
  }

  // Mount the read view as a centered overlay in the open dialog (top layer),
  // else the given host — same approach as VTTItemSheet.openPreview.
  function openPreview(spell, host) {
    const mount = (typeof document !== 'undefined' && document.querySelector('dialog[open]')) || host || document.body;
    let overlay = mount.querySelector('.ie-preview-overlay');
    if (overlay) overlay.remove();
    overlay = el('div', { cls: 'ie-preview-overlay' });
    const card = el('div', { cls: 'ie-preview-card' });
    const bar = el('div', { cls: 'ie-preview-bar' });
    bar.appendChild(el('span', { cls: 'ie-preview-title', text: 'Spell' }));
    const close = el('button', { cls: 'ie-preview-close' }); close.type = 'button';
    close.setAttribute('aria-label', 'Close'); close.textContent = '✕';
    close.addEventListener('click', () => overlay.remove());
    bar.appendChild(close);
    const readHost = el('div');
    renderRead(readHost, spell);
    card.appendChild(bar); card.appendChild(readHost);
    overlay.appendChild(card);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    mount.appendChild(overlay);
    close.focus();
  }

  return {
    render, renderRead, openPreview,
    LEVELS, levelLabel,
    SCHOOLS, SCHOOL_LABELS, SCHOOL_COLOR, NEUTRAL_ACCENT,
    schoolColor, schoolLabel, schoolOptions,
  };
})();
