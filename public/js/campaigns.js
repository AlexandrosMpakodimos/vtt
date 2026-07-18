// Dev harness for the campaign layer. Kept in an external file: the CSP is
// script-src 'self', so inline <script> bodies and on*= handlers are blocked.
const out = document.getElementById('out');
const logEl = document.getElementById('log');

function show(label, data) {
  out.textContent = label + '\n' + JSON.stringify(data, null, 2);
}
function log(msg) {
  logEl.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

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

let me = null;
let currentCampaign = null;

async function whoami() {
  const r = await api('GET', '/api/auth/me');
  me = r.status === 200 ? r.data.user : null;
  document.getElementById('whoami').textContent = me
    ? `logged in as ${me.username} (${me.id})`
    : 'NOT logged in';
}

// Buttons are built with createElement + addEventListener rather than innerHTML
// with on*= attributes: the CSP blocks inline handlers, and this keeps
// user-supplied names out of an HTML parsing context entirely.
function button(label, handler) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', handler);
  return b;
}

function campaignCard(c, actions = []) {
  const div = document.createElement('div');
  div.className = 'card';
  const title = document.createElement('div');
  const name = document.createElement('b');
  name.textContent = c.name;                     // textContent, never innerHTML
  title.appendChild(name);
  for (const t of [
    c.is_public ? 'public' : 'private',
    c.has_password ? 'password' : null,
    c.is_gm ? 'GM' : null,
    c.archived ? 'ARCHIVED' : null,
    c.deleted_at ? 'DELETED' : null,
  ].filter(Boolean)) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = ' ' + t;
    title.appendChild(document.createTextNode(' '));
    title.appendChild(tag);
  }
  div.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'muted';
  meta.textContent = `${c.id}${c.member_count !== undefined ? ` · ${c.member_count} members` : ''}`;
  div.appendChild(meta);

  if (c.description) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = c.description;
    div.appendChild(d);
  }

  const row = document.createElement('div');
  row.className = 'row';
  for (const [label, fn] of actions) row.appendChild(button(label, fn));
  div.appendChild(row);
  return div;
}

// --- create ---
document.getElementById('c-submit').addEventListener('click', async () => {
  const isPublic = document.getElementById('c-public').checked;
  const body = {
    name: document.getElementById('c-name').value,
    description: document.getElementById('c-desc').value || undefined,
    img_url: document.getElementById('c-img').value || undefined,
    is_public: isPublic,
  };
  const pw = document.getElementById('c-password').value;
  if (!isPublic && pw) body.password = pw;
  const r = await api('POST', '/api/campaigns', body);
  show(`POST /api/campaigns → ${r.status}`, r.data);
  loadMine();
});

// --- my campaigns (Owned / Joined tabs × active/archived/all filter) ---
let currentRole = 'owner'; // which tab is active: 'owner' or 'player'

async function loadMine() {
  const filter = document.getElementById('m-filter').value;
  const r = await api('GET', `/api/campaigns/mine?role=${currentRole}&filter=${filter}`);
  const box = document.getElementById('mine');
  box.textContent = '';
  // Make the active tab obvious in this bare harness.
  document.getElementById('tab-owned').style.fontWeight = currentRole === 'owner' ? 'bold' : 'normal';
  document.getElementById('tab-joined').style.fontWeight = currentRole === 'player' ? 'bold' : 'normal';
  if (r.status !== 200) return show(`GET /mine → ${r.status}`, r.data);
  if (!r.data.campaigns.length) box.textContent = `(no ${filter === 'all' ? '' : filter + ' '}campaigns in "${currentRole}")`;
  for (const c of r.data.campaigns) {
    const actions = [
      ['open', () => { document.getElementById('room-id').value = c.id; openRoom(); }],
      // Archive is per-user: available to owner and player alike.
      c.archived
        ? ['unarchive', async () => {
            const x = await api('POST', `/api/campaigns/${c.id}/unarchive`);
            show(`unarchive → ${x.status}`, x.data); loadMine();
          }]
        : ['archive', async () => {
            const x = await api('POST', `/api/campaigns/${c.id}/archive`);
            show(`archive → ${x.status}`, x.data); loadMine();
          }],
      ...(c.is_gm ? [['delete', async () => {
        const d = await api('DELETE', `/api/campaigns/${c.id}`);
        show(`DELETE → ${d.status}`, d.data); loadMine();
      }]] : []),
    ];
    box.appendChild(campaignCard(c, actions));
  }
  show(`GET /mine (${currentRole}/${filter}) → ${r.status}`, { count: r.data.campaigns.length });
}
document.getElementById('tab-owned').addEventListener('click', () => { currentRole = 'owner'; loadMine(); });
document.getElementById('tab-joined').addEventListener('click', () => { currentRole = 'player'; loadMine(); });
document.getElementById('m-filter').addEventListener('change', loadMine);

