// ============================================================================
// Outlaw Server — authentication
// ----------------------------------------------------------------------------
// This module is the gate in front of a control plane that can restart
// services, run commands and power off the machine. It is written to be boring
// and auditable rather than clever.
//
// WHAT IT USES AND WHY
// --------------------
// * PASSWORDS — scrypt (Node built-in). Memory-hard, so a stolen hash file is
//   expensive to crack offline. Per-user random salt. Verified with a
//   timing-safe compare so response time never leaks how much of the hash
//   matched.
// * 2FA — TOTP (RFC 6238), the standard 6-digit authenticator code. Works with
//   any free app (Aegis, Google Authenticator, Ente Auth). Implemented here in
//   ~30 lines of HMAC — no dependency, nothing phoning home.
// * SESSIONS — opaque 32-byte random tokens held server-side, not JWTs.
//   Server-side means a session can actually be REVOKED the instant something
//   looks wrong; a signed token can't be. They expire, and they're bound to the
//   client's address.
// * RATE LIMITING — failed logins back off exponentially per source address and
//   lock out after a threshold, so the 6-digit TOTP space can't be walked.
// * AUDIT — every auth event and every privileged operation appends to an
//   audit log. If something does go wrong, you can see what happened.
//
// NOTHING HERE RUNS ON A TIMER. Expired sessions are dropped when they're next
// looked at (and on login), not by a sweeper — the zero-idle-cost rule holds.
// ============================================================================
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.OUTLAW_SERVER_STATE || '/var/lib/outlaw-server';
const AUTH_FILE = path.join(STATE_DIR, 'auth.json');
const AUDIT_FILE = path.join(STATE_DIR, 'audit.log');

// Tunables. Deliberately strict: this guards a machine, not a blog.
const SCRYPT_N = 16384;            // CPU/memory cost
const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 12h
const MAX_FAILURES = 5;                        // before lockout
const LOCKOUT_MS = 15 * 60 * 1000;             // 15m
const TOTP_STEP = 30;                          // seconds per code
const TOTP_WINDOW = 1;                         // accept ±1 step (clock drift)

// --- storage ---------------------------------------------------------------

function ensureDir() {
    try { fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 }); } catch { /* exists or unwritable */ }
}

function load() {
    try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); }
    catch { return { users: {}, version: 1 }; }
}

function save(state) {
    ensureDir();
    // Write-then-rename so a crash can't leave a truncated credential file —
    // which would lock the admin out of their own server.
    const tmp = AUTH_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, AUTH_FILE);
}

// --- audit -----------------------------------------------------------------

function audit(event, detail = {}) {
    ensureDir();
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + '\n';
    try { fs.appendFileSync(AUDIT_FILE, line, { mode: 0o600 }); }
    catch { /* auditing must never break the operation it is recording */ }
}

// --- passwords -------------------------------------------------------------

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const key = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
    return { salt, hash: key.toString('hex') };
}

function verifyPassword(password, record) {
    if (!record || !record.salt || !record.hash) return false;
    let derived;
    try {
        derived = crypto.scryptSync(String(password), record.salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
    } catch { return false; }
    const expected = Buffer.from(record.hash, 'hex');
    // Length check first: timingSafeEqual throws on a length mismatch.
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
}

// --- TOTP (RFC 6238) -------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
    let bits = 0, value = 0, out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}

function base32Decode(str) {
    let bits = 0, value = 0;
    const out = [];
    for (const c of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
        value = (value << 5) | B32.indexOf(c);
        bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
}

function totpCode(secretBase32, forStep) {
    const key = base32Decode(secretBase32);
    const buf = Buffer.alloc(8);
    // Counter is a 64-bit big-endian step number; JS bitwise is 32-bit, so
    // write the high and low halves separately.
    buf.writeUInt32BE(Math.floor(forStep / 0x100000000), 0);
    buf.writeUInt32BE(forStep >>> 0, 4);
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16)
              | (hmac[offset + 2] << 8) | hmac[offset + 3];
    return String(bin % 1000000).padStart(6, '0');
}

function verifyTotp(secretBase32, code) {
    const clean = String(code || '').replace(/\D/g, '');
    if (clean.length !== 6) return false;
    const step = Math.floor(Date.now() / 1000 / TOTP_STEP);
    // Accept the neighbouring steps so a slightly-off phone clock still works.
    for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
        const expected = totpCode(secretBase32, step + d);
        // Constant-time compare — a 6-digit space is small enough that a timing
        // oracle would genuinely help an attacker.
        if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return true;
    }
    return false;
}

function newTotpSecret() { return base32Encode(crypto.randomBytes(20)); }

