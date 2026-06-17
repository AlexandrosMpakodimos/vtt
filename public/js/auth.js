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
};

document.getElementById('me').onclick = async () => {
  const r = await api('GET', '/api/auth/me');
  show('me -> ' + r.status, r.data);
};

document.getElementById('logout').onclick = async () => {
  const r = await api('POST', '/api/auth/logout');
  show('logout -> ' + r.status, r.data);
};

// Open a socket. The handshake carries the session cookie, so the SERVER
// console will log which user (if any) is behind this connection.
const socket = io();
socket.on('connect', () => console.log('socket connected:', socket.id));

// Load current session on page open.
api('GET', '/api/auth/me').then((r) => show('me (on load) -> ' + r.status, r.data));