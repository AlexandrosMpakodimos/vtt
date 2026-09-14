// Item editor (VTTItemSheet) — GM-only authoring.
//
// GM-ONLY end to end: the server's POST / PATCH / DELETE on /items are all
// requireOwner, and every item payload passes through shapeItemFor() so a player
// never receives an unidentified item's name, weight, description or properties.
// This editor must not weaken that: the player benefit here is clearer READING
// (the read view / preview below mirror the server projection exactly); the GM
// benefit is calmer authoring.
//
// Data model (unchanged): fields the `items` table has get a real column (name,
// type, weight, description, identified). Everything else — rarity, attunement,
// damage, armour, charges, cost, effect, source — is a sub-key of `properties`
// (bounded JSONB, 8 KB). Nothing here is computed or enforced: armour class,
// damage, cost, weight, charges and attunement are RECORDED, not executed.

window.VTTItemSheet = (function () {
  const TYPES = ['weapon', 'armor', 'consumable', 'misc'];
  const TYPE_LABELS = { weapon: 'Weapon', armor: 'Armour', consumable: 'Consumable', misc: 'Miscellaneous' };
  const RARITIES = ['', 'common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact'];
  const RARITY_LABELS = {
    '': 'None', common: 'Common', uncommon: 'Uncommon', rare: 'Rare',
    'very rare': 'Very rare', legendary: 'Legendary', artifact: 'Artifact',
  };
  const RARITY_COLOR = {
    common: 'var(--text-muted)', uncommon: '#4f9d5a', rare: '#3d7fd6',
    'very rare': '#a24fd6', legendary: '#c8892f', artifact: '#c25a2f',
  };
  const ARMOR_TYPES = ['', 'light', 'medium', 'heavy', 'shield'];

  const FIELDS = [
    { key: 'name', label: 'Name', type: 'text', max: 100, group: 'identity', wide: true },
    { key: 'type', label: 'Type', type: 'select', options: TYPES, labels: TYPE_LABELS, group: 'identity' },
    { key: 'weight', label: 'Weight', type: 'decimal', min: 0, max: 10000, group: 'extra' },
    { key: 'identified', label: 'Identified', type: 'bool', group: 'identity' },
    { key: 'img_url', label: 'Image URL', type: 'text', max: 2000, group: 'image', wide: true },
    { key: 'description', label: 'Description', type: 'textarea', rows: 4, max: 2000, group: 'desc', wide: true },

    { key: 'rarity', label: 'Rarity', type: 'select', options: RARITIES, labels: RARITY_LABELS, path: 'properties', group: 'identity' },
    { key: 'magical', label: 'Magical', type: 'bool', path: 'properties', group: 'extra' },
    { key: 'requires_attunement', label: 'Requires attunement', type: 'bool', path: 'properties', group: 'extra' },
    { key: 'cost', label: 'Cost', type: 'text', max: 30, path: 'properties', group: 'extra' },
    { key: 'attunement_note', label: 'Attunement note', type: 'text', max: 120, path: 'properties', group: 'extra', wide: true, help: 'e.g. "by a druid"' },

    { key: 'damage', label: 'Damage', type: 'text', max: 30, path: 'properties', group: 'weapon', help: 'Recorded only; nothing is rolled.' },
    { key: 'damage_type', label: 'Damage type', type: 'text', max: 30, path: 'properties', group: 'weapon' },
    { key: 'weapon_range', label: 'Range', type: 'text', max: 30, path: 'properties', group: 'weapon' },
    { key: 'weapon_properties', label: 'Properties', type: 'text', max: 120, path: 'properties', group: 'weapon', wide: true, help: 'finesse, light, thrown…' },

    { key: 'armor_class', label: 'Armour class', type: 'text', max: 40, path: 'properties', group: 'armor', help: 'Free text, e.g. "14 + Dex modifier (max 2)". Recorded only; does not change character stats.' },
    { key: 'armor_type', label: 'Armour type', type: 'select', options: ARMOR_TYPES, path: 'properties', group: 'armor' },
    { key: 'strength_req', label: 'Strength requirement', type: 'text', max: 20, path: 'properties', group: 'armor' },
    { key: 'stealth_disadvantage', label: 'Stealth disadvantage', type: 'bool', path: 'properties', group: 'armor', wide: true },

    { key: 'charges', label: 'Charges', type: 'int', min: 0, max: 9999, path: 'properties', group: 'charges' },
    { key: 'charges_max', label: 'Max charges', type: 'int', min: 0, max: 9999, path: 'properties', group: 'charges' },
    { key: 'recharge', label: 'Recharges', type: 'text', max: 40, path: 'properties', group: 'charges' },
    { key: 'save_dc', label: 'Save DC', type: 'text', max: 20, path: 'properties', group: 'charges' },

    { key: 'effect', label: 'Effect / rules', type: 'textarea', rows: 5, max: 2000, path: 'properties', group: 'effect', wide: true },
    { key: 'source', label: 'Source / notes', type: 'textarea', rows: 3, max: 200, path: 'properties', group: 'source', wide: true },
  ];

  const CLAIMED = new Set(FIELDS.filter((f) => f.path === 'properties').map((f) => f.key));
  const MAX_PROPS_BYTES = 8192;

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

  function el(tag, opts = {}) {
    const n = document.createElement(tag);
    if (opts.text !== undefined) n.textContent = opts.text;
    if (opts.cls) n.className = opts.cls;
    return n;
  }
  function fieldById(key) { return FIELDS.find((f) => f.key === key); }

  function valueOf(item, field) {
    if (!item) return '';
    if (field.type === 'json') {
      const blob = item.properties || {};
      const leftover = {};
      for (const k of Object.keys(blob)) if (!CLAIMED.has(k)) leftover[k] = blob[k];
      return Object.keys(leftover).length ? JSON.stringify(leftover, null, 2) : '';
    }
    const v = field.path === 'properties' ? (item.properties || {})[field.key] : item[field.key];
    if (field.type === 'bool') return v === true ? 'true' : '';
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function playerProjection(draft) {
    if (draft.identified) {
      return {
        identified: true, name: draft.name, img_url: draft.img_url, type: draft.type,
        weight: draft.weight, description: draft.description, properties: draft.properties || {},
      };
    }
    // Unidentified: only type + image reach a player. We also carry the three
    // IMAGE FRAMING values (how the picture is cropped) — not secret, and the
    // blurred art should still be framed the way the GM set it — but nothing
    // else from properties (no damage, effect, rarity, …).
    const src = draft.properties || {};
    const frameOnly = {};
    if (src.img_offset_x !== undefined) frameOnly.img_offset_x = src.img_offset_x;
    if (src.img_offset_y !== undefined) frameOnly.img_offset_y = src.img_offset_y;
    if (src.img_scale !== undefined) frameOnly.img_scale = src.img_scale;
    return { identified: false, type: draft.type, img_url: draft.img_url, properties: frameOnly };
  }

  function render(container, ctx) {
    container.textContent = '';
    container.className = 'item-editor';
    const item = ctx.item || null;
    const isNew = !item;

    const draft = {
      name: valueOf(item, fieldById('name')),
      type: valueOf(item, fieldById('type')) || 'misc',
      identified: valueOf(item, fieldById('identified')) === 'true',
      img_url: valueOf(item, fieldById('img_url')),
      description: valueOf(item, fieldById('description')),
      weight: valueOf(item, fieldById('weight')),
      properties: JSON.parse(JSON.stringify((item && item.properties) || {})),
    };
    const inputs = new Map();
    let dirty = false;
    function markDirty() {
      if (!dirty) { dirty = true; if (ctx.onDirtyChange) ctx.onDirtyChange(true); }
      updateSaveState();
    }

    const who = document.getElementById('itemWho');
    if (who) who.textContent = isNew ? 'New item' : 'Edit item';

    const errSummary = el('p', { cls: 'ie-err-summary' });
    errSummary.setAttribute('role', 'alert');
    errSummary.hidden = true;
    container.appendChild(errSummary);

    const identity = el('div', { cls: 'ie-identity' });
    // Larger image with a hover/focus edit affordance (mirrors the dashboard
    // profile avatar): clicking opens a small image editor popover.
    const thumbBtn = el('button', { cls: 'ie-thumb-btn' }); thumbBtn.type = 'button';
    thumbBtn.setAttribute('aria-label', 'Change image');
    const thumb = el('span', { cls: 'ie-thumb' });
    const thumbImg = document.createElement('img'); thumbImg.alt = '';
    const thumbEmpty = el('span', { cls: 'ie-thumb-empty', text: 'No image' });
    thumbImg.addEventListener('error', () => { thumbImg.style.display = 'none'; thumbEmpty.style.display = 'grid'; });
    thumb.appendChild(thumbImg); thumb.appendChild(thumbEmpty);
    const thumbOverlay = el('span', { cls: 'ie-thumb-overlay' });
    thumbBtn.appendChild(thumb); thumbBtn.appendChild(thumbOverlay);
    thumbBtn.addEventListener('click', () => openImageEditor());
    function syncThumb() {
      const u = draft.img_url.trim();
      if (u) {
        thumbImg.src = u; thumbImg.style.display = 'block'; thumbEmpty.style.display = 'none';
        const ox = Number(draft.properties.img_offset_x) || 0;
        const oy = Number(draft.properties.img_offset_y) || 0;
        const sc = Number(draft.properties.img_scale) > 0 ? Number(draft.properties.img_scale) : 1;
        thumbImg.style.transform = 'translate(' + (ox * 100) + '%, ' + (oy * 100) + '%) scale(' + sc + ')';
        thumbImg.style.transformOrigin = 'center';
      } else { thumbImg.removeAttribute('src'); thumbImg.style.display = 'none'; thumbEmpty.style.display = 'grid'; }
    }
    identity.appendChild(thumbBtn);

    const idMain = el('div', { cls: 'ie-id-main' });
    const nameWrap = el('div', { cls: 'ie-namewrap' });
    const nameLab = el('label', { cls: 'ie-lab', text: 'Name' }); nameLab.setAttribute('for', 'item-name');
    const nameInput = el('input', { cls: 'ie-name' });
    nameInput.type = 'text'; nameInput.id = 'item-name'; nameInput.maxLength = 100;
    nameInput.placeholder = 'Item name'; nameInput.value = draft.name;
    const nameErr = el('div', { cls: 'ie-field-err' }); nameErr.id = 'item-name-err';
    nameInput.setAttribute('aria-describedby', 'item-name-err');
    nameInput.addEventListener('input', () => { draft.name = nameInput.value; markDirty(); });
    nameWrap.appendChild(nameLab); nameWrap.appendChild(nameInput); nameWrap.appendChild(nameErr);
    inputs.set('name', { field: fieldById('name'), node: nameInput, errNode: nameErr, get: () => nameInput.value });
    idMain.appendChild(nameWrap);

    const metaRow = el('div', { cls: 'ie-row2' });
    const typeCell = ddSelect('type', 'Type', TYPES, TYPE_LABELS, draft.type, (v) => { draft.type = v; markDirty(); syncTypeSections(); });
    const rarityCell = ddSelect('rarity', 'Rarity', RARITIES, RARITY_LABELS, (draft.properties.rarity || ''), (v) => { setProp('rarity', v || undefined); markDirty(); });
    metaRow.appendChild(typeCell.cell); metaRow.appendChild(rarityCell.cell);
    idMain.appendChild(metaRow);
    identity.appendChild(idMain);
    container.appendChild(identity);

    // The image URL lives in a hidden input (kept for the #item-img_url contract
    // and tests); it is edited through the popover the image button opens.
    const imgHidden = el('input'); imgHidden.type = 'hidden'; imgHidden.id = 'item-img_url'; imgHidden.value = draft.img_url;
    container.appendChild(imgHidden);
    inputs.set('img_url', { field: fieldById('img_url'), node: imgHidden, errNode: el('div'), get: () => imgHidden.value });

    function setImage(url, framing) {
      draft.img_url = url || '';
      imgHidden.value = draft.img_url;
      // Item art framing lives in properties (items have no dedicated columns).
      // A new image with no crop resets to identity; an explicit crop is stored.
      if (framing) {
        setProp('img_offset_x', framing.offsetX || 0);
        setProp('img_offset_y', framing.offsetY || 0);
        setProp('img_scale', framing.scale > 0 ? framing.scale : 1);
      } else if (!url) {
        setProp('img_offset_x', undefined);
        setProp('img_offset_y', undefined);
        setProp('img_scale', undefined);
      }
      syncThumb(); markDirty();
    }

    // The image button opens the site's shared image picker (the same grid modal
    // the dashboard uses) when the caller wires ctx.onPickImage; it hands back a
    // chosen URL and (when framing is offered) a crop. Without that hook (e.g. the
    // standalone harness) we fall back to a small URL popover.
    function openImageEditor() {
      if (typeof ctx.onPickImage === 'function') {
        const curFrame = {
          offsetX: Number(draft.properties.img_offset_x) || 0,
          offsetY: Number(draft.properties.img_offset_y) || 0,
          scale: Number(draft.properties.img_scale) > 0 ? Number(draft.properties.img_scale) : 1,
        };
        ctx.onPickImage(draft.img_url, (url, framing) => setImage(url, framing), curFrame);
        return;
      }
      let ov = container.querySelector('.ie-imgedit-overlay');
      if (ov) ov.remove();
      ov = el('div', { cls: 'ie-imgedit-overlay' });
      const card = el('div', { cls: 'ie-imgedit-card' });
      const bar = el('div', { cls: 'ie-preview-bar' });
      bar.appendChild(el('span', { cls: 'ie-preview-title', text: 'Item image' }));
      const x = el('button', { cls: 'btn small secondary', text: 'Close' }); x.type = 'button';
      x.addEventListener('click', () => ov.remove());
      bar.appendChild(x);
      card.appendChild(bar);
      const lab = el('label', { cls: 'ie-lab', text: 'Image URL' }); lab.setAttribute('for', 'ie-img-url-field');
      const inp = el('input'); inp.type = 'text'; inp.id = 'ie-img-url-field'; inp.maxLength = fieldById('img_url').max;
      inp.placeholder = 'https://example.com/sword.png'; inp.value = draft.img_url;
      inp.addEventListener('input', () => setImage(inp.value));
      card.appendChild(lab); card.appendChild(inp);
      card.appendChild(el('div', { cls: 'ie-help', text: 'Paste an image link, or copy one from the Image library.' }));
      const actions = el('div', { cls: 'ie-imgedit-actions' });
      const remove = el('button', { cls: 'btn small secondary', text: 'Remove image' }); remove.type = 'button';
      remove.addEventListener('click', () => { setImage(''); inp.value = ''; });
      const done = el('button', { cls: 'btn small primary', text: 'Done' }); done.type = 'button';
      done.addEventListener('click', () => ov.remove());
      actions.appendChild(remove); actions.appendChild(done);
      card.appendChild(actions);
      ov.appendChild(card);
      ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
      container.appendChild(ov);
      inp.focus();
    }

    const known = el('div', { cls: 'ie-known' });
    const knownLabel = el('label', { cls: 'ie-check-row' });
    const knownInput = el('input'); knownInput.type = 'checkbox'; knownInput.id = 'item-identified';
    knownInput.checked = draft.identified;
    knownInput.addEventListener('change', () => { draft.identified = knownInput.checked; markDirty(); });
    knownLabel.appendChild(knownInput);
    const knownText = el('div', { cls: 'ie-check-text' });
    knownText.appendChild(el('div', { cls: 'ie-check-title', text: 'Identified' }));
    knownLabel.appendChild(knownText);
    known.appendChild(knownLabel);
    inputs.set('identified', { field: fieldById('identified'), node: knownInput, errNode: el('div'), get: () => knownInput.checked });
    container.appendChild(known);

    {
      const f = fieldById('description');
      const cell = el('div', { cls: 'ie-cell wide ie-block' });
      const lab = el('label', { cls: 'ie-lab', text: 'Description' }); lab.setAttribute('for', 'item-description');
      const ta = el('textarea'); ta.id = 'item-description'; ta.rows = 4; ta.maxLength = f.max; ta.value = draft.description;
      ta.addEventListener('input', () => { draft.description = ta.value; markDirty(); });
      cell.appendChild(lab); cell.appendChild(ta);
      cell.appendChild(el('div', { cls: 'ie-help', text: 'What the item is.' }));
      container.appendChild(cell);
      inputs.set('description', { field: f, node: ta, errNode: el('div'), get: () => ta.value });
    }

    const effectDisc = disclosure('Effect / rules', 'ie-disc-effect', false);
    buildPropField(effectDisc.body, 'effect');
    effectDisc.body.appendChild(el('p', { cls: 'ie-help', text: 'What the item does \u2014 kept separate from the description.' }));
    container.appendChild(effectDisc.root);

    const weaponSec = el('section', { cls: 'ie-typesec' });
    weaponSec.appendChild(el('h3', { cls: 'ie-sec-title', text: 'Weapon' }));
    const weaponGrid = el('div', { cls: 'ie-grid' });
    ['damage', 'damage_type', 'weapon_range', 'weapon_properties'].forEach((k) => buildPropField(weaponGrid, k));
    weaponSec.appendChild(weaponGrid);
    container.appendChild(weaponSec);

    const armorSec = el('section', { cls: 'ie-typesec' });
    armorSec.appendChild(el('h3', { cls: 'ie-sec-title', text: 'Armour' }));
    const armorGrid = el('div', { cls: 'ie-grid' });
    ['armor_class', 'armor_type', 'strength_req', 'stealth_disadvantage'].forEach((k) => buildPropField(armorGrid, k));
    armorSec.appendChild(armorGrid);
    container.appendChild(armorSec);

    const extraDisc = disclosure('Additional details', 'ie-disc-extra', false);
    const extraGrid = el('div', { cls: 'ie-grid' });
    buildColumnField(extraGrid, 'weight');
    buildPropField(extraGrid, 'cost');
    buildPropField(extraGrid, 'magical');
    buildPropField(extraGrid, 'requires_attunement');
    extraDisc.body.appendChild(extraGrid);
    const attuneCellWrap = el('div', { cls: 'ie-cell wide' });
    buildPropField(attuneCellWrap, 'attunement_note');
    extraDisc.body.appendChild(attuneCellWrap);
    // "Other saved properties": values kept from a previous item type. Preserved
    // on save unless explicitly cleared. (Lives here now that Advanced is gone.)
    const orphanWrap = el('div', { cls: 'ie-orphan' });
    extraDisc.body.appendChild(orphanWrap);
    container.appendChild(extraDisc.root);

    const chargesDisc = disclosure('Charges', 'ie-disc-charges', false);
    const chargesGrid = el('div', { cls: 'ie-grid' });
    ['charges', 'charges_max', 'recharge', 'save_dc'].forEach((k) => buildPropField(chargesGrid, k));
    chargesDisc.body.appendChild(chargesGrid);
    chargesDisc.body.appendChild(el('p', { cls: 'ie-help', text: 'Recorded only; nothing spends or restores charges.' }));
    container.appendChild(chargesDisc.root);

    const sourceDisc = disclosure('Source / notes', 'ie-disc-source', false);
    buildPropField(sourceDisc.body, 'source');
    container.appendChild(sourceDisc.root);

    const footer = el('div', { cls: 'ie-footer' });
    const cancelBtn = el('button', { cls: 'btn small secondary', text: 'Cancel' }); cancelBtn.type = 'button';
    const spacer = el('span', { cls: 'ie-footer-spacer' });
    const previewBtn = el('button', { cls: 'btn small secondary', text: 'Preview player view' }); previewBtn.type = 'button';
    const saveBtn = el('button', { cls: 'btn small primary', text: isNew ? 'Create item' : 'Save changes' }); saveBtn.type = 'button';
    const status = el('span', { cls: 'ie-status' }); status.setAttribute('aria-live', 'polite');
    footer.appendChild(cancelBtn); footer.appendChild(previewBtn); footer.appendChild(spacer);
    footer.appendChild(status); footer.appendChild(saveBtn);
    container.appendChild(footer);

    function setProp(key, value) {
      if (value === undefined || value === '' || value === false) delete draft.properties[key];
      else draft.properties[key] = value;
    }

    // A labelled custom dropdown (the site's .vtt-dd), driven by
    // VTTCommon.initDropdown. A hidden input carries the value under
    // #item-<key> and fires `change`, so the save/test contract is unchanged.
    let ddSeq = 0;
    function ddSelect(key, label, options, labels, value, onChange) {
      const cell = el('div', { cls: 'ie-cell' });
      const id = 'item-' + key;
      const lab = el('label', { cls: 'ie-lab', text: label }); lab.setAttribute('for', id);
      const dd = el('div', { cls: 'vtt-dd' }); dd.setAttribute('data-value', value);
      const hidden = el('input'); hidden.type = 'hidden'; hidden.id = id; hidden.value = value;
      const btn = el('button', { cls: 'vtt-dd-btn' }); btn.type = 'button';
      btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
      btn.id = id + '-btn';
      const ul = el('ul', { cls: 'vtt-dd-list' }); ul.setAttribute('role', 'listbox'); ul.setAttribute('tabindex', '-1'); ul.hidden = true;
      ul.setAttribute('aria-label', label);
      dd.appendChild(hidden); dd.appendChild(btn); dd.appendChild(ul);
      cell.appendChild(lab); cell.appendChild(dd);
      const ddOptions = options.map((o) => ({ value: o, label: (labels && labels[o]) || (o === '' ? '—' : o) }));
      // Set the button's initial text.
      const initial = ddOptions.find((o) => o.value === value);
      btn.textContent = initial ? initial.label : (ddOptions[0] && ddOptions[0].label) || '';
      hidden.addEventListener('change', () => onChange(hidden.value));
      if (window.VTTCommon && window.VTTCommon.initDropdown) {
        window.VTTCommon.initDropdown(dd, ddOptions);
      }
      const f = fieldById(key);
      if (f) inputs.set(key, { field: f, node: hidden, errNode: el('div'), get: () => hidden.value });
      return { cell };
    }

    function buildPropField(parent, key) {
      const f = fieldById(key);
      const cell = el('div', { cls: 'ie-cell' + (f.wide ? ' wide' : '') });
      const id = 'item-' + key;
      const errNode = el('div', { cls: 'ie-field-err' }); errNode.id = id + '-err';
      let node;
      if (f.type === 'bool') {
        const row = el('label', { cls: 'ie-check-row inline' });
        node = el('input'); node.type = 'checkbox'; node.id = id;
        node.checked = draft.properties[key] === true;
        node.addEventListener('change', () => { setProp(key, node.checked); markDirty(); if (key === 'requires_attunement') syncAttuneNote(); });
        row.appendChild(node); row.appendChild(el('span', { text: f.label }));
        cell.appendChild(row);
      } else if (f.type === 'select') {
        // Custom dropdown (.vtt-dd) matching the site's other lists.
        const lab = el('label', { cls: 'ie-lab', text: f.label }); lab.setAttribute('for', id);
        const dd = el('div', { cls: 'vtt-dd' });
        const hidden = el('input'); hidden.type = 'hidden'; hidden.id = id; hidden.value = draft.properties[key] || '';
        const btn = el('button', { cls: 'vtt-dd-btn' }); btn.type = 'button'; btn.id = id + '-btn';
        btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
        const ul = el('ul', { cls: 'vtt-dd-list' }); ul.setAttribute('role', 'listbox'); ul.setAttribute('tabindex', '-1'); ul.hidden = true;
        ul.setAttribute('aria-label', f.label);
        dd.appendChild(hidden); dd.appendChild(btn); dd.appendChild(ul);
        const ddOptions = f.options.map((o) => ({ value: o, label: (f.labels && f.labels[o]) || (o === '' ? '\u2014' : o) }));
        const initial = ddOptions.find((o) => o.value === hidden.value);
        btn.textContent = initial ? initial.label : ddOptions[0].label;
        hidden.addEventListener('change', () => { setProp(key, hidden.value || undefined); markDirty(); });
        if (window.VTTCommon && window.VTTCommon.initDropdown) window.VTTCommon.initDropdown(dd, ddOptions);
        cell.appendChild(lab); cell.appendChild(dd);
        if (f.help) cell.appendChild(el('div', { cls: 'ie-help', text: f.help }));
        cell.appendChild(errNode);
        parent.appendChild(cell);
        inputs.set(key, { field: f, node: hidden, errNode, get: () => hidden.value });
        return;
      } else if (f.type === 'textarea' || f.type === 'json') {
        const lab = el('label', { cls: 'ie-lab', text: f.label }); lab.setAttribute('for', id);
        node = el('textarea'); node.id = id; node.rows = f.rows || 6; if (f.max) node.maxLength = f.max;
        node.value = draft.properties[key] != null ? String(draft.properties[key]) : '';
        node.setAttribute('aria-describedby', errNode.id);
        node.addEventListener('input', () => {
          setProp(key, node.value === '' ? undefined : node.value);
          markDirty();
        });
        cell.appendChild(lab); cell.appendChild(node);
      } else {
        const lab = el('label', { cls: 'ie-lab', text: f.label }); lab.setAttribute('for', id);
        node = el('input'); node.id = id;
        if (f.type === 'int' || f.type === 'decimal') {
          node.type = 'number';
          if (f.type === 'decimal') node.step = '0.01';
          if (f.min !== undefined) node.min = String(f.min);
          if (f.max !== undefined && f.type === 'int') node.max = String(f.max);
        } else { node.type = 'text'; if (f.max) node.maxLength = f.max; }
        const cur = draft.properties[key];
        node.value = cur === undefined || cur === null ? '' : String(cur);
        node.setAttribute('aria-describedby', errNode.id);
        node.addEventListener('input', () => {
          if (node.value === '') { setProp(key, undefined); }
          else if (f.type === 'int') { const n = Number(node.value); setProp(key, Number.isInteger(n) ? n : node.value); }
          else { setProp(key, node.value); }
          markDirty();
        });
        cell.appendChild(lab); cell.appendChild(node);
      }
      if (f.help) cell.appendChild(el('div', { cls: 'ie-help', text: f.help }));
      cell.appendChild(errNode);
      parent.appendChild(cell);
      inputs.set(key, { field: f, node, errNode, get: () => (f.type === 'bool' ? node.checked : node.value) });
    }

    function buildColumnField(parent, key) {
      const f = fieldById(key);
      const cell = el('div', { cls: 'ie-cell' });
      const id = 'item-' + key;
      const lab = el('label', { cls: 'ie-lab', text: f.label }); lab.setAttribute('for', id);
      const errNode = el('div', { cls: 'ie-field-err' }); errNode.id = id + '-err';
      const node = el('input'); node.type = 'number'; node.id = id;
      if (f.type === 'decimal') node.step = '0.01';
      if (f.min !== undefined) node.min = String(f.min);
      node.value = draft.weight;
      node.setAttribute('aria-describedby', errNode.id);
      node.addEventListener('input', () => { draft.weight = node.value; markDirty(); });
      cell.appendChild(lab); cell.appendChild(node); cell.appendChild(errNode);
      parent.appendChild(cell);
      inputs.set(key, { field: f, node, errNode, get: () => node.value });
    }

    function disclosure(title, cls, openInitially) {
      const root = el('section', { cls: 'ie-disc ' + cls });
      const btn = el('button', { cls: 'ie-disc-head' }); btn.type = 'button';
      btn.setAttribute('aria-expanded', openInitially ? 'true' : 'false');
      btn.appendChild(el('span', { cls: 'ie-chev', text: '\u25b8' }));
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

    function syncTypeSections() {
      weaponSec.hidden = draft.type !== 'weapon';
      armorSec.hidden = draft.type !== 'armor';
      syncOrphans();
    }
    function syncAttuneNote() {
      const on = draft.properties.requires_attunement === true || (draft.properties.attunement_note != null && draft.properties.attunement_note !== '');
      attuneCellWrap.hidden = !on;
    }
    const WEAPON_KEYS = ['damage', 'damage_type', 'weapon_range', 'weapon_properties'];
    const ARMOR_KEYS = ['armor_class', 'armor_type', 'strength_req', 'stealth_disadvantage'];
    function syncOrphans() {
      const orphanKeys = [];
      if (draft.type !== 'weapon') for (const k of WEAPON_KEYS) if (draft.properties[k] !== undefined) orphanKeys.push(k);
      if (draft.type !== 'armor') for (const k of ARMOR_KEYS) if (draft.properties[k] !== undefined) orphanKeys.push(k);
      orphanWrap.textContent = '';
      if (!orphanKeys.length) { orphanWrap.hidden = true; return; }
      orphanWrap.hidden = false;
      orphanWrap.appendChild(el('div', { cls: 'ie-lab', text: 'Other saved properties' }));
      orphanWrap.appendChild(el('div', { cls: 'ie-help', text: 'Kept from a different item type. They are preserved on save unless you clear them.' }));
      const list = el('div', { cls: 'ie-orphan-list' });
      for (const k of orphanKeys) list.appendChild(el('span', { cls: 'ie-orphan-chip', text: k + ': ' + draft.properties[k] }));
      orphanWrap.appendChild(list);
      const clear = el('button', { cls: 'btn small secondary', text: 'Clear these' }); clear.type = 'button';
      clear.addEventListener('click', () => { for (const k of orphanKeys) delete draft.properties[k]; markDirty(); syncOrphans(); });
      orphanWrap.appendChild(clear);
    }

    function updateExtraSummary() {
      const bits = [];
      if (draft.weight) bits.push('weight ' + draft.weight);
      if (draft.properties.cost) bits.push(String(draft.properties.cost));
      if (draft.properties.magical) bits.push('magical');
      if (draft.properties.requires_attunement) bits.push('attunement');
      extraDisc.setSummary(bits.join(' \u00b7 '));
    }
    function updateChargesSummary() {
      const c = draft.properties.charges, cm = draft.properties.charges_max;
      let s = '';
      if (c !== undefined || cm !== undefined) s = (c != null ? c : '\u2014') + '/' + (cm != null ? cm : '\u2014');
      chargesDisc.setSummary(s);
    }

    // Properties come straight off the draft. Unknown/custom keys that were on
    // the item are seeded into draft.properties at render and pass through here
    // untouched, so removing the Advanced JSON editor does not drop them.
    function assembleProps() {
      const next = {};
      for (const k of Object.keys(draft.properties)) {
        const v = draft.properties[k];
        if (v === undefined || v === '' || v === false) continue;
        next[k] = v;
      }
      return next;
    }

    // Reconcile the draft with the live DOM values. Normally the draft is kept
    // current by input handlers, but reading the DOM here makes save robust to
    // values set programmatically (e.g. tests, autofill) that fired no event.
    function syncDraftFromDom() {
      for (const [key, entry] of inputs) {
        const f = entry.field; const node = entry.node;
        if (!node) continue;
        if (key === 'name') draft.name = node.value;
        else if (key === 'type') draft.type = node.value;
        else if (key === 'identified') draft.identified = node.checked;
        else if (key === 'img_url') draft.img_url = node.value;
        else if (key === 'description') draft.description = node.value;
        else if (key === 'weight') draft.weight = node.value;
        else if (f && f.path === 'properties') {
          if (f.type === 'bool') setProp(key, node.checked);
          else if (node.value === '') setProp(key, undefined);
          else if (f.type === 'int') { const n = Number(node.value); setProp(key, Number.isInteger(n) ? n : node.value); }
          else setProp(key, node.value);
        }
      }
    }

    function currentPatch() {
      syncDraftFromDom();
      const patch = {};
      if (isNew || draft.name !== valueOf(item, fieldById('name'))) { if (draft.name !== '' || !isNew) patch.name = draft.name; }
      if (isNew || draft.type !== (valueOf(item, fieldById('type')) || 'misc')) patch.type = draft.type;
      if (isNew || draft.identified !== (valueOf(item, fieldById('identified')) === 'true')) patch.identified = draft.identified;
      if (isNew || draft.img_url !== valueOf(item, fieldById('img_url'))) { if (!(isNew && draft.img_url === '')) patch.img_url = draft.img_url; }
      if (isNew || draft.description !== valueOf(item, fieldById('description'))) { if (!(isNew && draft.description === '')) patch.description = draft.description; }
      const wPrev = valueOf(item, fieldById('weight'));
      if (isNew ? draft.weight !== '' : String(draft.weight) !== wPrev) { patch.weight = draft.weight === '' ? 0 : Number(draft.weight); }
      const nextProps = assembleProps();
      if (isNew ? Object.keys(nextProps).length > 0 : !sameJson(nextProps, (item && item.properties) || {})) patch.properties = nextProps;
      return patch;
    }
    function updateSaveState() {
      updateExtraSummary(); updateChargesSummary();
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
      for (const { errNode, node } of inputs.values()) { if (errNode) errNode.textContent = ''; if (node && node.removeAttribute) node.removeAttribute('aria-invalid'); }
    }
    function fieldError(key, msg, discToOpen) {
      const entry = inputs.get(key);
      if (entry) { entry.errNode.textContent = msg; if (entry.node.setAttribute) entry.node.setAttribute('aria-invalid', 'true'); }
      if (discToOpen) discToOpen.setOpen(true);
    }
    const KEY_DISC = {
      cost: extraDisc, magical: extraDisc, requires_attunement: extraDisc, attunement_note: extraDisc,
      weight: extraDisc, charges: chargesDisc, charges_max: chargesDisc, recharge: chargesDisc,
      save_dc: chargesDisc, effect: effectDisc, source: sourceDisc,
    };
    function showServerError(message) {
      const msg = String(message || 'The item could not be saved.');
      let placed = false;
      for (const key of inputs.keys()) {
        if (msg.includes(key)) { fieldError(key, msg, KEY_DISC[key]); placed = true; break; }
      }
      if (!placed) { errSummary.hidden = false; errSummary.textContent = msg; }
    }

    let saving = false;
    saveBtn.addEventListener('click', async () => {
      if (saving) return;
      clearErrors();
      syncDraftFromDom();
      let firstBad = null;
      if ((draft.name || '').trim() === '') { fieldError('name', 'A name is required.'); firstBad = firstBad || 'name'; }
      if (draft.weight !== '' && !Number.isFinite(Number(draft.weight))) { fieldError('weight', 'Numbers only.', extraDisc); firstBad = firstBad || 'weight'; }
      for (const k of ['charges', 'charges_max']) {
        const v = draft.properties[k];
        if (v !== undefined && !Number.isInteger(v)) { fieldError(k, 'Whole numbers only.', chargesDisc); firstBad = firstBad || k; }
      }
      // The 8 KB properties cap is still enforced (the server enforces it too);
      // with no Advanced/JSON field to blame, surface it as a summary error that
      // points at the long free-text fields.
      const nextProps = assembleProps();
      const bytes = new TextEncoder().encode(JSON.stringify(nextProps)).length;
      if (bytes > MAX_PROPS_BYTES) {
        errSummary.hidden = false;
        errSummary.textContent = 'This item stores ' + bytes.toLocaleString() + ' bytes of details; the limit is ' + MAX_PROPS_BYTES.toLocaleString() + '. Shorten the Effect or Source text.';
        firstBad = firstBad || 'effect';
        effectDisc.setOpen(true);
      }
      if (firstBad) {
        if (errSummary.hidden) { errSummary.hidden = false; errSummary.textContent = 'Please fix the highlighted field.'; }
        const e = inputs.get(firstBad); if (e && e.node && e.node.focus) e.node.focus();
        return;
      }
      const patch = currentPatch();
      if (!isNew && Object.keys(patch).length === 0) { status.textContent = 'No changes'; return; }
      saving = true; saveBtn.disabled = true; const prevLabel = saveBtn.textContent; saveBtn.textContent = 'Saving\u2026'; status.textContent = '';
      try {
        const r = await ctx.onSave(patch, isNew);
        if (r && (r.status === 200 || r.status === 201)) {
          dirty = false; if (ctx.onDirtyChange) ctx.onDirtyChange(false);
          status.textContent = 'Saved';
          saving = false; saveBtn.textContent = prevLabel;
          if (ctx.onDone) ctx.onDone(r);
          return;
        }
        showServerError(r && r.data && r.data.error);
        status.textContent = 'Not saved';
      } catch (err) {
        errSummary.hidden = false; errSummary.textContent = 'Network error \u2014 your edits are kept. Try again.';
        status.textContent = 'Not saved';
      }
      saving = false; saveBtn.disabled = false; saveBtn.textContent = prevLabel;
    });

    cancelBtn.addEventListener('click', () => { if (ctx.requestClose) ctx.requestClose(); });
    previewBtn.addEventListener('click', () => { openPreview(container, playerProjection(draft)); });

    syncThumb();
    syncTypeSections();
    syncAttuneNote();
    syncOrphans();
    if ((draft.properties.effect != null && draft.properties.effect !== '') || (isNew && draft.type === 'consumable')) effectDisc.setOpen(true);
    if (['charges', 'charges_max', 'recharge', 'save_dc'].some((k) => draft.properties[k] !== undefined)) chargesDisc.setOpen(true);
    if (draft.weight || draft.properties.cost || draft.properties.magical || draft.properties.requires_attunement) extraDisc.setOpen(true);
    if (draft.properties.source) sourceDisc.setOpen(true);
    updateSaveState();
  }

  // Player read view — image-forward, following the common RPG item-card pattern
  // (Diablo/Destiny tooltips, Peter Schön's item-tooltip study): lead with the
  // art, then a title block with rarity colour, then the stats that matter as a
  // compact block, then description/effect prose, then minor metadata last.
  function renderRead(container, projected) {
    container.textContent = '';
    container.className = 'item-read';
    const p = projected || {};
    const identified = p.identified !== false && p.name !== undefined;
    const pr = (identified && p.properties) || {};
    const rarity = identified ? pr.rarity : '';

    // Framing geometry is available for BOTH states (unidentified carries only
    // the frame sub-keys), so read it from p.properties, not the identified-gated
    // `pr`. For the blurred unidentified image we bake a little extra zoom into
    // the same transform so the blur's soft edge can't reveal the frame beneath —
    // while still honouring the GM's crop.
    const fr = p.properties || {};
    const hero = el('div', { cls: 'ir-hero' + (identified ? '' : ' ir-hero-blur') });
    if (rarity && RARITY_COLOR[rarity]) hero.style.setProperty('--ir-rarity', RARITY_COLOR[rarity]);
    if (p.img_url) {
      const im = document.createElement('img'); im.alt = ''; im.src = p.img_url;
      const ox = Number(fr.img_offset_x) || 0, oy = Number(fr.img_offset_y) || 0;
      let sc = Number(fr.img_scale) > 0 ? Number(fr.img_scale) : 1;
      if (!identified) sc *= 1.25;   // extra cover for the blur edge
      im.style.transform = 'translate(' + (ox * 100) + '%, ' + (oy * 100) + '%) scale(' + sc + ')';
      im.style.transformOrigin = 'center';
      im.addEventListener('error', () => { im.remove(); hero.appendChild(el('div', { cls: 'ir-hero-empty', text: '?' })); });
      hero.appendChild(im);
    } else {
      hero.appendChild(el('div', { cls: 'ir-hero-empty', text: '?' }));
    }
    container.appendChild(hero);

    // Title block: name, then type · rarity (rarity in colour, not colour alone).
    const title = el('div', { cls: 'ir-title' });
    title.appendChild(el('h3', { cls: 'ir-name', text: identified ? (p.name || 'Item') : 'Unidentified item' }));
    const meta = el('div', { cls: 'ir-meta' });
    if (p.type) meta.appendChild(el('span', { cls: 'ir-type', text: TYPE_LABELS[p.type] || p.type }));
    if (rarity) {
      const dot = el('span', { cls: 'ir-dot' });
      if (RARITY_COLOR[rarity]) dot.style.background = RARITY_COLOR[rarity];
      const rlab = el('span', { cls: 'ir-rarity', text: RARITY_LABELS[rarity] || rarity });
      if (RARITY_COLOR[rarity]) rlab.style.color = RARITY_COLOR[rarity];
      meta.appendChild(dot); meta.appendChild(rlab);
    }
    title.appendChild(meta);
    container.appendChild(title);

    if (!identified) {
      container.appendChild(el('p', { cls: 'ir-unid', text: 'Not yet identified — its properties are hidden.' }));
      return;
    }

    // Key stats — the "rolls": the numbers a player scans for. Rendered as a
    // compact stat block (label over value), only for stats that exist.
    const stats = [];
    if (p.type === 'weapon') {
      const dmg = pr.damage_type ? (String(pr.damage || '') + ' ' + pr.damage_type).trim() : pr.damage;
      if (dmg) stats.push(['Damage', dmg]);
      if (pr.weapon_range) stats.push(['Range', pr.weapon_range]);
      if (pr.weapon_properties) stats.push(['Properties', pr.weapon_properties]);
    }
    if (p.type === 'armor') {
      if (pr.armor_class) stats.push(['Armour class', pr.armor_class]);
      if (pr.armor_type) stats.push(['Type', pr.armor_type]);
      if (pr.strength_req) stats.push(['Str. req', pr.strength_req]);
    }
    if (pr.charges !== undefined || pr.charges_max !== undefined) {
      stats.push(['Charges', (pr.charges != null ? pr.charges : '\u2014') + '/' + (pr.charges_max != null ? pr.charges_max : '\u2014')]);
    }
    if (pr.save_dc) stats.push(['Save DC', pr.save_dc]);
    if (stats.length) {
      const grid = el('div', { cls: 'ir-stats' });
      for (const [k, v] of stats) {
        const cell = el('div', { cls: 'ir-stat' });
        cell.appendChild(el('span', { cls: 'ir-stat-val', text: String(v) }));
        cell.appendChild(el('span', { cls: 'ir-stat-key', text: k }));
        grid.appendChild(cell);
      }
      container.appendChild(grid);
    }

    // Tags for at-a-glance flags (magical, attunement, stealth).
    const tags = [];
    if (pr.magical) tags.push('Magical');
    if (pr.requires_attunement) tags.push(pr.attunement_note ? ('Attunement: ' + pr.attunement_note) : 'Requires attunement');
    if (p.type === 'armor' && pr.stealth_disadvantage) tags.push('Stealth disadvantage');
    if (tags.length) {
      const tagRow = el('div', { cls: 'ir-tags' });
      for (const t of tags) tagRow.appendChild(el('span', { cls: 'ir-tag', text: t }));
      container.appendChild(tagRow);
    }

    // Prose: description then effect, each with a small label.
    if (p.description) {
      container.appendChild(el('div', { cls: 'ir-block-label', text: 'Description' }));
      container.appendChild(el('p', { cls: 'ir-prose', text: p.description }));
    }
    if (pr.effect) {
      container.appendChild(el('div', { cls: 'ir-block-label', text: 'Effect' }));
      container.appendChild(el('p', { cls: 'ir-prose ir-effect', text: pr.effect }));
    }

    // Footer: minor metadata, small and unobtrusive.
    const foot = [];
    if (p.weight) foot.push('Weight ' + p.weight);
    if (pr.cost) foot.push(String(pr.cost));
    if (foot.length) container.appendChild(el('div', { cls: 'ir-foot', text: foot.join('  ·  ') }));
  }

  function openPreview(hostContainer, projected) {
    // Mount in the open dialog when there is one (top layer), else the editor
    // container. Same approach as VTTImagePicker / VTTFrameTool, so the fixed
    // overlay centers in the viewport and renders above the dialog.
    const host = (typeof document !== 'undefined' && document.querySelector('dialog[open]')) || hostContainer;
    let overlay = host.querySelector('.ie-preview-overlay');
    if (overlay) overlay.remove();
    overlay = el('div', { cls: 'ie-preview-overlay' });
    const card = el('div', { cls: 'ie-preview-card' });
    const bar = el('div', { cls: 'ie-preview-bar' });
    bar.appendChild(el('span', { cls: 'ie-preview-title', text: 'Player view' }));
    const close = el('button', { cls: 'ie-preview-close' }); close.type = 'button';
    close.setAttribute('aria-label', 'Close'); close.textContent = '\u2715';
    close.addEventListener('click', () => overlay.remove());
    bar.appendChild(close);
    const readHost = el('div');
    renderRead(readHost, projected);
    card.appendChild(bar); card.appendChild(readHost);
    overlay.appendChild(card);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    host.appendChild(overlay);
    close.focus();
  }

  return {
    render, renderRead, playerProjection, FIELDS, TYPES,
    // For the Library grid: open the player read-view as an overlay, and the
    // shared rarity/type presentation so cards match the editor/preview.
    openPreview: (projected, host) => openPreview(host || document.body, projected),
    RARITY_COLOR, RARITY_LABELS, TYPE_LABELS,
  };
})();
