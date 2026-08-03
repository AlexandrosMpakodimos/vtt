// Item editor for the M4 harness — the counterpart to sheet.js.
//
// GM-ONLY end to end, and that needs no tier logic here because the server's
// POST / PATCH / DELETE on /items are all `requireOwner`. A player never reaches
// this panel; they read the catalogue through the projected list, where an
// unidentified item carries no name, description, properties or weight at all.
//
// Same split as the character sheet. Fields the `items` table models get a real
// column (name, type, weight, description, identified). Everything a tabletop
// item sheet also carries — rarity, attunement, damage, armour values, charges,
// cost — is a structured sub-key of `properties` (bounded JSONB, identical
// 8 KB / depth 6 / 200-key limits as `actors.data`). No migration, no new
// columns, no server change.
//
// NOTHING IS COMPUTED OR ENFORCED. Stated plainly because items are where the
// temptation is strongest:
//   - `armor_class` here is TEXT ("14 + Dex mod (max 2)") and is never added to
//     an actor's armor_class. database-decisions.md is explicit: items do not
//     auto-modify stats when equipped — the GM interprets.
//   - `damage` is text ("1d8"); nothing is rolled. Dice are M5.
//   - `requires_attunement` is a NOTE, not a gate. The 3-item attunement cap is
//     real and atomically enforced server-side, but whether a given item needs
//     attunement at all is the GM's call, so ticking this box does not stop you
//     attuning anything else and not ticking it does not stop you attuning this.
//   - `cost` is text ("50 gp"), so no currency arithmetic is implied against the
//     character sheet's CP/SP/EP/GP/PP fields. Nothing is deducted anywhere.
//   - `weight` is stored and displayed only. Encumbrance is out of scope.
//   - `charges` / `charges_max` are two integers; nothing spends or restores
//     them.

