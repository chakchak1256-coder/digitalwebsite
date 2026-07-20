// Contact/social links, small DOM utils (toast, footer, mobile nav), Google sign-in + account completion, theme toggle.

// ===== CONTACT SOCIALS =====
function renderContactSocials() {
  const s = Settings.get(); const socials = s.social||{};
  const map = { facebook:{icon:'fa-brands fa-facebook',color:'#1877f2',label:'Facebook'}, instagram:{icon:'fa-brands fa-instagram',color:'#e1306c',label:'Instagram'}, whatsapp:{icon:'fa-brands fa-whatsapp',color:'#25d366',label:'WhatsApp'}, telegram:{icon:'fa-brands fa-telegram',color:'#229ed9',label:'Telegram'}, tiktok:{icon:'fa-brands fa-tiktok',color:'#ff0050',label:'TikTok'}, youtube:{icon:'fa-brands fa-youtube',color:'#ff0000',label:'YouTube'} };
  const el = document.getElementById('contact-socials'); el.innerHTML = '';
  let any = false;
  Object.entries(map).forEach(([k,v]) => {
    if (!socials[k]) return; any = true;
    const a = document.createElement('a'); a.className='soc-link'; a.href=socials[k]; a.target='_blank';
    a.innerHTML=`<div class="soc-icon" style="background:${v.color}20;color:${v.color}"><i class="${v.icon}"></i></div><span>${v.label}</span><i class="fa-solid fa-arrow-up-right-from-square" style="margin-left:auto;color:var(--text-muted);font-size:.72rem"></i>`;
    el.appendChild(a);
  });
  if (!any) el.innerHTML = '<p style="color:var(--text-muted);font-size:.88rem">Social links coming soon — set them in admin settings.</p>';
}

// ===== UTILS =====
function updateFooter() { const el=document.getElementById('footer-copy'); if(el) el.textContent=`© ${new Date().getFullYear()} DIGITCH · All rights reserved`; }
function handleContact(e) { e.preventDefault(); document.getElementById('contact-form').style.display='none'; document.getElementById('form-ok').style.display='block'; }
function showToast(msg) { document.getElementById('toast-msg').textContent=msg; const t=document.getElementById('toast'); t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),3000); }
function toggleMobileNav() { document.getElementById('mobile-nav').classList.toggle('open'); }
function closeMobileNav() { document.getElementById('mobile-nav').classList.remove('open'); }

// ===== USER AUTH (index) =====
function initUserAuth() {
  const user = UserAuth.current();

  if (user) {
    // Confirmed logged in — update everything
    _firebaseResolved = true;
    try { localStorage.setItem('dz_auth', '1'); } catch(e) {}
    document.documentElement.setAttribute('data-authed', 'true');
    const userBtn = document.getElementById('user-btn');
    if (userBtn) userBtn.style.borderColor = 'rgba(var(--primary-rgb),.5)';
    const info = document.getElementById('user-menu-info');
    if (info) info.innerHTML = `<div style="font-size:.78rem;color:var(--text-muted)">Signed in as</div><div style="font-size:.88rem;font-weight:700;margin-top:.15rem">${user.name}</div><div style="font-size:.75rem;font-family:monospace;color:var(--text-muted)">${user.email}</div>`;
  } else if (_firebaseResolved) {
    // Firebase confirmed no user — safe to clear
    localStorage.removeItem('dz_auth');
    document.documentElement.setAttribute('data-authed', 'false');
  }
  // else: Firebase not resolved yet — do nothing, keep CSS from head script
}

