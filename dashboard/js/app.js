/* Wedding Dashboard — Shared Utilities */

// ──── Token management ────
function getToken() {
  // Check URL param first, then sessionStorage
  const params = new URLSearchParams(location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    sessionStorage.setItem('dashToken', urlToken);
    // Clean URL
    params.delete('token');
    const clean = params.toString();
    history.replaceState(null, '', location.pathname + (clean ? '?' + clean : ''));
    return urlToken;
  }
  return sessionStorage.getItem('dashToken');
}

function requireAuth() {
  const token = getToken();
  if (!token) {
    location.href = '/dashboard/login.html';
    return false;
  }
  return true;
}

// ──── API wrapper ────
async function api(path, options = {}) {
  const token = getToken();
  if (!token) { location.href = '/dashboard/login.html'; return; }
  const res = await fetch('/api' + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
      ...options.headers
    }
  });
  if (res.status === 401) {
    sessionStorage.removeItem('dashToken');
    location.href = '/dashboard/login.html';
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

// ──── Hebrew date formatting ────
function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('he-IL', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

// ──── Status labels in Hebrew ────
function statusLabel(status) {
  const labels = {
    coming: 'מגיע',
    not_coming: 'לא מגיע',
    undecided: 'מתלבט',
    pending: 'ממתין',
    invited: 'הוזמן',
    opted_out: 'הוסר'
  };
  return labels[status] || status || '';
}

// ──── CSS class for status badge ────
function statusClass(status) {
  const classes = {
    coming: 'badge-success',
    not_coming: 'badge-danger',
    undecided: 'badge-warning',
    pending: 'badge-secondary',
    invited: 'badge-secondary',
    opted_out: 'badge-dark'
  };
  return 'badge ' + (classes[status] || 'badge-secondary');
}

// ──── Direction labels ────
function directionLabel(dir) {
  return dir === 'outgoing' ? 'יוצא ←' : 'נכנס →';
}

// ──── Channel labels ────
function channelLabel(ch) {
  if (ch === 'whatsapp') return 'WhatsApp';
  if (ch === 'sms') return 'SMS';
  return ch || '';
}

// ──── Side labels ────
function sideLabel(side) {
  const map = { groom: 'חתן', bride: 'כלה', both: 'משותף' };
  return map[side] || side || '';
}

// ──── Auth check on load (skip login page) ────
document.addEventListener('DOMContentLoaded', () => {
  const page = location.pathname.split('/').pop() || 'index.html';
  if (page !== 'login.html') requireAuth();

  // Navigation highlighting
  document.querySelectorAll('nav a').forEach(a => {
    if (a.getAttribute('href') === page) a.classList.add('active');
  });
});

// ──── Toast notifications ────
function showToast(message, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ──── Escape HTML ────
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ──── Build nav HTML (shared) ────
function getNavHTML() {
  return `
    <nav>
      <span class="brand">💍 ניהול חתונה</span>
      <a href="index.html">בית</a>
      <a href="guests.html">אורחים</a>
      <a href="messages.html">הודעות</a>
      <a href="reminders.html">תזכורות</a>
      <a href="settings.html">הגדרות</a>
      <a href="export.html">ייצוא</a>
      <a href="guide.html">מדריך</a>
      <a href="#" onclick="sessionStorage.removeItem('dashToken');location.href='/dashboard/login.html'" style="margin-right:auto">יציאה</a>
    </nav>`;
}