window.VTTItemSheet = (function () {
  const TYPES = ['weapon', 'armor', 'consumable', 'misc'];
  const RARITIES = ['', 'common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact'];
  const ARMOR_TYPES = ['', 'light', 'medium', 'heavy', 'shield'];

  // `path: 'properties'` means the value lives at properties[key] rather than in
  // a column. Bounds mirror validators.js — client-side they fail fast, they
  // never enforce.
  const FIELDS = [
    { key: 'name', label: 'Name', type: 'text', max: 100, group: 'basics', wide: true },
    { key: 'type', label: 'Type', type: 'select', options: TYPES, group: 'basics' },
    { key: 'weight', label: 'Weight (lb)', type: 'decimal', min: 0, max: 10000, group: 'basics' },
    { key: 'identified', label: 'Identified', type: 'bool', group: 'basics' },
    { key: 'img_url', label: 'Image URL', type: 'text', max: 2000, group: 'basics', wide: true },
    { key: 'description', label: 'Description', type: 'textarea', rows: 4, max: 2000, group: 'basics', wide: true },

    { key: 'rarity', label: 'Rarity', type: 'select', options: RARITIES, path: 'properties', group: 'nature' },
    { key: 'magical', label: 'Magical', type: 'bool', path: 'properties', group: 'nature' },
    { key: 'requires_attunement', label: 'Requires attunement', type: 'bool', path: 'properties', group: 'nature' },
    { key: 'cost', label: 'Cost', type: 'text', max: 30, path: 'properties', group: 'nature' },
    { key: 'attunement_note', label: 'Attunement note (e.g. "by a druid")', type: 'text', max: 120, path: 'properties', group: 'nature', wide: true },

    { key: 'damage', label: 'Damage', type: 'text', max: 30, path: 'properties', group: 'weapon' },
    { key: 'damage_type', label: 'Damage type', type: 'text', max: 30, path: 'properties', group: 'weapon' },
    { key: 'weapon_range', label: 'Range', type: 'text', max: 30, path: 'properties', group: 'weapon' },
    { key: 'weapon_properties', label: 'Properties (finesse, light, thrown…)', type: 'text', max: 120, path: 'properties', group: 'weapon', wide: true },

    { key: 'armor_class', label: 'Armour class (text)', type: 'text', max: 40, path: 'properties', group: 'armor' },
    { key: 'armor_type', label: 'Armour type', type: 'select', options: ARMOR_TYPES, path: 'properties', group: 'armor' },
    { key: 'strength_req', label: 'Strength requirement', type: 'text', max: 20, path: 'properties', group: 'armor' },
    { key: 'stealth_disadvantage', label: 'Stealth disadvantage', type: 'bool', path: 'properties', group: 'armor' },

    { key: 'charges', label: 'Charges', type: 'int', min: 0, max: 9999, path: 'properties', group: 'magic' },
    { key: 'charges_max', label: 'Max charges', type: 'int', min: 0, max: 9999, path: 'properties', group: 'magic' },
    { key: 'recharge', label: 'Recharges', type: 'text', max: 40, path: 'properties', group: 'magic' },
    { key: 'save_dc', label: 'Save DC', type: 'text', max: 20, path: 'properties', group: 'magic' },

    { key: 'effect', label: 'Effect', type: 'textarea', rows: 5, max: 2000, path: 'properties', group: 'text', wide: true },
    { key: 'source', label: 'Source / GM notes', type: 'textarea', rows: 3, max: 200, path: 'properties', group: 'text', wide: true },
    { key: 'properties', label: 'Advanced — any other keys, as JSON', type: 'json', group: 'text', wide: true },
  ];

  const GROUPS = [
    { id: 'basics', title: 'Item' },
    { id: 'nature', title: 'Nature', hint: 'Attunement here is a NOTE. The 3-item cap is enforced by the server; whether this particular item needs attunement is the GM\'s call and nothing checks it.' },
    { id: 'weapon', title: 'Weapon', hint: 'Text only — nothing is rolled. Dice arrive in M5.' },
    { id: 'armor', title: 'Armour', hint: 'Armour class here is text and is never added to a character\'s armor_class. Equipping does not modify stats — the GM interprets.' },
    { id: 'magic', title: 'Charges', hint: 'Two integers. Nothing spends or restores them.' },
    { id: 'text', title: 'Effect & notes' },
  ];

  const CLAIMED = new Set(FIELDS.filter((f) => f.path === 'properties').map((f) => f.key));
  const MAX_PROPS_BYTES = 8192;   // mirrors MAX_JSON_BYTES in validators.js


  // Key ORDER differs between the stored blob and the reassembled one: the raw
  // leftover keys are copied in first, then the structured fields. A plain
  // JSON.stringify comparison therefore reports an untouched sheet as dirty and
  // PATCHes the whole column on every save. Compare canonically instead.
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

  function valueOf(item, field) {
    if (!item) return field.type === 'bool' ? '' : '';
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

  /**
   * render(container, ctx)
   *   ctx = { item | null, onSave(patch, isNew) -> {status,data}, onDone() }
   * A null item is the create form; the same field set serves both, so a field
   * can never exist on one and be missing from the other.
   */
  function render(container, ctx) {
    container.textContent = '';
    const item = ctx.item || null;
    const isNew = !item;

    const head = el('div', { cls: 'sheet-head' });
    head.appendChild(el('b', { text: isNew ? 'New item' : item.name }));
    if (!isNew && !item.identified) head.appendChild(el('span', { cls: 'tag secret', text: 'unidentified' }));
    container.appendChild(head);

    const errBox = el('p', { cls: 'sheet-error' });
    container.appendChild(errBox);

    const inputs = new Map();

    for (const g of GROUPS) {
      const fields = FIELDS.filter((f) => f.group === g.id);
      if (!fields.length) continue;
      const fs = el('fieldset', { cls: 'sheet-group' });
      fs.appendChild(el('legend', { text: g.title }));
      if (g.hint) fs.appendChild(el('p', { cls: 'muted', text: g.hint }));

      const grid = el('div', { cls: 'sheet-grid' });
      for (const f of fields) {
        const cell = el('div', { cls: 'sheet-cell' + (f.wide ? ' wide' : '') });
        const id = `item-${f.key}`;
        const lab = el('label', { text: f.label });
        lab.setAttribute('for', id);
        cell.appendChild(lab);

        let node;
        if (f.type === 'bool') {
          node = el('input');
          node.type = 'checkbox';
          node.checked = valueOf(item, f) === 'true';
        } else if (f.type === 'select') {
          node = el('select');
          for (const o of f.options) {
            const opt = el('option', { text: o === '' ? '—' : o });
            opt.value = o;
            node.appendChild(opt);
          }
        } else if (f.type === 'textarea' || f.type === 'json') {
          node = el('textarea');
          node.rows = f.rows || 5;
          if (f.max) node.maxLength = f.max;
        } else {
          node = el('input');
          if (f.type === 'int' || f.type === 'decimal') {
            node.type = 'number';
            if (f.type === 'decimal') node.step = '0.01';
            if (f.min !== undefined) node.min = String(f.min);
            if (f.max !== undefined && f.type === 'int') node.max = String(f.max);
          } else {
            node.type = 'text';
            if (f.max) node.maxLength = f.max;
          }
        }
        node.id = id;
        if (f.type !== 'bool') node.value = valueOf(item, f);

        const errNode = el('div', { cls: 'field-error' });
        cell.appendChild(node);
        cell.appendChild(errNode);
        grid.appendChild(cell);
        inputs.set(f.key, { field: f, node, errNode });
      }
      fs.appendChild(grid);
      container.appendChild(fs);
    }

    const actions = el('div', { cls: 'row' });
    const saveBtn = el('button', { text: isNew ? 'create item' : 'save changes' });
    actions.appendChild(saveBtn);
    const status = el('span', { cls: 'muted' });
    actions.appendChild(status);
    const counter = el('span', { cls: 'muted' });
    actions.appendChild(counter);
    container.appendChild(actions);

    function clearErrors() {
      errBox.textContent = '';
      for (const { errNode } of inputs.values()) errNode.textContent = '';
    }

    // The server's 400s lead with the offending field name ("type must be one
    // of: …", "weight must be…"), so they can be placed beside their input.
    function showError(message) {
      const msg = String(message || 'request refused');
      let placed = false;
      for (const [key, { errNode }] of inputs) {
        if (msg.includes(key)) { errNode.textContent = msg; placed = true; }
      }
      if (!placed) errBox.textContent = msg;
    }

    // `properties` is one column, so every structured sub-field plus the leftover
    // blob is reassembled into a single object on each save. Booleans are stored
    // only when true, so an unticked flag costs nothing.
    function assembleProps(quiet) {
      const next = {};
      let bad = false;
      const jsonEntry = inputs.get('properties');
      if (jsonEntry) {
        const raw = jsonEntry.node.value.trim();
        if (raw !== '') {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null) {
              if (!quiet) { jsonEntry.errNode.textContent = 'must be a JSON object'; bad = true; }
            } else {
              for (const k of Object.keys(parsed)) {
                if (CLAIMED.has(k)) {
                  if (!quiet) { jsonEntry.errNode.textContent = `"${k}" already has its own field above — remove it here`; bad = true; }
                } else next[k] = parsed[k];
              }
            }
          } catch (e) {
            if (!quiet) { jsonEntry.errNode.textContent = 'invalid JSON: ' + e.message; bad = true; }
          }
        }
      }
      for (const [key, { field, node, errNode }] of inputs) {
        if (field.path !== 'properties') continue;
        if (field.type === 'bool') { if (node.checked) next[key] = true; continue; }
        const raw = node.value;
        if (raw === '') continue;
        if (field.type === 'int') {
          const n = Number(raw);
          if (!Number.isInteger(n)) { if (!quiet) { errNode.textContent = 'whole numbers only'; bad = true; } continue; }
          next[key] = n;
        } else next[key] = raw;
      }
      return bad ? null : next;
    }

    function refreshCounter() {
      const p = assembleProps(true) || {};
      const used = new TextEncoder().encode(JSON.stringify(p)).length;
      counter.textContent = `properties: ${used.toLocaleString()} / ${MAX_PROPS_BYTES.toLocaleString()} bytes`;
      counter.className = used > MAX_PROPS_BYTES ? 'sheet-error' : 'muted';
    }
    for (const { field, node } of inputs.values()) {
      if (field.path === 'properties' || field.type === 'json') {
        node.addEventListener('input', refreshCounter);
        node.addEventListener('change', refreshCounter);
      }
    }
    refreshCounter();

    saveBtn.addEventListener('click', async () => {
      clearErrors();
      const patch = {};
      let clientError = false;

      for (const [key, { field, node, errNode }] of inputs) {
        if (field.path === 'properties' || field.type === 'json') continue;
        if (field.type === 'bool') {
          const cur = valueOf(item, field) === 'true';
          if (isNew || node.checked !== cur) patch[key] = node.checked;
          continue;
        }
        const raw = node.value;
        // On create every non-empty field is sent; on edit only dirty ones are.
        if (!isNew && raw === valueOf(item, field)) continue;
        if (isNew && raw === '') continue;
        if (field.type === 'int' || field.type === 'decimal') {
          if (raw === '') { patch[key] = 0; continue; }
          const n = Number(raw);
          if (!Number.isFinite(n)) { errNode.textContent = 'numbers only'; clientError = true; continue; }
          if (field.type === 'int' && !Number.isInteger(n)) { errNode.textContent = 'whole numbers only'; clientError = true; continue; }
          patch[key] = n;
        } else patch[key] = raw;
      }

      const nextProps = assembleProps(false);
      if (nextProps === null) clientError = true;
      else if (isNew || !sameJson(nextProps, (item && item.properties) || {})) {
        patch.properties = nextProps;
      }

      if (!clientError && patch.properties) {
        const bytes = new TextEncoder().encode(JSON.stringify(patch.properties)).length;
        if (bytes > MAX_PROPS_BYTES) {
          errBox.textContent = `properties is ${bytes.toLocaleString()} bytes; the limit is ${MAX_PROPS_BYTES.toLocaleString()}. Shorten Effect, or move detail into Description, which is a separate column.`;
          clientError = true;
        }
      }

      if (isNew && !patch.name) { inputs.get('name').errNode.textContent = 'required'; clientError = true; }
      if (clientError) { status.textContent = 'not sent — fix the fields above'; return; }
      if (!isNew && Object.keys(patch).length === 0) { status.textContent = 'nothing changed'; return; }

      status.textContent = 'saving…';
      const r = await ctx.onSave(patch, isNew);
      if (r.status === 200 || r.status === 201) {
        status.textContent = isNew ? 'created' : `saved ${Object.keys(patch).length} field(s)`;
        if (ctx.onDone) ctx.onDone(r);
      } else {
        status.textContent = `refused (${r.status})`;
        showError(r.data && r.data.error);
      }
    });
  }

  return { render, FIELDS, TYPES };
})();
