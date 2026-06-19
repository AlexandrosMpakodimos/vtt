const out = document.getElementById('out');

function show(label, data) {
  out.textContent = label + '\n' + JSON.stringify(data, null, 2);
}

// All requests are same-origin, so the session cookie is sent automatically.
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

// --- avatar preview: shows whether an image URL actually loads ---
const avatarImg = document.getElementById('avatar-img');
const avatarNote = document.getElementById('avatar-note');

function setAvatar(url) {
  if (url) {
    avatarNote.textContent = 'loading…';
    avatarImg.src = url;
  } else {
    avatarImg.removeAttribute('src');
    avatarNote.textContent = '(no avatar)';
  }
}
avatarImg.onload = () => { avatarNote.textContent = 'loaded \u2713'; };
avatarImg.onerror = () => {
  if (avatarImg.getAttribute('src')) avatarNote.textContent = 'failed to load \u2717';
};
// login, /me and profile-update all return the user object — reflect its avatar.
function syncAvatar(r) {
  if (r && r.data && r.data.user) setAvatar(r.data.user.avatar_url);
}

document.getElementById('r-submit').onclick = async () => {
  const r = await api('POST', '/api/auth/register', {
    email: document.getElementById('r-email').value,
    username: document.getElementById('r-username').value,
    password: document.getElementById('r-password').value,
  });
  show('register -> ' + r.status, r.data);
};

document.getElementById('l-submit').onclick = async () => {
  const r = await api('POST', '/api/auth/login', {
    email: document.getElementById('l-email').value,
    password: document.getElementById('l-password').value,
  });
  show('login -> ' + r.status, r.data);
  syncAvatar(r);
};

document.getElementById('l-forgot').onclick = async () => {
  const r = await api('POST', '/api/auth/forgot-password', {
    email: document.getElementById('l-email').value,
  });
  show('forgot password -> ' + r.status, r.data);
};

document.getElementById('me').onclick = async () => {
  const r = await api('GET', '/api/auth/me');
  show('me -> ' + r.status, r.data);
  syncAvatar(r);
};

document.getElementById('logout').onclick = async () => {
  const r = await api('POST', '/api/auth/logout');
  show('logout -> ' + r.status, r.data);
  setAvatar('');
};

document.getElementById('a-profile').onclick = async () => {
  const body = {};
  const u = document.getElementById('a-username').value;
  const av = document.getElementById('a-avatar').value;
  if (u) body.username = u;
  if (av !== '') body.avatar_url = av;
  const r = await api('PATCH', '/api/auth/me', body);
  show('update profile -> ' + r.status, r.data);
  syncAvatar(r);
};

document.getElementById('a-changepass').onclick = async () => {
  const r = await api('POST', '/api/auth/change-password', {
    currentPassword: document.getElementById('a-curpass').value,
    newPassword: document.getElementById('a-newpass').value,
  });
  show('change password -> ' + r.status, r.data);
};

// Live preview: as you type/paste an avatar URL, show whether it loads (before saving).
document.getElementById('a-avatar').addEventListener('input', (e) => {
  setAvatar(e.target.value.trim());
});

// Open a socket. The handshake carries the session cookie, so the SERVER
// console will log which user (if any) is behind this connection.
const socket = io();
socket.on('connect', () => console.log('socket connected:', socket.id));

// Load current session (and avatar) on page open.
api('GET', '/api/auth/me').then((r) => { show('me (on load) -> ' + r.status, r.data); syncAvatar(r); });