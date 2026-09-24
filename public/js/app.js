// Front-end for the course page.
// Payment flow: open the buyer's UPI app -> buyer submits email + transaction ID
// (+ optional screenshot) to the server -> the server stores it as "pending"
// until the trainer approves it -> this page unlocks and lists the course files.
// Access is decided by the server only; nothing here can unlock content by itself.
(function () {
  'use strict';

  const EMAIL_KEY = 'course_email'; // convenience only: prefill the email field
  const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v|avi)$/i;

  let config = {
    paymentsEnabled: false,
    upiId: null,
    payeeName: '',
    amount: 900,
    currency: 'INR',
    demoAutoApprove: false,
    maxScreenshotMb: 5,
  };

  const $ = (id) => document.getElementById(id);

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  }
  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, options));
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON response */ }
    if (!res.ok) {
      const message = (data && (data.error || data.message)) || `Request failed (${res.status})`;
      throw new Error(message);
    }
    return data;
  }

  function formatAmount(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  }

  // ---------------------------------------------------------------- config
  async function loadConfig() {
    try {
      config = Object.assign(config, await fetchJson('/api/config'));
    } catch (err) {
      console.error('Could not load payment config:', err);
    }
    document.querySelectorAll('.js-price').forEach((el) => { el.textContent = formatAmount(config.amount); });
    $('demoBanner').hidden = !config.demoAutoApprove;
    $('payeeVpa').textContent = config.upiId || '';
    $('payeeName').textContent = config.payeeName || '';
    $('paymentsDisabled').hidden = config.paymentsEnabled;
    $('paymentInstructions').hidden = !config.paymentsEnabled;
    $('verifyPayForm').hidden = !config.paymentsEnabled;
  }

  // ---------------------------------------------------------------- payment
  function startUpiPayment() {
    if (config.paymentsEnabled) {
      const params = new URLSearchParams({
        pa: config.upiId,
        pn: config.payeeName,
        am: Number(config.amount).toFixed(2),
        cu: config.currency || 'INR',
        tn: 'DevOps Course',
      });
      // Opens a UPI app on phones; does nothing on most desktops (instructions cover that).
      const a = document.createElement('a');
      a.href = `upi://pay?${params.toString().replace(/\+/g, '%20')}`;
      a.hidden = true;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    showPaymentModal();
  }

  function showPaymentModal() {
    $('formError').hidden = true;
    const savedEmail = storageGet(EMAIL_KEY);
    if (savedEmail && !$('verifyEmail').value) $('verifyEmail').value = savedEmail;
    $('paymentModal').hidden = false;
    const first = config.paymentsEnabled ? $('verifyEmail') : $('closeModalBtn');
    first.focus();
  }

  function hidePaymentModal() {
    $('paymentModal').hidden = true;
  }

  function showFormError(message) {
    const el = $('formError');
    el.textContent = message;
    el.hidden = false;
  }

  async function submitPayment(e) {
    e.preventDefault();
    const email = $('verifyEmail').value.trim();
    const txn = $('verifyTxn').value.trim();
    const file = $('verifyScreenshot').files[0];

    if (!email || !txn) return showFormError('Please provide both your email and the UPI transaction ID.');
    if (!$('verifyEmail').checkValidity()) return showFormError('Please enter a valid email address.');
    if (!/^[A-Za-z0-9-]{6,40}$/.test(txn)) return showFormError('The transaction ID should be 6–40 letters or digits.');
    if (file && file.size > config.maxScreenshotMb * 1024 * 1024) {
      return showFormError(`Screenshot must be smaller than ${config.maxScreenshotMb} MB.`);
    }

    const body = new FormData();
    body.append('email', email);
    body.append('txn', txn);
    if (file) body.append('screenshot', file);

    const btn = $('submitPaymentBtn');
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    try {
      const data = await fetchJson('/api/submit-payment', { method: 'POST', body });
      storageSet(EMAIL_KEY, email);
      $('verifyPayForm').reset();
      hidePaymentModal();
      await refreshAccess(data.message);
    } catch (err) {
      showFormError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'I have paid';
    }
  }

  // ---------------------------------------------------------------- access
  function setStatus(message, kind) {
    const el = $('accessStatus');
    el.textContent = message || '';
    el.className = `status${kind ? ` ${kind}` : ''}`;
    el.hidden = !message;
  }

  function renderFiles(files) {
    const list = $('courseFiles');
    list.replaceChildren();
    for (const name of files) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `/content/${encodeURIComponent(name)}`;
      a.textContent = name;
      li.append(VIDEO_EXT.test(name) ? '🎥 ' : '📂 ', a);
      list.appendChild(li);
    }
    $('noFiles').hidden = files.length > 0;
  }

  function unlockContent(files) {
    renderFiles(files || []);
    $('lockedState').hidden = true;
    $('unlockedState').hidden = false;
  }

  async function refreshAccess(messageFromSubmit) {
    let data;
    try {
      data = await fetchJson('/api/list-content');
    } catch (err) {
      setStatus(`Could not check access: ${err.message}`, 'rejected');
      return;
    }

    if (data.allowed) return unlockContent(data.files);

    const checkBtn = $('checkStatusBtn');
    if (data.status === 'pending') {
      setStatus(messageFromSubmit || `Payment submitted${data.email ? ` for ${data.email}` : ''} — pending verification by the trainer.`);
      checkBtn.hidden = false;
    } else if (data.status === 'rejected') {
      setStatus('Your payment could not be verified. Please contact the trainer, or submit the correct transaction ID.', 'rejected');
      checkBtn.hidden = true;
    } else {
      setStatus(messageFromSubmit || '');
      checkBtn.hidden = true;
    }
  }

  // ---------------------------------------------------------------- wiring
  document.addEventListener('DOMContentLoaded', async () => {
    // The old page unlocked itself from this flag with no server check; ignore and clear it.
    storageRemove('paid_access');

    document.querySelectorAll('.js-pay').forEach((btn) => btn.addEventListener('click', startUpiPayment));
    $('verifyPayForm').addEventListener('submit', submitPayment);
    $('closeModalBtn').addEventListener('click', hidePaymentModal);
    $('paymentModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) hidePaymentModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePaymentModal(); });
    $('checkStatusBtn').addEventListener('click', () => refreshAccess());

    await loadConfig();
    await refreshAccess();
  });
})();
