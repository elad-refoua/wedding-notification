function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let phone = raw.replace(/[\s\-\(\)]/g, '');
  if (phone.startsWith('+')) phone = phone.slice(1);
  if (/^0[5-9]\d{8}$/.test(phone)) {
    phone = '972' + phone.slice(1);
  }
  if (/^972[5-9]\d{8}$/.test(phone)) {
    return '+' + phone;
  }
  return null;
}

function isValidPhone(phone) {
  return /^\+972[5-9]\d{8}$/.test(phone);
}

module.exports = { normalizePhone, isValidPhone };
