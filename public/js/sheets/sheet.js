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
    { key: 'class', label: 'Class', type: 'text', tier: 'player', group: 'identity' },
    { key: 'race', label: 'Race / ancestry', type: 'text', tier: 'player', group: 'identity' },
    { key: 'level', label: 'Level', type: 'int', min: 1, max: 20, tier: 'player', group: 'identity' },
    { key: 'size', label: 'Size', type: 'select', options: SIZES, tier: 'player', group: 'identity' },
    { key: 'img_url', label: 'Portrait URL', type: 'text', tier: 'player', group: 'identity', wide: true },

    { key: 'hp_current', label: 'Current HP', type: 'int', min: -9999, max: 9999, tier: 'player', group: 'vitals' },
    { key: 'hp_max', label: 'Max HP', type: 'int', min: 0, max: 9999, tier: 'player', group: 'vitals' },
    { key: 'hp_temp', label: 'Temp HP', type: 'int', min: 0, max: 9999, tier: 'player', group: 'vitals' },
    { key: 'armor_class', label: 'Armour class', type: 'int', min: 0, max: 99, tier: 'player', group: 'vitals' },
    { key: 'speed', label: 'Speed', type: 'int', min: 0, max: 999, tier: 'player', group: 'vitals' },

    { key: 'strength', label: 'STR', type: 'int', min: 1, max: 30, tier: 'player', group: 'abilities' },
    { key: 'dexterity', label: 'DEX', type: 'int', min: 1, max: 30, tier: 'player', group: 'abilities' },
    { key: 'constitution', label: 'CON', type: 'int', min: 1, max: 30, tier: 'player', group: 'abilities' },
    { key: 'intelligence', label: 'INT', type: 'int', min: 1, max: 30, tier: 'player', group: 'abilities' },
    { key: 'wisdom', label: 'WIS', type: 'int', min: 1, max: 30, tier: 'player', group: 'abilities' },
    { key: 'charisma', label: 'CHA', type: 'int', min: 1, max: 30, tier: 'player', group: 'abilities' },

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

  // Two-letter initials for the portrait fallback, from the character name.
  function initialsOf(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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
  // Which GROUPS render inside a collapsible disclosure (vs. always-open at the
  // top of the sheet). Identity, Vitals and Abilities are the at-a-glance core
  // and stay open; the long tail folds away, matching the Items editor's shape.
  const OPEN_GROUPS = new Set(['identity', 'vitals', 'abilities']);
  const GROUP_ORDER = ['identity', 'vitals', 'abilities', 'death', 'saves', 'skills', 'combat', 'character', 'currency', 'freeform'];

  // Skill/save metadata for the ability-block layout: which skills sit under
  // each ability, and the save field per ability. Derived from the existing
  // SKILLS/SAVES tables — no new fields, just a grouping for presentation.
  const ABILITY_META = [
    { key: 'strength', abbr: 'STR', save: 'sv_str' },
    { key: 'dexterity', abbr: 'DEX', save: 'sv_dex' },
    { key: 'constitution', abbr: 'CON', save: 'sv_con' },
    { key: 'intelligence', abbr: 'INT', save: 'sv_int' },
    { key: 'wisdom', abbr: 'WIS', save: 'sv_wis' },
    { key: 'charisma', abbr: 'CHA', save: 'sv_cha' },
  ];
  const SKILLS_BY_ABILITY = (() => {
    const m = { STR: [], DEX: [], CON: [], INT: [], WIS: [], CHA: [] };
    for (const [key, label, abil] of SKILLS) m[abil].push({ key, label });
    return m;
  })();

  function render(container, ctx) {
    container.textContent = '';
    container.className = 'folio';
    const a = ctx.actor;
    if (!a) {
      container.appendChild(el('p', { cls: 'muted', text: 'select a character' }));
      return;
    }

    const inputs = new Map();   // key -> { field, node, errNode }  (unchanged contract)
    let anyWritable = false;
    let repaintHp = null;       // set when the vitals band builds; used by Cancel

    // buildNode(f): the single input-factory. Creates the live control for a
    // field with the right type/validation/disabled state, registers it in
    // `inputs` (so assembleData/save/counter all keep working unchanged), and
    // returns it. Presentation (label, read-view) is handled by the slot helpers
    // below — this only makes the editable node.
    function buildNode(f) {
      const writable = mayWrite(f, a, ctx);
      if (writable) anyWritable = true;
      const id = `sheet-${f.key}`;
      let node, mount = null, initDd = null;
      if (f.type === 'bool') {
        node = el('input'); node.type = 'checkbox';
        node.checked = valueOf(a, f) === 'true';
      } else if (f.type === 'select') {
        // Themed dropdown (the app's .vtt-dd), matching every other list. The
        // hidden input carries the value under #sheet-<key> and is the node the
        // save/valueOf path reads; a disabled (read-only) field falls back to a
        // plain, inert text control instead of an interactive dropdown.
        const options = f.options.map((o) => ({ value: o, label: o }));
        if (!writable) {
          // Read-only: a single disabled text control shows the value; no dd.
          node = el('input'); node.type = 'text'; node.value = valueOf(a, f); node.disabled = true;
          node.id = id;
          const errNode0 = el('div', { cls: 'ie-field-err field-error' });
          inputs.set(f.key, { field: f, node, errNode: errNode0 });
          return { node, errNode: errNode0, writable, id, mount: node };
        }
        node = el('input'); node.type = 'hidden'; node.value = valueOf(a, f);
        const dd = el('div', { cls: 'vtt-dd' }); dd.setAttribute('data-value', node.value);
        const btn = el('button', { cls: 'vtt-dd-btn' }); btn.type = 'button'; btn.id = id + '-btn';
        btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
        const cur = options.find((o) => o.value === node.value);
        btn.textContent = cur ? cur.label : (options[0] && options[0].label) || '';
        const ul = el('ul', { cls: 'vtt-dd-list' }); ul.setAttribute('role', 'listbox');
        ul.setAttribute('tabindex', '-1'); ul.hidden = true; ul.setAttribute('aria-label', f.label);
        dd.appendChild(node); dd.appendChild(btn); dd.appendChild(ul);
        node.id = id;
        let ddCtl = null;
        initDd = () => { if (window.VTTCommon && window.VTTCommon.initDropdown) ddCtl = window.VTTCommon.initDropdown(dd, options); };
        // Expose a setter that also refreshes the dd button label on revert.
        node._ddSet = (v) => { if (ddCtl && ddCtl.set) ddCtl.set(v); else node.value = v; };
        mount = dd;
      } else if (f.type === 'textarea' || f.type === 'json') {
        node = el('textarea');
        node.rows = f.rows || (f.type === 'json' ? 6 : 4);
        if (f.max) node.maxLength = f.max;
        node.value = valueOf(a, f);
      } else {
        node = el('input');
        if (f.type === 'int') {
          node.type = 'number';
          if (f.min !== undefined) node.min = String(f.min);
          if (f.max !== undefined) node.max = String(f.max);
        } else { node.type = 'text'; if (f.max) node.maxLength = f.max; }
        node.value = valueOf(a, f);
      }
      if (!node.id) node.id = id;
      if (f.type !== 'select') node.disabled = !writable;
      const errNode = el('div', { cls: 'ie-field-err field-error' });
      inputs.set(f.key, { field: f, node, errNode });
      // vtt-dd must be initialised AFTER it is in the document; defer via the
      // pending list flushed at the end of render.
      if (initDd) pendingDropdowns.push(initDd);
      return { node, errNode, writable, id, mount: mount || node };
    }

    const fieldByKey = {};
    for (const f of FIELDS) fieldByKey[f.key] = f;

    // Every field is a live control at all times — there is no read/edit mode.
    // CSS strips the chrome so a resting control reads as a statistic, heading or
    // paragraph, and a focus/hover affordance invites a click to edit in place.
    // Each slot's loaded value is captured as its baseline; Cancel reverts to the
    // baseline, and a successful Save rebaselines to the just-saved values.
    const baselined = [];   // { node, get, set, base }
    const pendingDropdowns = [];   // vtt-dd init callbacks, flushed after render
    function slot(f, variant) {
      const built = buildNode(f);
      const wrap = el('div', { cls: 'fo-slot fo-slot-' + (variant || 'line') + (built.writable ? '' : ' fo-ro') });
      if (f.type === 'bool') wrap.classList.add('fo-slot-check');
      if (f.type === 'select') wrap.classList.add('fo-slot-dd');
      const isBool = f.type === 'bool';
      // For a themed dropdown the value lives in the hidden input; setting it on
      // revert must also refresh the button label, which initDropdown wires to
      // the hidden input's `change` event.
      const rec = {
        node: built.node,
        get: () => (isBool ? built.node.checked : built.node.value),
        set: (v) => {
          if (isBool) built.node.checked = v;
          else if (f.type === 'select' && typeof built.node._ddSet === 'function') {
            built.node._ddSet(v);
            built.node.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            built.node.value = v;
            if (f.type === 'select') built.node.dispatchEvent(new Event('change', { bubbles: true }));
          }
        },
        base: isBool ? built.node.checked : built.node.value,
      };
      baselined.push(rec);
      wrap.appendChild(built.mount);
      wrap.appendChild(built.errNode);
      return { wrap, node: built.node, writable: built.writable };
    }
    function revertAll() { for (const r of baselined) { if (r.get() !== r.base) r.set(r.base); } }
    function rebaseline() { for (const r of baselined) r.base = r.get(); }

    // A labelled recorded value (label + slot), for identity/vitals pairs.
    function labelledSlot(key, variant, labelText) {
      const f = fieldByKey[key];
      const cell = el('div', { cls: 'fo-field' });
      const lab = el('span', { cls: 'fo-label', text: labelText || f.label });
      const s = slot(f, variant || 'line');
      if (!s.writable) lab.appendChild(el('span', { cls: 'as-gm-tag', text: 'GM' }));
      cell.appendChild(lab); cell.appendChild(s.wrap);
      return cell;
    }

    // ── LEFT: identity column (persistent across tabs) ───────────────────────
    const root = el('div', { cls: 'fo-root' });
    const identity = el('aside', { cls: 'fo-identity' });

    // Portrait with a hover/focus edit-pencil overlay (mirrors the item editor
    // and dashboard avatar): clicking opens the shared image picker. The image
    // URL is a HIDDEN input — it keeps the #sheet-img_url contract and rides
    // through save, but is no longer shown as a raw text field.
    const portraitWritable = !isProjected(a) && mayWrite(fieldByKey.img_url, a, ctx);
    const portrait = el('div', { cls: 'fo-portrait' });
    const portraitImg = el('img'); portraitImg.alt = '';
    const portraitFallback = el('span', { cls: 'fo-portrait-fallback', text: initialsOf(a.name) });
    function paintPortrait(url) {
      const u = (url !== undefined ? url : a.img_url) || '';
      if (u) {
        portraitImg.src = u;
        const ox = Number(a.img_offset_x) || 0, oy = Number(a.img_offset_y) || 0, sc = Number(a.img_scale) > 0 ? Number(a.img_scale) : 1;
        portraitImg.style.transform = `translate(${ox * 100}%, ${oy * 100}%) scale(${sc})`;
        portraitImg.style.display = ''; portraitFallback.style.display = 'none';
      } else {
        portraitImg.removeAttribute('src'); portraitImg.style.display = 'none'; portraitFallback.style.display = '';
      }
    }
    portrait.appendChild(portraitImg); portrait.appendChild(portraitFallback);
    paintPortrait();

    // Hidden URL field (registered so save + tests keep working).
    let imgHidden = null;
    if (!isProjected(a)) {
      const imgSlot = slot(fieldByKey.img_url, 'portrait-url');
      imgHidden = imgSlot.node;
      imgHidden.type = 'hidden';
      imgSlot.wrap.classList.add('fo-portrait-url');   // CSS hides the wrap
      identity.appendChild(imgSlot.wrap);
    }

    if (portraitWritable) {
      const portraitBtn = el('button', { cls: 'fo-portrait-btn' }); portraitBtn.type = 'button';
      portraitBtn.setAttribute('aria-label', 'Change portrait');
      const overlay = el('span', { cls: 'fo-portrait-overlay' });
      overlay.appendChild(el('span', { cls: 'fo-portrait-pencil' }));
      portraitBtn.appendChild(portrait);
      portraitBtn.appendChild(overlay);
      // Opening/using the picker must not be blocked; framing rides in the draft.
      portraitBtn.addEventListener('click', () => {
        if (typeof ctx.onPickPortrait === 'function') {
          ctx.onPickPortrait(imgHidden ? imgHidden.value : (a.img_url || ''), (url) => {
            if (imgHidden) { imgHidden.value = url || ''; imgHidden.dispatchEvent(new Event('input', { bubbles: true })); }
            paintPortrait(url || '');
          });
        }
      });
      identity.appendChild(portraitBtn);
    } else {
      identity.appendChild(portrait);
    }

    // Name (serif). Read = heading; edit = input in place.
    const nameSlot = slot(fieldByKey.name, 'name');
    nameSlot.wrap.classList.add('fo-name');
    identity.appendChild(nameSlot.wrap);

    // Badges.
    const badges = el('div', { cls: 'fo-badges' });
    badges.appendChild(el('span', { cls: 'as-badge ' + (a.is_npc ? 'npc' : 'pc'), text: a.is_npc ? 'NPC' : 'PC' }));
    if (ctx.me && a.user_id === ctx.me.id) badges.appendChild(el('span', { cls: 'as-badge mine', text: 'Yours' }));
    identity.appendChild(badges);

    if (isProjected(a)) {
      identity.appendChild(el('div', { cls: 'fo-identity-line', text: a.size || '' }));
      root.appendChild(identity);
      container.appendChild(root);
      container.appendChild(el('p', { cls: 'muted as-unavailable', text: 'Statistics unavailable. You can see this creature’s name, portrait and size because its token is on the board.' }));
      return;
    }

    // Composed identity line: class · ancestry · level · size. In edit mode each
    // becomes its own control (they are separate GM fields).
    const idLine = el('div', { cls: 'fo-identity-edit' });
    idLine.appendChild(labelledSlot('class', 'line'));
    idLine.appendChild(labelledSlot('race', 'line', 'Ancestry'));
    idLine.appendChild(labelledSlot('level', 'line'));
    idLine.appendChild(labelledSlot('size', 'line'));
    // Read-mode composed one-liner (hidden while editing).
    const idRead = el('div', { cls: 'fo-identity-line fo-identity-read' });
    const composeIdentity = () => {
      const sub = [a.class, a.race, a.level != null ? `Level ${a.level}` : null, a.size].filter(Boolean).join(' · ');
      idRead.textContent = sub || '—';
    };
    composeIdentity();
    identity.appendChild(idRead);
    identity.appendChild(idLine);

    // Recorded identity values: background, alignment, XP, inspiration.
    const idRecorded = el('div', { cls: 'fo-recorded' });
    idRecorded.appendChild(labelledSlot('background', 'line'));
    idRecorded.appendChild(labelledSlot('alignment', 'line'));
    idRecorded.appendChild(labelledSlot('experience_points', 'line', 'XP'));
    idRecorded.appendChild(labelledSlot('inspiration', 'line'));
    identity.appendChild(idRecorded);

    root.appendChild(identity);

    // ── RIGHT: main area ─────────────────────────────────────────────────────
    const main = el('div', { cls: 'fo-main' });

    // Vitals band (persistent across tabs): HP, temp, AC shield, speed, hit
    // dice, passive perception.
    const vitals = el('div', { cls: 'fo-vitals' });

    const hpBlock = el('div', { cls: 'fo-hp' });
    hpBlock.appendChild(el('span', { cls: 'fo-hp-label', text: 'Hit points' }));
    const hpNums = el('div', { cls: 'fo-hp-nums' });
    const hpCur = slot(fieldByKey.hp_current, 'hp'); hpCur.wrap.classList.add('fo-hp-cur');
    const hpSlash = el('span', { cls: 'fo-hp-slash', text: '/' });
    const hpMax = slot(fieldByKey.hp_max, 'hp'); hpMax.wrap.classList.add('fo-hp-max');
    hpNums.appendChild(hpCur.wrap); hpNums.appendChild(hpSlash); hpNums.appendChild(hpMax.wrap);
    hpBlock.appendChild(hpNums);
    const hpBar = el('div', { cls: 'fo-hp-bar' });
    const hpFill = el('div', { cls: 'fo-hp-fill' });
    repaintHp = () => {
      const cur = Number(hpCur.node.value) || 0, mx = Number(hpMax.node.value) || 0;
      hpFill.style.width = (mx > 0 ? Math.max(0, Math.min(100, (cur / mx) * 100)) : 0) + '%';
      hpFill.classList.toggle('low', cur <= 0);
    };
    const paintHp = repaintHp;
    hpCur.node.addEventListener('input', paintHp); hpMax.node.addEventListener('input', paintHp);
    paintHp();
    hpBar.appendChild(hpFill); hpBlock.appendChild(hpBar);
    // Temp HP, separate.
    const tempWrap = el('div', { cls: 'fo-temp' });
    tempWrap.appendChild(el('span', { cls: 'fo-temp-label', text: 'Temp' }));
    const tempSlot = slot(fieldByKey.hp_temp, 'hp'); tempWrap.appendChild(tempSlot.wrap);
    hpBlock.appendChild(tempWrap);
    vitals.appendChild(hpBlock);

    // AC shield emblem.
    const acEmblem = el('div', { cls: 'fo-emblem fo-shield' });
    acEmblem.appendChild(el('span', { cls: 'fo-emblem-label', text: 'AC' }));
    const acSlot = slot(fieldByKey.armor_class, 'emblem'); acEmblem.appendChild(acSlot.wrap);
    if (!acSlot.writable) acEmblem.appendChild(el('span', { cls: 'as-gm-tag', text: 'GM' }));
    vitals.appendChild(acEmblem);

    // Speed: simpler numeric with a small movement glyph.
    const spEmblem = el('div', { cls: 'fo-emblem fo-speed' });
    const spLab = el('span', { cls: 'fo-emblem-label' });
    spLab.appendChild(el('span', { cls: 'fo-move-icon', text: '»' }));
    spLab.appendChild(document.createTextNode(' Speed'));
    spEmblem.appendChild(spLab);
    const spSlot = slot(fieldByKey.speed, 'emblem'); spEmblem.appendChild(spSlot.wrap);
    if (!spSlot.writable) spEmblem.appendChild(el('span', { cls: 'as-gm-tag', text: 'GM' }));
    vitals.appendChild(spEmblem);

    // Supporting values: hit dice + passive perception.
    const support = el('div', { cls: 'fo-support' });
    support.appendChild(labelledSlot('hit_dice', 'line', 'Hit dice'));
    support.appendChild(labelledSlot('passive_perception', 'line', 'Passive perc.'));
    vitals.appendChild(support);

    main.appendChild(vitals);

    // Tabs: Stats / Features / Inventory / Spellbook / Backstory. Switching only toggles visibility, so
    // the draft and every input persist untouched.
    const tabs = el('div', { cls: 'fo-tabs' }); tabs.setAttribute('role', 'tablist');
    const pages = el('div', { cls: 'fo-pages' });
    const pageEls = {};
    const tabDefs = [['character', 'Stats'], ['features', 'Features'], ['inventory', 'Inventory'], ['spellbook', 'Spellbook'], ['journal', 'Backstory']];
    function selectTab(id) {
      for (const [tid] of tabDefs) {
        pageEls[tid].hidden = tid !== id;
        tabBtns[tid].setAttribute('aria-selected', tid === id ? 'true' : 'false');
        tabBtns[tid].classList.toggle('active', tid === id);
      }
    }
    const tabBtns = {};
    for (const [tid, label] of tabDefs) {
      const b = el('button', { cls: 'fo-tab', text: label }); b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => selectTab(tid));
      tabBtns[tid] = b; tabs.appendChild(b);
    }
    main.appendChild(tabs);

    // ── Character page: six ability blocks (3×2), each with save + skills ────
    const pageChar = el('div', { cls: 'fo-page fo-page-character' });
    const abilityGrid = el('div', { cls: 'fo-abilities' });
    for (const ab of ABILITY_META) {
      const block = el('div', { cls: 'fo-ability' });
      const scoreSlot = slot(fieldByKey[ab.key], 'score');
      scoreSlot.wrap.classList.add('fo-ability-score');
      block.appendChild(scoreSlot.wrap);
      const abbr = el('div', { cls: 'fo-ability-abbr', text: ab.abbr });
      if (!scoreSlot.writable) abbr.appendChild(el('span', { cls: 'as-gm-tag', text: 'GM' }));
      block.appendChild(abbr);

      // Saving throw beneath the score.
      const saveRow = el('div', { cls: 'fo-save-row' });
      saveRow.appendChild(el('span', { cls: 'fo-save-label', text: 'Save' }));
      const svProf = slot(fieldByKey[`${ab.save}_p`], 'pip');
      const svVal = slot(fieldByKey[ab.save], 'bonus');
      saveRow.appendChild(svProf.wrap); saveRow.appendChild(svVal.wrap);
      block.appendChild(saveRow);

      // Skills under this ability.
      const skillList = el('div', { cls: 'fo-skills' });
      for (const sk of SKILLS_BY_ABILITY[ab.abbr]) {
        const row = el('div', { cls: 'fo-skill-row' });
        const prof = slot(fieldByKey[`${sk.key}_p`], 'pip');
        row.appendChild(prof.wrap);
        row.appendChild(el('span', { cls: 'fo-skill-name', text: sk.label }));
        const val = slot(fieldByKey[sk.key], 'bonus');
        row.appendChild(val.wrap);
        skillList.appendChild(row);
      }
      block.appendChild(skillList);
      abilityGrid.appendChild(block);
    }
    pageChar.appendChild(abilityGrid);

    // Attacks & spellcasting (readable text) + death saves (compact).
    const combatSection = el('section', { cls: 'fo-section' });
    combatSection.appendChild(el('h4', { cls: 'fo-h', text: 'Attacks & spellcasting' }));
    const attacksSlot = slot(fieldByKey.attacks, 'prose');
    combatSection.appendChild(attacksSlot.wrap);
    pageChar.appendChild(combatSection);

    const deathSection = el('section', { cls: 'fo-section fo-death' });
    deathSection.appendChild(el('h4', { cls: 'fo-h', text: 'Death saves' }));
    const deathRow = el('div', { cls: 'fo-death-row' });
    const dsSucc = el('div', { cls: 'fo-death-cell' });
    dsSucc.appendChild(el('span', { cls: 'fo-label', text: 'Successes' }));
    dsSucc.appendChild(slot(fieldByKey.death_save_successes, 'count').wrap);
    const dsFail = el('div', { cls: 'fo-death-cell' });
    dsFail.appendChild(el('span', { cls: 'fo-label', text: 'Failures' }));
    dsFail.appendChild(slot(fieldByKey.death_save_failures, 'count').wrap);
    deathRow.appendChild(dsSucc); deathRow.appendChild(dsFail);
    deathSection.appendChild(deathRow);
    pageChar.appendChild(deathSection);
    pages.appendChild(pageChar); pageEls.character = pageChar;

    // ── Features page ────────────────────────────────────────────────────────
    const pageFeat = el('div', { cls: 'fo-page fo-page-features' }); pageFeat.hidden = true;
    for (const [key, heading] of [['features_traits', 'Features & traits'], ['proficiencies_languages', 'Proficiencies & languages']]) {
      const sec = el('section', { cls: 'fo-section' });
      sec.appendChild(el('h4', { cls: 'fo-h', text: heading }));
      sec.appendChild(slot(fieldByKey[key], 'prose').wrap);
      pageFeat.appendChild(sec);
    }
    pages.appendChild(pageFeat); pageEls.features = pageFeat;

    // ── Inventory page: currency strip + a mount the host fills with the bag ──
    const pageInv = el('div', { cls: 'fo-page fo-page-inventory' }); pageInv.hidden = true;
    const curSection = el('section', { cls: 'fo-section' });
    curSection.appendChild(el('h4', { cls: 'fo-h', text: 'Currency' }));
    const curStrip = el('div', { cls: 'fo-currency' });
    for (const coin of ['cp', 'sp', 'ep', 'gp', 'pp']) {
      const cell = el('div', { cls: 'fo-coin' });
      cell.appendChild(el('span', { cls: 'fo-coin-label', text: coin.toUpperCase() }));
      cell.appendChild(slot(fieldByKey[coin], 'count').wrap);
      curStrip.appendChild(cell);
    }
    curSection.appendChild(curStrip);
    pageInv.appendChild(curSection);
    // Mount point the host relocates the existing inventory block into (its ids
    // and one-time bindings are preserved by MOVING, not recreating, the nodes).
    const invMount = el('div', { cls: 'fo-inv-mount' });
    pageInv.appendChild(invMount);
    pages.appendChild(pageInv); pageEls.inventory = pageInv;

    const pageBook = el('div', { cls: 'fo-page fo-page-spellbook' }); pageBook.hidden = true;
    const bookMount = el('div', { cls: 'fo-spellbook-mount' });
    pageBook.appendChild(bookMount);
    pages.appendChild(pageBook); pageEls.spellbook = pageBook;

    // ── Backstory page (narrative only; currency moved to Inventory) ─────────
    const pageJourn = el('div', { cls: 'fo-page fo-page-journal' }); pageJourn.hidden = true;
    for (const [key, heading] of [
      ['personality_traits', 'Personality traits'], ['ideals', 'Ideals'], ['bonds', 'Bonds'], ['flaws', 'Flaws'],
      ['appearance', 'Appearance'], ['allies_organisations', 'Allies & organisations'], ['treasure', 'Treasure'],
      ['notes', 'Backstory & session notes'],
    ]) {
      const sec = el('section', { cls: 'fo-section' });
      sec.appendChild(el('h4', { cls: 'fo-h', text: heading }));
      sec.appendChild(slot(fieldByKey[key], 'prose').wrap);
      pageJourn.appendChild(sec);
    }
    // The raw `data` JSON editor is intentionally NOT shown (removed from the
    // Backstory tab). Its node is still built — hidden — so assembleData keeps
    // preserving unknown/legacy JSON keys and the byte-cap validation still runs.
    // Editing structured sub-fields (skills, saves, currency, etc.) continues to
    // work; only the raw-JSON escape hatch is gone from the UI.
    {
      const hidden = slot(fieldByKey.data, 'prose');
      hidden.wrap.style.display = 'none';
      pageJourn.appendChild(hidden.wrap);
    }
    pages.appendChild(pageJourn); pageEls.journal = pageJourn;

    main.appendChild(pages);
    root.appendChild(main);
    container.appendChild(root);
    selectTab(pageEls[ctx.activeTab] ? ctx.activeTab : 'character');
    // vtt-dd dropdowns must be initialised now they are in the document.
    for (const initDd of pendingDropdowns) initDd();

    // Hand the inventory mount to the host so it can relocate the real bag UI
    // into the Inventory tab (see actors.js renderSheet).
    if (typeof ctx.onInventoryMount === 'function') ctx.onInventoryMount(invMount);
    if (typeof ctx.onSpellbookMount === 'function') ctx.onSpellbookMount(bookMount);

    // ── Error box (shared, above the footer) ─────────────────────────────────
    const errBox = el('p', { cls: 'sheet-error' });
    container.appendChild(errBox);

    if (!anyWritable) {
      container.appendChild(el('p', { cls: 'muted as-readonly', text: 'Read-only — you do not control this character.' }));
      // Read-only viewers get the composed sheet with no edit controls at all.
      return;
    }

    // ── Footer (Save changes / Cancel) — hidden until the first change ───────
    // There is no edit mode: every control is already live. The footer appears
    // the moment something is changed, and Cancel reverts every field to its
    // last-loaded value and hides the footer again.
    const footer = el('div', { cls: 'ie-footer as-footer fo-footer' }); footer.hidden = true;
    const cancelBtn = el('button', { cls: 'btn small secondary', text: 'Cancel' }); cancelBtn.type = 'button';
    const spacer = el('span', { cls: 'ie-footer-spacer' });
    const counter = el('span', { cls: 'muted as-counter' });
    const status = el('span', { cls: 'muted ie-status' });
    const saveBtn = el('button', { cls: 'btn small primary', text: 'Save changes' }); saveBtn.type = 'button';
    footer.appendChild(cancelBtn); footer.appendChild(spacer);
    footer.appendChild(counter); footer.appendChild(status); footer.appendChild(saveBtn);
    container.appendChild(footer);

    // Dirty tracking: the first change to any writable control reveals the footer
    // and drives the dialog close-guard on game.html.
    let dirty = false;
    function setDirty(on) {
      dirty = on;
      footer.hidden = !on;
      container.classList.toggle('fo-dirty', on);
      if (ctx.onDirtyChange) ctx.onDirtyChange(on);
    }
    function markDirty() { if (!dirty) setDirty(true); }
    for (const { node } of inputs.values()) {
      if (node.disabled) continue;
      node.addEventListener('input', markDirty);
      node.addEventListener('change', markDirty);
    }

    // Cancel: revert every field to its baseline (last loaded or last saved),
    // drop the dirty state, and hide the footer. (requestClose is NOT called —
    // Cancel here means "discard my in-progress edits", not "close the sheet".)
    cancelBtn.addEventListener('click', () => {
      revertAll();
      clearErrors();
      status.textContent = '';
      refreshCounter();
      if (repaintHp) repaintHp();
      setDirty(false);
    });

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

    let saving = false;
    saveBtn.addEventListener('click', async () => {
      if (saving) return;                    // no duplicate submissions
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

      saving = true; saveBtn.disabled = true;
      status.textContent = 'saving…';
      try {
        const r = await ctx.onSave(patch);
        if (r.status === 200) {
          status.textContent = `saved ${Object.keys(patch).length} field(s)`;
          // Saved values become the new baseline for Cancel, and the footer
          // hides until the next change. A subsequent refresh re-renders anyway;
          // if none comes, the live controls already hold the saved values.
          rebaseline();
          setDirty(false);
          if (ctx.onDone) ctx.onDone(r);
        } else {
          // Failure keeps the sheet open with the footer showing and edits intact.
          status.textContent = `refused (${r.status})`;
          showError(r.data && r.data.error);
        }
      } catch (err) {
        status.textContent = 'network error — your edits are kept';
      }
      saving = false; saveBtn.disabled = false;
    });
  }

  return { render, FIELDS, SIZES, isProjected };
})();
