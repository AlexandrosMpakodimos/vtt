// Character creation form (VTTActorSheet) — the "New character" modal only.
//
// This is DELIBERATELY not a second character editor: editing an existing
// character stays in VTTSheet. This file owns exactly one thing — the create
// flow — because the fields a creator may set, and the way a player's create is
// deliberately narrower than a GM's, is its own concern and does not belong
// tangled into the full sheet.
//
// Player creation starts with name, portrait and current HP. Players can then
// edit all gameplay stats in their own sheet. The GM also chooses controller
// and PC/NPC status; party membership is managed from the roster. The server
// continues to enforce ownership and validate every field.
//
// Framing: img_offset_x / img_offset_y / img_scale are on BOTH server
// allow-lists and the POST /actors route accepts them, so a portrait and its
// crop are persisted in the SAME create request — no follow-up PATCH. The crop
// lives in the modal draft until Create is pressed.

window.VTTActorSheet = (function () {
  const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];

  // Bounds mirror ACTOR_INT_FIELDS in validators.js — fail early and locally
  // rather than round-tripping a 400. (Same values VTTSheet uses.)
  const INT_BOUNDS = {
    hp_current: [-9999, 9999], hp_max: [0, 9999], armor_class: [0, 99],
    level: [1, 20], speed: [0, 999],
    strength: [1, 30], dexterity: [1, 30], constitution: [1, 30],
    intelligence: [1, 30], wisdom: [1, 30], charisma: [1, 30],
  };
  const ABILITIES = [
    ['strength', 'STR'], ['dexterity', 'DEX'], ['constitution', 'CON'],
    ['intelligence', 'INT'], ['wisdom', 'WIS'], ['charisma', 'CHA'],
  ];

  function el(tag, opts = {}) {
    const n = document.createElement(tag);
    if (opts.text !== undefined) n.textContent = opts.text;
    if (opts.cls) n.className = opts.cls;
    return n;
  }

  // Two-letter initials for the portrait fallback, from the typed name.
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /**
   * render(container, ctx)
   *   ctx = {
   *     isGm, members: [{ id, label }],
   *     onSave(body) -> { status, data },   // POST already shaped by the caller? NO — we pass a body
   *     onDirtyChange(bool), requestClose(),
   *     onPickImage(currentUrl, cb, currentFrame),  // opens VTTImagePicker; cb(url, frame)
   *     onDone(resultData),                 // after a 201
   *   }
   */
  function render(container, ctx) {
    container.textContent = '';
    container.className = 'actor-editor';   // shares the item/spell editor input styling
    const isGm = ctx.isGm === true;

    // The draft. Column-backed scalars plus the portrait + its framing. A
    // player's draft simply never grows the GM keys.
    const draft = {
      name: '',
      img_url: '',
      img_offset_x: 0, img_offset_y: 0, img_scale: 1,
      hp_current: 10,
    };
    if (isGm) Object.assign(draft, {
      is_npc: false, user_id: '',
      size: 'Medium', level: 1,
      hp_max: 10, armor_class: 10, speed: 30,
      strength: 10, dexterity: 10, constitution: 10,
      intelligence: 10, wisdom: 10, charisma: 10,
    });

    const inputs = new Map();   // key -> { node, errNode, get, kind }
    let dirty = false;
    function markDirty() { if (!dirty) { dirty = true; if (ctx.onDirtyChange) ctx.onDirtyChange(true); } }

    const errSummary = el('p', { cls: 'ie-err-summary' });
    errSummary.setAttribute('role', 'alert'); errSummary.hidden = true;
    container.appendChild(errSummary);

    // ── Portrait + name (identity banner, mirrors the item editor) ───────────
    const identity = el('div', { cls: 'ae-identity' });

    const portraitBtn = el('button', { cls: 'ae-portrait' }); portraitBtn.type = 'button';
    portraitBtn.setAttribute('aria-label', 'Choose portrait');
    const portraitImg = el('img', { cls: 'ae-portrait-img' }); portraitImg.alt = '';
    const portraitFallback = el('span', { cls: 'ae-portrait-fallback' });
    portraitBtn.appendChild(portraitImg); portraitBtn.appendChild(portraitFallback);

    function paintPortrait() {
      if (draft.img_url) {
        portraitImg.src = draft.img_url;
        portraitImg.style.display = '';
        // Apply the draft framing so the crop previews before save.
        window.VTTImageFrame.apply(portraitImg, portraitBtn, draft.img_offset_x, draft.img_offset_y, draft.img_scale);
        portraitFallback.style.display = 'none';
      } else {
        portraitImg.style.display = 'none';
        portraitFallback.textContent = initials(draft.name);
        portraitFallback.style.display = '';
      }
    }
    portraitBtn.addEventListener('click', () => {
      if (!ctx.onPickImage) return;
      ctx.onPickImage(
        draft.img_url,
        (url, frame) => {
          draft.img_url = url || '';
          if (frame) {
            draft.img_offset_x = Number(frame.offsetX) || 0;
            draft.img_offset_y = Number(frame.offsetY) || 0;
            draft.img_scale = Number(frame.scale) > 0 ? Number(frame.scale) : 1;
          }
          markDirty(); paintPortrait();
        },
        { offsetX: draft.img_offset_x, offsetY: draft.img_offset_y, scale: draft.img_scale },
      );
    });
    identity.appendChild(portraitBtn);

    const nameWrap = el('div', { cls: 'ie-namewrap ae-namewrap' });
    const nameLab = el('label', { cls: 'ie-lab', text: 'Name' }); nameLab.setAttribute('for', 'actor-name');
    const nameInput = el('input', { cls: 'ie-name' });
    nameInput.type = 'text'; nameInput.id = 'actor-name'; nameInput.maxLength = 100;
    nameInput.placeholder = 'Character name';
    const nameErr = el('div', { cls: 'ie-field-err' }); nameErr.id = 'actor-name-err';
    nameInput.setAttribute('aria-describedby', 'actor-name-err');
    nameInput.addEventListener('input', () => { draft.name = nameInput.value; markDirty(); paintPortrait(); });
    nameWrap.appendChild(nameLab); nameWrap.appendChild(nameInput); nameWrap.appendChild(nameErr);
    inputs.set('name', { node: nameInput, errNode: nameErr, get: () => nameInput.value, kind: 'text' });
    identity.appendChild(nameWrap);
    container.appendChild(identity);
    paintPortrait();

    // ── vtt-dd builder (array passed directly to initDropdown) ───────────────
    function ddSelect(key, label, ddOptions, value, onChange) {
      const cell = el('div', { cls: 'ie-cell' });
      const id = 'actor-' + key;
      const lab = el('label', { cls: 'ie-lab', text: label }); lab.setAttribute('for', id);
      const dd = el('div', { cls: 'vtt-dd' }); dd.setAttribute('data-value', value);
      const hidden = el('input'); hidden.type = 'hidden'; hidden.id = id; hidden.value = value;
      const btn = el('button', { cls: 'vtt-dd-btn' }); btn.type = 'button'; btn.id = id + '-btn';
      btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
      const ul = el('ul', { cls: 'vtt-dd-list' }); ul.setAttribute('role', 'listbox');
      ul.setAttribute('tabindex', '-1'); ul.hidden = true; ul.setAttribute('aria-label', label);
      dd.appendChild(hidden); dd.appendChild(btn); dd.appendChild(ul);
      cell.appendChild(lab); cell.appendChild(dd);
      const initial = ddOptions.find((o) => o.value === value);
      btn.textContent = initial ? initial.label : (ddOptions[0] && ddOptions[0].label) || '';
      hidden.addEventListener('change', () => { onChange(hidden.value); markDirty(); });
      if (window.VTTCommon && window.VTTCommon.initDropdown) window.VTTCommon.initDropdown(dd, ddOptions);
      inputs.set(key, { node: hidden, errNode: el('div'), get: () => hidden.value, kind: 'dd' });
      return cell;
    }

    function intCell(key, label, parent) {
      const cell = el('div', { cls: 'ie-cell' });
      const id = 'actor-' + key;
      const lab = el('label', { cls: 'ie-lab', text: label }); lab.setAttribute('for', id);
      const node = el('input'); node.type = 'number'; node.id = id;
      const b = INT_BOUNDS[key];
      if (b) { node.min = String(b[0]); node.max = String(b[1]); }
      node.value = String(draft[key]);
      const errNode = el('div', { cls: 'ie-field-err' }); errNode.id = id + '-err';
      node.setAttribute('aria-describedby', errNode.id);
      node.addEventListener('input', () => { markDirty(); });
      cell.appendChild(lab); cell.appendChild(node); cell.appendChild(errNode);
      parent.appendChild(cell);
      inputs.set(key, { node, errNode, get: () => node.value, kind: 'int' });
    }

    // ── Current HP (both roles) ──────────────────────────────────────────────
    const vitalsRow = el('div', { cls: 'ie-grid' });
    intCell('hp_current', 'Current HP', vitalsRow);
    container.appendChild(vitalsRow);

    if (isGm) {
      // Type + controller.
      const typeRow = el('div', { cls: 'ie-grid' });
      typeRow.appendChild(ddSelect('is_npc', 'Type',
        [{ value: 'false', label: 'Player character' }, { value: 'true', label: 'NPC' }],
        'false', (v) => { draft.is_npc = v === 'true'; }));
      const memberOpts = [{ value: '', label: 'Nobody (GM runs it)' }]
        .concat((ctx.members || []).map((m) => ({ value: m.id, label: m.label })));
      typeRow.appendChild(ddSelect('user_id', 'Controlled by', memberOpts, '',
        (v) => { draft.user_id = v; }));
      container.appendChild(typeRow);

      // Size + level.
      const sizeRow = el('div', { cls: 'ie-grid' });
      sizeRow.appendChild(ddSelect('size', 'Size',
        SIZES.map((s) => ({ value: s, label: s })), 'Medium', (v) => { draft.size = v; }));
      intCell('level', 'Level', sizeRow);
      container.appendChild(sizeRow);

      // "Statistics" disclosure: max HP, AC, speed, abilities.
      const disc = disclosure('Statistics', 'ae-disc-stats', false);
      const statGrid = el('div', { cls: 'ie-grid' });
      intCell('hp_max', 'Max HP', statGrid);
      intCell('armor_class', 'AC', statGrid);
      intCell('speed', 'Speed', statGrid);
      disc.body.appendChild(statGrid);
      const abilityGrid = el('div', { cls: 'ie-grid ae-abilities' });
      for (const [key, label] of ABILITIES) intCell(key, label, abilityGrid);
      disc.body.appendChild(abilityGrid);
      container.appendChild(disc.root);
    } else {
      container.appendChild(el('p', { cls: 'ie-help', text: 'Start with a name, portrait and current HP. You can edit all your character’s stats in the sheet after creation.' }));
    }

    // ── Footer ───────────────────────────────────────────────────────────────
    const footer = el('div', { cls: 'ie-footer' });
    const cancelBtn = el('button', { cls: 'btn small secondary', text: 'Cancel' }); cancelBtn.type = 'button';
    const spacer = el('span', { cls: 'ie-footer-spacer' });
    const status = el('span', { cls: 'ie-status' }); status.setAttribute('aria-live', 'polite');
    const saveBtn = el('button', { cls: 'btn small primary', text: 'Create character' }); saveBtn.type = 'button';
    footer.appendChild(cancelBtn); footer.appendChild(spacer); footer.appendChild(status); footer.appendChild(saveBtn);
    container.appendChild(footer);

    function disclosure(title, cls, openInitially) {
      const root = el('section', { cls: 'ie-disc ' + cls });
      const btn = el('button', { cls: 'ie-disc-head' }); btn.type = 'button';
      btn.setAttribute('aria-expanded', openInitially ? 'true' : 'false');
      btn.appendChild(el('span', { cls: 'ie-chev', text: '▸' }));
      btn.appendChild(el('span', { cls: 'ie-disc-title', text: title }));
      const body = el('div', { cls: 'ie-disc-body' });
      body.hidden = !openInitially;
      const bodyId = cls + '-body'; body.id = bodyId; btn.setAttribute('aria-controls', bodyId);
      btn.addEventListener('click', () => {
        const open = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        body.hidden = !open; root.classList.toggle('open', open);
      });
      root.classList.toggle('open', openInitially);
      root.appendChild(btn); root.appendChild(body);
      return { root, body };
    }

    function clearErrors() {
      errSummary.hidden = true; errSummary.textContent = '';
      for (const { errNode, node } of inputs.values()) {
        if (errNode) errNode.textContent = '';
        if (node && node.removeAttribute) node.removeAttribute('aria-invalid');
      }
    }
    function fieldError(key, msg) {
      const e = inputs.get(key);
      if (e) { if (e.errNode) e.errNode.textContent = msg; if (e.node && e.node.setAttribute) e.node.setAttribute('aria-invalid', 'true'); }
    }

    // Build the create body from the draft, sending ONLY the caller's tier.
    // Returns { body } or { error, key }.
    function buildBody() {
      const name = (inputs.get('name').get() || '').trim();
      if (name === '') return { error: 'A name is required.', key: 'name' };
      const body = { name };

      // Portrait + framing (both tiers).
      if (draft.img_url) {
        body.img_url = draft.img_url;
        body.img_offset_x = draft.img_offset_x;
        body.img_offset_y = draft.img_offset_y;
        body.img_scale = draft.img_scale;
      }

      const intKeys = isGm
        ? ['hp_current', 'level', 'hp_max', 'armor_class', 'speed',
           'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']
        : ['hp_current'];
      for (const key of intKeys) {
        const raw = inputs.get(key).get();
        if (raw === '' || raw === undefined) continue;
        const n = Number(raw);
        if (!Number.isInteger(n)) return { error: key + ' must be a whole number.', key };
        const b = INT_BOUNDS[key];
        if (b && (n < b[0] || n > b[1])) return { error: `${key} must be between ${b[0]} and ${b[1]}.`, key };
        body[key] = n;
      }

      if (isGm) {
        body.is_npc = inputs.get('is_npc').get() === 'true';
        const uid = inputs.get('user_id').get();
        body.user_id = uid || null;
        body.size = inputs.get('size').get();
      }
      return { body };
    }

    let saving = false;
    saveBtn.addEventListener('click', async () => {
      if (saving) return;
      clearErrors();
      const built = buildBody();
      if (built.error) {
        fieldError(built.key, built.error);
        errSummary.hidden = false; errSummary.textContent = built.error;
        const e = inputs.get(built.key); if (e && e.node && e.node.focus) e.node.focus();
        return;
      }
      saving = true; saveBtn.disabled = true;
      const prev = saveBtn.textContent; saveBtn.textContent = 'Creating…'; status.textContent = '';
      try {
        const r = await ctx.onSave(built.body);
        if (r && (r.status === 201 || r.status === 200)) {
          dirty = false; if (ctx.onDirtyChange) ctx.onDirtyChange(false);
          saving = false; saveBtn.textContent = prev;
          if (ctx.onDone) ctx.onDone(r.data);
          return;
        }
        // Keep the draft; surface the error (409 = cap, 400 = validation, 403 = tier).
        const msg = (r && r.data && r.data.error) || 'The character could not be created.';
        errSummary.hidden = false; errSummary.textContent = msg;
        status.textContent = 'Not created';
      } catch (err) {
        errSummary.hidden = false; errSummary.textContent = 'Network error — your entries are kept. Try again.';
        status.textContent = 'Not created';
      }
      saving = false; saveBtn.disabled = false; saveBtn.textContent = prev;
    });

    cancelBtn.addEventListener('click', () => { if (ctx.requestClose) ctx.requestClose(); });
  }

  return { render, SIZES };
})();