function toggleUserMenu() {
  const menu = document.getElementById('user-menu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}
document.addEventListener('click', e => {
  const menu = document.getElementById('user-menu');
  const btn = document.getElementById('user-btn');
  if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
    menu.style.display = 'none';
  }
});

function openLoginModal(context) {
  const modal = document.getElementById('auth-modal');
  modal.style.display = 'flex';
  document.getElementById('am-error').style.display = 'none';
  document.getElementById('am-login').style.display = '';
  document.getElementById('am-google-step').style.display = 'none';
  const banner = document.getElementById('am-checkout-note');
  if (banner) banner.style.display = context === 'checkout' ? 'flex' : 'none';
}
function closeLoginModal() {
  document.getElementById('auth-modal').style.display = 'none';
  document.getElementById('am-login').style.display = '';
  document.getElementById('am-google-step').style.display = 'none';
}
function showAuthModalError(msg) { const e = document.getElementById('am-error'); e.textContent = msg; e.style.display = 'block'; }

async function doGoogleSignIn() {
  document.getElementById('am-error').style.display = 'none';
  const r = await UserAuth.loginWithGoogle();
  if (r.error) { showAuthModalError(r.error); return; }
  if (r.error === null) return; // popup closed

  if (r.isNewUser) {
    // New Google user — show username + phone step
    _googleProfile = r.googleProfile;
    document.getElementById('am-login').style.display = 'none';
    document.getElementById('am-google-step').style.display = 'block';
    document.getElementById('am-gs-email-display').textContent = r.googleProfile.email;
    document.getElementById('am-gs-username').value = r.googleProfile.displayName || '';
    document.getElementById('am-gs-error').style.display = 'none';
    return;
  }

  // Returning Google user — fully logged in
  const wasCheckout = document.getElementById('am-checkout-note').style.display !== 'none';
  closeLoginModal(); initUserAuth();
  showToast('Welcome back, ' + r.user.name + '! 👋');
  if (wasCheckout) setTimeout(() => document.getElementById('checkout-modal').classList.add('open'), 300);
}

// ── Google post-signup state ───────────────────────────────────────
let _googleProfile = null;

function gsValidatePhone(input) {
  input.value = input.value.replace(/\D/g, '').slice(0, 8);
  const val = input.value;
  const hint = document.getElementById('am-gs-phone-hint');
  const icon = document.getElementById('am-gs-phone-icon');
  if (!val) {
    hint.style.display = 'block'; hint.textContent = 'Enter 8 digits after the prefix'; hint.style.color = 'var(--text-muted)';
    icon.textContent = ''; input.style.borderColor = ''; return;
  }
  if (/^\d{8}$/.test(val)) {
    hint.style.display = 'none'; input.style.borderColor = 'rgba(16,185,129,.6)'; icon.textContent = '✓'; icon.style.color = '#10B981';
  } else {
    hint.style.display = 'none'; input.style.borderColor = ''; icon.textContent = '';
  }
}

function gsGetFullPhone() {
  const prefix = document.getElementById('am-gs-phone-prefix').value;
  const digits  = document.getElementById('am-gs-phone').value.trim();
  return prefix + digits;
}

async function doCompleteGoogleSignup() {
  const username = document.getElementById('am-gs-username').value.trim();
  const phone = gsGetFullPhone();
  const errEl = document.getElementById('am-gs-error');
  errEl.style.display = 'none';

  if (!username) { errEl.textContent = 'Please enter a username.'; errEl.style.display = 'block'; return; }
  const digits = document.getElementById('am-gs-phone').value.trim();
  if (!digits || !/^\d{8}$/.test(digits)) { errEl.textContent = 'Please enter a valid 8-digit phone number.'; errEl.style.display = 'block'; return; }

  const btn = document.getElementById('am-gs-submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating account…';

  const r = await UserAuth.completeGoogleRegistration(_googleProfile, username, phone);
  if (r.error) {
    errEl.textContent = r.error; errEl.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Complete Sign Up';
    return;
  }

  const wasCheckout = document.getElementById('am-checkout-note').style.display !== 'none';
  closeLoginModal(); initUserAuth();
  showToast('Welcome, ' + r.user.name + '! 🎉');
  if (wasCheckout) setTimeout(() => document.getElementById('checkout-modal').classList.add('open'), 300);
}

// ── Validation helpers ────────────────────────────────────────────
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}
function isValidPhone(digits8) {
  // Only 8 digits allowed (prefix is separate) — for signup form with prefix dropdown
  return /^\d{8}$/.test(digits8);
}
// Full Algerian phone (10 digits, starts with 05/06/07) — used in checkout
function isValidAlgerianPhoneFull(val) {
  return /^(05|06|07)\d{8}$/.test(val);
}

function validateEmailField(input, hintId, iconId) {
  const val   = input.value.trim();
  const hint  = document.getElementById(hintId);
  const icon  = iconId ? document.getElementById(iconId) : null;
  if (!val) { hint.style.display = 'none'; if (icon) icon.textContent = ''; input.style.borderColor = ''; return; }
  if (isValidEmail(val)) {
    hint.style.display = 'none';
    input.style.borderColor = 'rgba(16,185,129,.6)';
    if (icon) { icon.textContent = '✓'; icon.style.color = '#10B981'; }
  } else {
    hint.textContent = 'Enter a valid email (e.g. you@example.com)';
    hint.style.display = 'block'; hint.style.color = '#EF4444';
    input.style.borderColor = 'rgba(239,68,68,.5)';
    if (icon) { icon.textContent = '✗'; icon.style.color = '#EF4444'; }
  }
}

function validatePhoneField(input, hintId, iconId) {
  // Strip non-digits
  input.value = input.value.replace(/\D/g, '').slice(0, 8);
  const val  = input.value;
  const hint = document.getElementById(hintId);
  const icon = iconId ? document.getElementById(iconId) : null;
  if (!val) {
    hint.textContent = 'Enter 8 digits after the prefix (e.g. 07 12345678)';
    hint.style.color = 'var(--text-muted)';
    if (icon) icon.textContent = '';
    input.style.borderColor = '';
    return;
  }
  if (isValidPhone(val)) {
    hint.style.display = 'none';
    input.style.borderColor = 'rgba(16,185,129,.6)';
    if (icon) { icon.textContent = '✓'; icon.style.color = '#10B981'; }
  } else {
    hint.style.display = 'none'; // no inline counter hint
    hint.style.display = 'block'; hint.style.color = '#F59E0B';
    input.style.borderColor = 'rgba(245,158,11,.5)';
    if (icon) { icon.textContent = ''; }
    if (otpRow) otpRow.style.display = 'none';
  }
}

function doUserLogout() {
  UserAuth.logout(); initUserAuth();
  document.getElementById('user-menu').style.display = 'none';
  showToast('Signed out.');
}


// ===== THEME TOGGLE =====
function initTheme() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const icon = document.getElementById('theme-icon');
  if (icon) icon.className = theme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('dz_theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.className = theme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}


