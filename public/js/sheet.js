// Character sheet for the M4 harness.
//
// An ORIGINAL layout over the columns `actors` already has. It borrows the
// conventional *arrangement* of a tabletop character sheet — identity across the
// top, vitals and ability scores in blocks, free text at the bottom — because
// that arrangement is functional convention, not anyone's artwork. It copies no
// published sheet's design, trade dress or wording, which matters here because
// the thesis deliverables include the source code deposited in the university
// repository.
//
// Everything the server models gets a typed field. Everything it deliberately
// does NOT model — spell slots, hit dice, proficiencies, currency, backstory —
// goes in `notes` (TEXT) and `data` (bounded JSONB), which exist for exactly
// that purpose per database-decisions.md. That split is the design: structured
// where the server must enforce a rule or M5 must read a value, free text
// everywhere else.
//
// FIELD COVERAGE. The sheet now carries the CONTENT of a conventional tabletop
// character sheet. Fields the `actors` table models get a real column; everything
// the server deliberately does not model is a structured sub-key of `data`
// (bounded JSONB) or goes in `notes` (TEXT, 5000). No migration, no new columns,
// no server change — `data` is the overflow bucket database-decisions.md created
// for precisely this.
//
// REFUSED, and these are scope decisions rather than omissions:
//   - the 6 saving throws and 18 skills as a numeric grid with proficiency
//     checkboxes. That is 48 inputs whose only purpose is to be multiplied by a
//     proficiency bonus, and **the 18-skill system is on this project's
//     out-of-scope list by name**. Storing it without computing it is the skill
//     system's data model with the arithmetic missing, and the next question is
//     always "why doesn't it add up?". One free-text "Skills & proficiencies"
//     field covers the need: writing "Stealth +7" there is not a skill system.
//   - "Player Name". `actors.user_id` already answers it; a second editable copy
//     is the drift the derived-HP-bar rule exists to prevent.
//
// WHAT THIS FILE DOES NOT DO, deliberately:
//   - no point-buy or standard-array calculator (a cost table is a rule)
//   - no race/class dropdown that GRANTS anything (traits, proficiencies)
//   - no starting-equipment packs, no monster stat-block presets
//   - no derived ability modifiers or proficiency bonus — database-decisions.md
//     puts those client-side or in `data`, and computing them here is the first
//     step of a rules engine
//   - no clamping hp_current to hp_max, and no auto-anything on death saves
// The test applied throughout: does the form COMPUTE or GRANT something, or does
// it only collect what the user typed? Collecting is UI. Computing is a rules
// engine, and the rules engine is out of scope.