document.getElementById('m-deleted').addEventListener('click', async () => {
  const r = await api('GET', '/api/campaigns/deleted');
  const box = document.getElementById('mine');
  box.textContent = '';
  if (!r.data.campaigns || !r.data.campaigns.length) box.textContent = '(no deleted campaigns)';
  for (const c of (r.data.campaigns || [])) {
    box.appendChild(campaignCard(c, [['restore', async () => {
      const d = await api('POST', `/api/campaigns/${c.id}/restore`);
      show(`restore → ${d.status}`, d.data); loadMine();
    }]]));
  }
  show(`GET /deleted → ${r.status}`, r.data);
});

// --- search ---
document.getElementById('s-submit').addEventListener('click', async () => {
  const q = encodeURIComponent(document.getElementById('s-q').value);
  const vis = document.getElementById('s-vis').value;
  const r = await api('GET', `/api/campaigns/search?q=${q}&visibility=${vis}`);
  const box = document.getElementById('results');
  box.textContent = '';
  if (r.status !== 200) return show(`search → ${r.status}`, r.data);
  if (!r.data.campaigns.length) box.textContent = '(no results)';
  for (const c of r.data.campaigns) {
    box.appendChild(campaignCard(c, [['join', async () => {
      const body = {};
      if (c.has_password) {
        const pw = prompt(`Password for "${c.name}"`);
        if (pw === null) return;
        body.password = pw;
      }
      const j = await api('POST', `/api/campaigns/${c.id}/join`, body);
      show(`join → ${j.status}`, j.data);
      if (j.status === 200) { document.getElementById('room-id').value = c.id; loadMine(); openRoom(); }
    }]]));
  }
  show(`search → ${r.status}`, { count: r.data.campaigns.length });
});

// --- room detail + socket ---
async function openRoom() {
  const id = document.getElementById('room-id').value.trim();
  if (!id) return;
  const r = await api('GET', `/api/campaigns/${id}`);
  show(`GET /api/campaigns/${id} → ${r.status}`, r.data);
  const box = document.getElementById('room');
  box.textContent = '';
  if (r.status !== 200) return;
  currentCampaign = r.data.campaign;
  box.appendChild(campaignCard(r.data.campaign));
  for (const m of r.data.members) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = `· ${m.username} [${m.status}]${m.is_gm ? ' (GM)' : ''}`;
    box.appendChild(d);
  }
  socketJoin(id);
}
document.getElementById('room-open').addEventListener('click', openRoom);

document.getElementById('room-leave').addEventListener('click', async () => {
  const id = document.getElementById('room-id').value.trim();
  const r = await api('POST', `/api/campaigns/${id}/leave`);
  show(`leave → ${r.status}`, r.data);
  loadMine();
});

// --- members (owner) ---
document.getElementById('mem-refresh').addEventListener('click', async () => {
  const id = document.getElementById('room-id').value.trim();
  const r = await api('GET', `/api/campaigns/${id}/members`);
  const box = document.getElementById('members');
  box.textContent = '';
  show(`GET /members → ${r.status}`, r.data);
  if (r.status !== 200) return;
  for (const m of r.data.members) {
    const div = document.createElement('div');
    div.className = 'card';
    const label = document.createElement('div');
    label.textContent = `${m.username} [${m.status}]${m.is_gm ? ' (GM)' : ''}`;
    div.appendChild(label);
    if (!m.is_gm) {
      const row = document.createElement('div');
      row.className = 'row';
      const act = async (verb) => {
        const x = await api('POST', `/api/campaigns/${id}/members/${m.user_id}/${verb}`);
        show(`${verb} → ${x.status}`, x.data);
        document.getElementById('mem-refresh').click();
      };
      row.appendChild(button('kick', () => act('kick')));
      row.appendChild(button('ban', () => act('ban')));
      if (m.status === 'banned') row.appendChild(button('unban', () => act('unban')));
      if (m.status === 'active') {
        row.appendChild(button('make owner', async () => {
          const x = await api('POST', `/api/campaigns/${id}/transfer`, { user_id: m.user_id });
          show(`transfer → ${x.status}`, x.data);
          openRoom();
        }));
      }
      div.appendChild(row);
    }
    box.appendChild(div);
  }
});

// --- socket ---
const socket = io({ withCredentials: true });
socket.on('connect', () => log(`connected (${socket.id})`));
socket.on('unauthorized', (d) => log(`UNAUTHORIZED: ${d.error} — log in first`));
socket.on('disconnect', (r) => log(`disconnected: ${r}`));
socket.on('campaign:user-joined', (d) => log(`→ ${d.username} joined the room`));
socket.on('campaign:user-left', (d) => log(`← ${d.username} left the room`));
socket.on('campaign:evicted', (d) => log(`EVICTED from ${d.campaign_id} (${d.reason})`));
socket.on('campaign:join:error', (d) => log(`join refused: ${d.error}`));

function socketJoin(campaignId) {
  socket.emit('campaign:join', { campaign_id: campaignId }, (ack) => {
    log(ack && ack.ok ? `joined room campaign:${campaignId}` : `join failed: ${ack && ack.error}`);
  });
}

whoami().then(loadMine);