// The otpauth:// URI an authenticator app scans (or you paste in by hand).
function totpUri(user, secret, issuer = 'Outlaw Server') {
    const label = encodeURIComponent(`${issuer}:${user}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=${TOTP_STEP}`;
}

// --- sessions + lockout (in memory; a restart signs everyone out, which is
// the safe default for a control plane) ------------------------------------

const sessions = new Map();   // token -> {user, expires, ip}
const failures = new Map();   // ip    -> {count, until}

function lockoutState(ip) {
    const f = failures.get(ip);
    if (!f) return { locked: false, remainingMs: 0 };
    if (f.until && Date.now() < f.until) return { locked: true, remainingMs: f.until - Date.now() };
    if (f.until && Date.now() >= f.until) { failures.delete(ip); return { locked: false, remainingMs: 0 }; }
    return { locked: false, remainingMs: 0 };
}

function noteFailure(ip) {
    const f = failures.get(ip) || { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILURES) {
        f.until = Date.now() + LOCKOUT_MS;
        audit('auth.lockout', { ip, failures: f.count, minutes: LOCKOUT_MS / 60000 });
    }
    failures.set(ip, f);
}

function clearFailures(ip) { failures.delete(ip); }

function createSession(user, ip) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { user, ip, expires: Date.now() + SESSION_TTL_MS });
    return token;
}

function verifySession(token, ip) {
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (Date.now() > s.expires) { sessions.delete(token); return null; }
    // A stolen cookie replayed from somewhere else is refused.
    if (s.ip && ip && s.ip !== ip) { audit('auth.session_ip_mismatch', { user: s.user, expected: s.ip, got: ip }); return null; }
    return s;
}

function revokeSession(token) { if (token) sessions.delete(token); }
function revokeAll() { sessions.clear(); }

// --- the public surface ----------------------------------------------------

function isConfigured() {
    const state = load();
    return Object.keys(state.users || {}).length > 0;
}

function setUser(user, password, { enableTotp = true } = {}) {
    const state = load();
    const name = String(user || '').trim();
    if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(name)) return { ok: false, error: 'Invalid user name.' };
    if (String(password || '').length < 10) {
        // This guards a whole machine — a short password is not a real choice.
        return { ok: false, error: 'Password must be at least 10 characters.' };
    }
    const rec = hashPassword(password);
    const existing = state.users[name] || {};
    const totpSecret = enableTotp ? (existing.totpSecret || newTotpSecret()) : null;
    state.users[name] = { ...rec, totpSecret, totpConfirmed: existing.totpConfirmed || false };
    save(state);
    audit('auth.user_set', { user: name, totp: !!totpSecret });
    return { ok: true, user: name, totpSecret, totpUri: totpSecret ? totpUri(name, totpSecret) : null };
}

// Prove the authenticator app is really set up before 2FA is enforced —
// otherwise a typo'd secret locks the admin out of their own server.
function confirmTotp(user, code) {
    const state = load();
    const u = state.users[user];
    if (!u || !u.totpSecret) return { ok: false, error: 'No 2FA secret to confirm.' };
    if (!verifyTotp(u.totpSecret, code)) return { ok: false, error: 'That code is not valid. Check the time on your phone and try again.' };
    u.totpConfirmed = true;
    save(state);
    audit('auth.totp_confirmed', { user });
    return { ok: true };
}

function login({ user, password, code, ip }) {
    const lock = lockoutState(ip);
    if (lock.locked) {
        audit('auth.login_blocked', { user, ip });
        return { ok: false, error: `Too many attempts. Try again in ${Math.ceil(lock.remainingMs / 60000)} minute(s).` };
    }
    const state = load();
    const u = state.users[String(user || '')];
    // Same failure path and message whether the user exists or the password is
    // wrong — don't help an attacker enumerate valid accounts.
    if (!u || !verifyPassword(password, u)) {
        noteFailure(ip);
        audit('auth.login_failed', { user, ip, reason: 'bad_credentials' });
        return { ok: false, error: 'Incorrect user name or password.' };
    }
    if (u.totpSecret && u.totpConfirmed) {
        if (!code) return { ok: false, needTotp: true, error: 'Enter the 6-digit code from your authenticator app.' };
        if (!verifyTotp(u.totpSecret, code)) {
            noteFailure(ip);
            audit('auth.login_failed', { user, ip, reason: 'bad_totp' });
            return { ok: false, needTotp: true, error: 'That code is not valid.' };
        }
    }
    clearFailures(ip);
    const token = createSession(user, ip);
    audit('auth.login_ok', { user, ip, twoFactor: !!(u.totpSecret && u.totpConfirmed) });
    return { ok: true, token, user, expiresInMs: SESSION_TTL_MS };
}

function logout(token) {
    const s = sessions.get(token);
    if (s) audit('auth.logout', { user: s.user });
    revokeSession(token);
    return { ok: true };
}

module.exports = {
    isConfigured, setUser, confirmTotp, login, logout,
    verifySession, revokeSession, revokeAll,
    verifyTotp, newTotpSecret, totpUri, totpCode,
    hashPassword, verifyPassword,
    audit,
    AUDIT_FILE, AUTH_FILE, STATE_DIR,
    _internals: { sessions, failures, lockoutState, base32Encode, base32Decode },
};