window.VTTSheet = (function () {
  const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];

  // MIRRORS the server's PLAYER_WRITABLE / GM_WRITABLE lists in
  // src/routes/actors.js. This copy is a UX convenience ONLY — the server
  // refuses a player's write to a `gm` field with a 403 regardless of what this
  // file believes, and that refusal is what the security suites assert. If the
  // two ever disagree, the server is right and this list is the bug.
  //
  // Bounds mirror ACTOR_INT_FIELDS in validators.js for the same reason: to fail
  // fast in the browser, never to be the thing that enforces them.
  const FIELDS = [
    { key: 'name', label: 'Character name', type: 'text', tier: 'player', group: 'identity', wide: true },
    { key: 'class', label: 'Class', type: 'text', tier: 'gm', group: 'identity' },
    { key: 'race', label: 'Race / ancestry', type: 'text', tier: 'gm', group: 'identity' },
    { key: 'level', label: 'Level', type: 'int', min: 1, max: 20, tier: 'gm', group: 'identity' },
    { key: 'size', label: 'Size', type: 'select', options: SIZES, tier: 'gm', group: 'identity' },
    { key: 'img_url', label: 'Portrait URL', type: 'text', tier: 'player', group: 'identity', wide: true },

    { key: 'hp_current', label: 'Current HP', type: 'int', min: -9999, max: 9999, tier: 'player', group: 'vitals' },
    { key: 'hp_max', label: 'Max HP', type: 'int', min: 0, max: 9999, tier: 'gm', group: 'vitals' },
    { key: 'hp_temp', label: 'Temp HP', type: 'int', min: 0, max: 9999, tier: 'player', group: 'vitals' },
    { key: 'armor_class', label: 'Armour class', type: 'int', min: 0, max: 99, tier: 'gm', group: 'vitals' },
    { key: 'speed', label: 'Speed', type: 'int', min: 0, max: 999, tier: 'gm', group: 'vitals' },

    { key: 'strength', label: 'STR', type: 'int', min: 1, max: 30, tier: 'gm', group: 'abilities' },
    { key: 'dexterity', label: 'DEX', type: 'int', min: 1, max: 30, tier: 'gm', group: 'abilities' },
    { key: 'constitution', label: 'CON', type: 'int', min: 1, max: 30, tier: 'gm', group: 'abilities' },
    { key: 'intelligence', label: 'INT', type: 'int', min: 1, max: 30, tier: 'gm', group: 'abilities' },
    { key: 'wisdom', label: 'WIS', type: 'int', min: 1, max: 30, tier: 'gm', group: 'abilities' },
    { key: 'charisma', label: 'CHA', type: 'int', min: 1, max: 30, tier: 'gm', group: 'abilities' },

    { key: 'death_save_successes', label: 'Death save successes', type: 'int', min: 0, max: 10, tier: 'player', group: 'death' },
    { key: 'death_save_failures', label: 'Death save failures', type: 'int', min: 0, max: 10, tier: 'player', group: 'death' },

    // --- everything below is stored inside actors.data -------------------
    // `path: 'data'` means the value lives at data[key] rather than in a column.
    // All of them are player-writable because `data` itself is: a player owns
    // their character's description. Maxlengths are budgeted against the 8192-byte
    // cap on `data` (~6,300 characters of content plus JSON overhead), and the
    // live counter under the group shows the remaining budget.
    { key: 'background', label: 'Background', type: 'text', max: 60, tier: 'player', path: 'data', group: 'identity' },
    { key: 'alignment', label: 'Alignment', type: 'text', max: 30, tier: 'player', path: 'data', group: 'identity' },
    { key: 'experience_points', label: 'XP', type: 'int', min: 0, max: 999999, tier: 'player', path: 'data', group: 'identity' },
    { key: 'inspiration', label: 'Inspiration', type: 'int', min: 0, max: 99, tier: 'player', path: 'data', group: 'identity' },
    { key: 'hit_dice', label: 'Hit dice', type: 'text', max: 40, tier: 'player', path: 'data', group: 'vitals' },
    { key: 'passive_perception', label: 'Passive perception', type: 'int', min: 0, max: 99, tier: 'player', path: 'data', group: 'vitals' },

    { key: 'cp', label: 'CP', type: 'int', min: 0, max: 9999999, tier: 'player', path: 'data', group: 'currency' },
    { key: 'sp', label: 'SP', type: 'int', min: 0, max: 9999999, tier: 'player', path: 'data', group: 'currency' },
    { key: 'ep', label: 'EP', type: 'int', min: 0, max: 9999999, tier: 'player', path: 'data', group: 'currency' },
    { key: 'gp', label: 'GP', type: 'int', min: 0, max: 9999999, tier: 'player', path: 'data', group: 'currency' },
    { key: 'pp', label: 'PP', type: 'int', min: 0, max: 9999999, tier: 'player', path: 'data', group: 'currency' },

    { key: 'attacks', label: 'Attacks & spellcasting', type: 'textarea', rows: 4, max: 800, tier: 'player', path: 'data', group: 'combat', wide: true },
    { key: 'proficiencies_languages', label: 'Other proficiencies & languages', type: 'textarea', rows: 3, max: 500, tier: 'player', path: 'data', group: 'combat', wide: true },
    { key: 'features_traits', label: 'Features & traits', type: 'textarea', rows: 5, max: 1000, tier: 'player', path: 'data', group: 'combat', wide: true },

    { key: 'personality_traits', label: 'Personality traits', type: 'textarea', rows: 3, max: 400, tier: 'player', path: 'data', group: 'character' },
    { key: 'ideals', label: 'Ideals', type: 'textarea', rows: 3, max: 300, tier: 'player', path: 'data', group: 'character' },
    { key: 'bonds', label: 'Bonds', type: 'textarea', rows: 3, max: 300, tier: 'player', path: 'data', group: 'character' },
    { key: 'flaws', label: 'Flaws', type: 'textarea', rows: 3, max: 300, tier: 'player', path: 'data', group: 'character' },
    { key: 'appearance', label: 'Appearance', type: 'textarea', rows: 3, max: 400, tier: 'player', path: 'data', group: 'character', wide: true },
    { key: 'allies_organisations', label: 'Allies & organisations', type: 'textarea', rows: 3, max: 600, tier: 'player', path: 'data', group: 'character', wide: true },
    { key: 'treasure', label: 'Treasure', type: 'textarea', rows: 3, max: 600, tier: 'player', path: 'data', group: 'character', wide: true },

    // Backstory and session notes go in the real TEXT column (5000 chars), not
    // in `data` — it is the one long-form field with room to spare, and putting
    // it here keeps the JSON budget for the short fields above.
    { key: 'notes', label: 'Backstory & session notes', type: 'textarea', rows: 6, max: 5000, tier: 'player', group: 'freeform', wide: true },
    { key: 'data', label: 'Advanced — any other keys, as JSON', type: 'json', tier: 'player', group: 'freeform', wide: true },
  ];

  // --- saving throws and skills ------------------------------------------
  //
  // ADDED 2026-08-02 as an EXPLICIT, RECORDED SCOPE DECISION by the student,
  // after the exclusion was flagged twice. `PROJECT_STATE.md` carries the change
  // against the out-of-scope list; it is not a quiet addition.
  //
  // The hard constraint that makes it acceptable: **nothing is computed.** These
  // are storage fields. The sheet does not derive a bonus from an ability score,
  // does not add a proficiency bonus to a checked skill, does not derive passive
  // perception from Wisdom, and does not validate that what you typed is
  // arithmetically consistent with anything else on the sheet. Whoever fills the
  // sheet in does the maths, exactly as they would on paper. The moment any of
  // these values is calculated rather than typed, this project has a rules
  // engine and the exclusion list has been broken in substance rather than form.
  //
  // Values are TEXT, not integers, because people write "+7" and "-1" — a signed
  // string is what a sheet actually holds, and an integer field would reject the
  // plus sign for no benefit. Proficiency flags are stored ONLY when true, so an
  // unproficient skill costs zero bytes in `data`.
  const SAVES = [
    ['sv_str', 'Strength'], ['sv_dex', 'Dexterity'], ['sv_con', 'Constitution'],
    ['sv_int', 'Intelligence'], ['sv_wis', 'Wisdom'], ['sv_cha', 'Charisma'],
  ];
  const SKILLS = [
    ['sk_acrobatics', 'Acrobatics', 'DEX'], ['sk_animal', 'Animal Handling', 'WIS'],
    ['sk_arcana', 'Arcana', 'INT'], ['sk_athletics', 'Athletics', 'STR'],
    ['sk_deception', 'Deception', 'CHA'], ['sk_history', 'History', 'INT'],
    ['sk_insight', 'Insight', 'WIS'], ['sk_intimidation', 'Intimidation', 'CHA'],
    ['sk_investigation', 'Investigation', 'INT'], ['sk_medicine', 'Medicine', 'WIS'],
    ['sk_nature', 'Nature', 'INT'], ['sk_perception', 'Perception', 'WIS'],
    ['sk_performance', 'Performance', 'CHA'], ['sk_persuasion', 'Persuasion', 'CHA'],
    ['sk_religion', 'Religion', 'INT'], ['sk_sleight', 'Sleight of Hand', 'DEX'],
    ['sk_stealth', 'Stealth', 'DEX'], ['sk_survival', 'Survival', 'WIS'],
  ];

  for (const [key, label] of SAVES) {
    FIELDS.push({ key: `${key}_p`, label: 'prof', type: 'bool', tier: 'player', path: 'data', group: 'saves', narrow: true });
    FIELDS.push({ key, label, type: 'text', max: 8, tier: 'player', path: 'data', group: 'saves', narrow: true });
  }
  for (const [key, label, abil] of SKILLS) {
    FIELDS.push({ key: `${key}_p`, label: 'prof', type: 'bool', tier: 'player', path: 'data', group: 'skills', narrow: true });
    // The ability abbreviation is part of the LABEL only. It is a reminder of
    // which score a table would use; the sheet never reads that score.
    FIELDS.push({ key, label: `${label} (${abil})`, type: 'text', max: 8, tier: 'player', path: 'data', group: 'skills', narrow: true });
  }

  // data keys claimed by structured fields above. The raw JSON editor shows only
  // what is left, so the two never fight over the same key.
  const CLAIMED = new Set(FIELDS.filter((f) => f.path === 'data').map((f) => f.key));
  const MAX_DATA_BYTES = 8192;   // mirrors MAX_JSON_BYTES in validators.js

  const GROUPS = [
    { id: 'identity', title: 'Identity' },
    { id: 'vitals', title: 'Vitals' },
    { id: 'abilities', title: 'Ability scores' },
    { id: 'saves', title: 'Saving throws', hint: 'Type the bonus yourself — nothing here is calculated from an ability score or a proficiency bonus.' },
    { id: 'skills', title: 'Skills', hint: 'Storage only. The tick marks proficiency for your own reference; it adds nothing to the number beside it.' },
    { id: 'currency', title: 'Currency', hint: 'Stored, never arithmetic — nothing is deducted or converted automatically.' },
    { id: 'combat', title: 'Attacks, proficiencies & features', hint: 'Free text on purpose. Attack bonuses are not computed, and there is no skill grid — the 18-skill system is out of scope, so write what you need here.' },
    { id: 'character', title: 'Character', hint: 'Personality, appearance, allies, treasure.' },
    { id: 'death', title: 'Death saves', hint: 'Two counters. The server stores them and never acts on them — no auto-stabilisation, no auto-death.' },
    {
      id: 'freeform',
      title: 'Free text',
      hint: 'Anything the fields above do not cover. The server stores it and never interprets it. `data` is bounded to 8 KB, depth 6 and 200 keys in total, including every field above.',
    },
  ];


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

  // A projected NPC has no hp_max key at all — the absence IS the signal, and it
  // is the same absence that makes the HP bar disappear for players.
  function isProjected(a) { return !('hp_max' in a); }

  function mayWrite(field, actor, ctx) {
    if (ctx.isGm) return true;
    if (!ctx.me || actor.user_id !== ctx.me.id) return false;
    return field.tier === 'player';
  }

  function valueOf(actor, field) {
    // The raw JSON editor shows only the UNCLAIMED keys, so editing "Ideals"
    // above and editing the blob below can never disagree about the same key.
    if (field.type === 'json') {
      const blob = actor.data || {};
      const leftover = {};
      for (const k of Object.keys(blob)) if (!CLAIMED.has(k)) leftover[k] = blob[k];
      return Object.keys(leftover).length ? JSON.stringify(leftover, null, 2) : '';
    }
    const v = field.path === 'data' ? (actor.data || {})[field.key] : actor[field.key];
    if (field.type === 'bool') return v === true ? 'true' : '';
    if (v === null || v === undefined) return '';
    return String(v);
  }

  /**
   * render(container, ctx)
   *   ctx = { actor, isGm, me, onSave(patch) -> {status,data}, onDelete() }
   */
  function render(container, ctx) {
    container.textContent = '';
    const a = ctx.actor;
    if (!a) {
      container.appendChild(el('p', { cls: 'muted', text: 'select a character' }));
      return;
    }

    const head = el('div', { cls: 'sheet-head' });
    head.appendChild(el('b', { text: a.name }));
    if (a.is_npc) head.appendChild(el('span', { cls: 'tag npc', text: 'NPC' }));
    if (ctx.me && a.user_id === ctx.me.id) head.appendChild(el('span', { cls: 'tag mine', text: 'yours' }));
    container.appendChild(head);

    // A player looking at an NPC they may see on the board gets the projection,
    // and the sheet says so plainly rather than rendering a page of blanks that
    // looks like a loading failure.
    if (isProjected(a)) {
      container.appendChild(el('p', {
        cls: 'muted',
        text: 'The GM has not shared this creature\'s statistics. You receive its name, portrait and size because its token is on the board — nothing else ever left the server.',
      }));
      return;
    }

    const errBox = el('p', { cls: 'sheet-error' });
    container.appendChild(errBox);

    const inputs = new Map();   // key -> { field, node, errNode }
    let anyWritable = false;

    for (const g of GROUPS) {
      const fields = FIELDS.filter((f) => f.group === g.id);
      if (!fields.length) continue;

      const fs = el('fieldset', { cls: 'sheet-group' });
      fs.appendChild(el('legend', { text: g.title }));
      if (g.hint) fs.appendChild(el('p', { cls: 'muted', text: g.hint }));

      const grid = el('div', { cls: 'sheet-grid' });
      for (const f of fields) {
        const writable = mayWrite(f, a, ctx);
        if (writable) anyWritable = true;

        const cell = el('div', { cls: 'sheet-cell' + (f.wide ? ' wide' : '') + (f.narrow ? ' narrow' : '') });
        const id = `sheet-${f.key}`;
        const lab = el('label', { text: f.label });
        lab.setAttribute('for', id);
        // GM-only fields are shown DISABLED rather than hidden. A player should
        // be able to read their own character's armour class; they simply may
        // not change it. Hiding it would make the sheet lie about the character.
        if (!writable) lab.appendChild(el('span', { cls: 'tag', text: 'GM' }));
        cell.appendChild(lab);

        let node;
        if (f.type === 'bool') {
          node = el('input');
          node.type = 'checkbox';
          node.checked = valueOf(a, f) === 'true';
        } else if (f.type === 'select') {
          node = el('select');
          for (const o of f.options) {
            const opt = el('option', { text: o });
            opt.value = o;
            node.appendChild(opt);
          }
        } else if (f.type === 'textarea' || f.type === 'json') {
          node = el('textarea');
          node.rows = f.rows || (f.type === 'json' ? 6 : 4);
          if (f.max) node.maxLength = f.max;
        } else {
          node = el('input');
          if (f.type === 'int') {
            node.type = 'number';
            if (f.min !== undefined) node.min = String(f.min);
            if (f.max !== undefined) node.max = String(f.max);
          } else {
            node.type = 'text';
            if (f.max) node.maxLength = f.max;
          }
        }
        node.id = id;
        if (f.type !== 'bool') node.value = valueOf(a, f);
        node.disabled = !writable;

        const errNode = el('div', { cls: 'field-error' });
        cell.appendChild(node);
        cell.appendChild(errNode);
        grid.appendChild(cell);
        inputs.set(f.key, { field: f, node, errNode });
      }
      fs.appendChild(grid);
      container.appendChild(fs);
    }

    if (!anyWritable) {
      container.appendChild(el('p', { cls: 'muted', text: 'read-only — you do not control this character' }));
      return;
    }

    const actions = el('div', { cls: 'row' });
    const saveBtn = el('button', { text: 'save changes' });
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

    // Put the server's message next to the field that caused it. The 403 lists
    // field names explicitly ("only the GM may change: strength, level"); the
    // 400s begin with the offending field name ("strength must be a whole
    // number"). Anything unmatched falls back to the box at the top rather than
    // vanishing.
    function showError(message) {
      const msg = String(message || 'request refused');
      let placed = false;
      for (const [key, { errNode }] of inputs) {
        const named = msg.includes(key);
        if (named) { errNode.textContent = msg; placed = true; }
      }
      if (!placed) errBox.textContent = msg;
    }

    // `data` is ONE column, so every structured sub-field plus the leftover blob
    // has to be reassembled into a single object on every save. Returns null on
    // a client-side error (already reported next to the offending field).
    function assembleData() {
      const next = {};
      let bad = false;

      const jsonEntry = inputs.get('data');
      if (jsonEntry && !jsonEntry.node.disabled) {
        const raw = jsonEntry.node.value.trim();
        if (raw !== '') {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null) {
              jsonEntry.errNode.textContent = 'must be a JSON object, e.g. {"familiar": "owl"}';
              bad = true;
            } else {
              for (const k of Object.keys(parsed)) {
                if (CLAIMED.has(k)) {
                  jsonEntry.errNode.textContent = `"${k}" already has its own field above — remove it here`;
                  bad = true;
                } else {
                  next[k] = parsed[k];
                }
              }
            }
          } catch (e) {
            jsonEntry.errNode.textContent = 'invalid JSON: ' + e.message;
            bad = true;
          }
        }
      } else {
        // Not editable by this viewer: preserve whatever is already stored.
        const blob = a.data || {};
        for (const k of Object.keys(blob)) if (!CLAIMED.has(k)) next[k] = blob[k];
      }

      for (const [key, { field, node, errNode }] of inputs) {
        if (field.path !== 'data') continue;
        if (node.disabled) {
          const cur = (a.data || {})[key];
          if (cur !== undefined) next[key] = cur;
          continue;
        }
        // Proficiency flags are stored ONLY when ticked, so an unproficient
        // skill costs nothing in the byte budget and absence means false.
        if (field.type === 'bool') {
          if (node.checked) next[key] = true;
          continue;
        }
        const raw = node.value;
        if (raw === '') continue;            // empty means "not on this sheet"
        if (field.type === 'int') {
          const n = Number(raw);
          if (!Number.isInteger(n)) { errNode.textContent = 'whole numbers only'; bad = true; continue; }
          next[key] = n;
        } else {
          next[key] = raw;
        }
      }
      return bad ? null : next;
    }

    function dataBytes() {
      const d = assembleDataQuietly();
      return d === null ? 0 : new TextEncoder().encode(JSON.stringify(d)).length;
    }
    // Same assembly, no error reporting — used by the live counter, which must
    // not paint errors while someone is mid-keystroke.
    function assembleDataQuietly() {
      const next = {};
      for (const [key, { field, node }] of inputs) {
        if (field.path !== 'data' || node.disabled) continue;
        if (field.type === 'bool') { if (node.checked) next[key] = true; continue; }
        const raw = node.value;
        if (raw === '') continue;
        next[key] = field.type === 'int' ? (Number(raw) || 0) : raw;
      }
      const jsonEntry = inputs.get('data');
      if (jsonEntry && !jsonEntry.node.disabled) {
        try {
          const parsed = JSON.parse(jsonEntry.node.value.trim() || '{}');
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const k of Object.keys(parsed)) if (!CLAIMED.has(k)) next[k] = parsed[k];
          }
        } catch { /* mid-typing, ignore */ }
      }
      return next;
    }

    function refreshCounter() {
      const used = dataBytes();
      counter.textContent = `data: ${used.toLocaleString()} / ${MAX_DATA_BYTES.toLocaleString()} bytes`;
      counter.className = used > MAX_DATA_BYTES ? 'sheet-error' : 'muted';
    }
    for (const { field, node } of inputs.values()) {
      if (field.path === 'data' || field.type === 'json') {
        node.addEventListener('input', refreshCounter);
        node.addEventListener('change', refreshCounter);
      }
    }
    refreshCounter();

    saveBtn.addEventListener('click', async () => {
      clearErrors();
      const patch = {};
      let clientError = false;

      // Column-backed fields first; only dirty ones are sent.
      for (const [key, { field, node, errNode }] of inputs) {
        if (field.path === 'data' || field.type === 'json') continue;
        if (node.disabled) continue;
        const raw = node.value;
        if (raw === valueOf(a, field)) continue;

        if (field.type === 'int') {
          if (raw === '') { errNode.textContent = 'required'; clientError = true; continue; }
          const n = Number(raw);
          if (!Number.isInteger(n)) { errNode.textContent = 'whole numbers only'; clientError = true; continue; }
          patch[key] = n;
        } else {
          patch[key] = raw;
        }
      }

      // `data` is all-or-nothing: it is a single column, so any change to any
      // sub-field means sending the whole reassembled object.
      const nextData = assembleData();
      if (nextData === null) clientError = true;
      else if (!sameJson(nextData, a.data || {})) patch.data = nextData;

      if (!clientError && patch.data) {
        const bytes = new TextEncoder().encode(JSON.stringify(patch.data)).length;
        if (bytes > MAX_DATA_BYTES) {
          errBox.textContent = `data is ${bytes.toLocaleString()} bytes; the limit is ${MAX_DATA_BYTES.toLocaleString()}. Move long prose into Backstory, which is a separate 5000-character column.`;
          clientError = true;
        }
      }

      if (clientError) { status.textContent = 'not sent — fix the fields above'; return; }
      if (Object.keys(patch).length === 0) { status.textContent = 'nothing changed'; return; }

      status.textContent = 'saving…';
      const r = await ctx.onSave(patch);
      if (r.status === 200) {
        status.textContent = `saved ${Object.keys(patch).length} field(s)`;
      } else {
        status.textContent = `refused (${r.status})`;
        showError(r.data && r.data.error);
      }
    });
  }

  return { render, FIELDS, SIZES, isProjected };
})();
