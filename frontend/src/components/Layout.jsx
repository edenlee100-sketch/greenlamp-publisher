import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth, useAuthProfile } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

const API_BASE = 'https://greenlamp-publisher-production-75fd.up.railway.app'

// Targets are identified by ROLE, never by email — several users may hold the
// same role, and the accounts behind a role change over time.
const ROLE_BUTTONS = {
  or:        { role: 'or',        initial: 'O', label: 'Switch to Or',        color: '#16a34a' },
  denise:    { role: 'denise',    initial: 'D', label: 'Switch to Denise',    color: '#7c3aed' },
  publisher: { role: 'publisher', initial: 'E', label: 'Switch to Publisher', color: '#0369a1' },
}

const SWITCH_TARGETS_BY_ROLE = {
  or:        [ROLE_BUTTONS.denise, ROLE_BUTTONS.publisher],
  denise:    [ROLE_BUTTONS.or],
  publisher: [ROLE_BUTTONS.or],
}

// auth-js derives its storage key as `sb-<first hostname label>-auth-token`
// (SupabaseClient: `sb-${baseUrl.hostname.split(".")[0]}-auth-token`).
function authStorageKey() {
  return `sb-${new URL(import.meta.env.VITE_SUPABASE_URL).hostname.split('.')[0]}-auth-token`
}

/**
 * Write the new session straight into auth-js's storage key — no Supabase
 * client involved.
 *
 * This is deliberate. Every previous attempt routed the write through a client
 * (the shared one, then a second "isolated" one) and both failed for the same
 * reason: setSession() calls _notifyAllSubscribers, which posts to a
 * BroadcastChannel *named after the storage key*. Any other client using that
 * key — including the app's own — receives SIGNED_IN for the new user while its
 * in-memory session is still the old one. AuthContext then looks up the new
 * user's profile with the old token, RLS (auth.uid() = id) matches nothing, the
 * role resolves to null and ProtectedRoute redirects to /login. That is the
 * "publisher page loads, then bounces to login" behaviour seen in production.
 *
 * A plain localStorage write emits no auth event, no broadcast, and takes no
 * lock, so nothing observes the change until the hard reload — at which point
 * auth-js reads it through initialize(), the same path a normal page load uses.
 *
 * Format verified against auth-js: _saveSession does
 * `storage.setItem(storageKey, JSON.stringify(session))` with the session flat
 * (no wrapper), and _isValidSession requires access_token, refresh_token and
 * expires_at. The backend returns the session exactly as the auth server issued
 * it, so the shape is authentic rather than reconstructed.
 */
function writeSessionToStorage(session) {
  const key = authStorageKey()
  if (!session || !session.access_token || !session.refresh_token || !session.expires_at) {
    throw new Error('The server did not return a usable session.')
  }
  localStorage.setItem(key, JSON.stringify(session))

  // Read back so a quota error or a storage-policy block cannot pass silently.
  const stored = JSON.parse(localStorage.getItem(key) || 'null')
  if (stored?.access_token !== session.access_token) {
    throw new Error('The new session could not be saved to this browser.')
  }
  return { key, userId: stored?.user?.id, email: stored?.user?.email }
}

function UserSwitcher({ role }) {
  const [switchingTo, setSwitchingTo] = useState(null)
  const [switchError,  setSwitchError]  = useState('')

  const targets = SWITCH_TARGETS_BY_ROLE[role] ?? []
  if (targets.length === 0) return null

  const handleSwitch = async (target) => {
    if (switchingTo) return
    setSwitchingTo(target.role)
    setSwitchError('')

    try {
      console.log('[switch] target role:', target.role)

      // Read-only on the shared client: getSession() notifies nobody.
      const { data, error: sessErr } = await supabase.auth.getSession()
      if (sessErr) throw new Error('Could not read your current session.')
      const token = data?.session?.access_token
      if (!token) throw new Error('Your session has expired — please sign in again.')

      const res = await fetch(`${API_BASE}/api/admin/switch-user`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ target_role: target.role }),
      })
      const body = await res.json().catch(() => ({}))
      console.log(`[switch] backend HTTP ${res.status}`, body?.email ?? '')

      if (!res.ok) throw new Error(body.detail || `Switch failed (HTTP ${res.status}).`)

      const written = writeSessionToStorage(body.session)
      console.log('[switch] session written to', written.key, '→', written.email ?? written.userId)

      console.log('[switch] reloading as the new user…')
      window.location.replace('/clients')
    } catch (e) {
      // Nothing above touches the shared client's session, so the current login
      // is untouched by a failure — only the message needs showing.
      console.error('[switch] FAILED:', e)
      setSwitchError(e.message || 'Switch failed')
      setSwitchingTo(null)
    }
  }

  return (
    <div className="user-switcher">
      {targets.map(target => (
        <button
          key={target.role}
          className="user-switch-btn"
          style={{ '--switch-color': target.color }}
          title={target.label}
          onClick={() => handleSwitch(target)}
          disabled={!!switchingTo}
        >
          {switchingTo === target.role ? '…' : target.initial}
        </button>
      ))}
      {switchError && (
        <span className="user-switch-message" role="alert">
          {switchError}
          <button
            className="user-switch-dismiss"
            onClick={() => setSwitchError('')}
            title="Dismiss"
          >
            ×
          </button>
        </span>
      )}
    </div>
  )
}

export default function Layout({ title, children }) {
  // useAuthProfile re-renders only when user email/avatar changes (login/logout).
  // Page content (children) is unaffected by these topbar-only updates.
  const { user }          = useAuthProfile()
  const { signOut, role } = useAuth()

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="topbar-brand">
          <span className="logo-dot" /> Greenlamp Publisher
        </span>
        <div className="topbar-right">
          <UserSwitcher key={role} role={role} />
          {role === 'or' && (
            <Link to="/users" className="topbar-nav-link">Users</Link>
          )}
          <span className="topbar-email">{user?.email}</span>
          <button className="btn-signout" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <main className="page-content">
        {title && <h1 className="page-title">{title}</h1>}
        {children}
      </main>
    </div>
  )
}
