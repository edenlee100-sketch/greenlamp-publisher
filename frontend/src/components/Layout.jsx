import { useState } from 'react'
import { Link } from 'react-router-dom'
import { createClient } from '@supabase/supabase-js'
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

/**
 * Persist a session WITHOUT touching the app's shared Supabase client.
 *
 * Why this exists — this is the bug that broke four previous attempts:
 * auth-js runs setSession() inside its auth lock, and _setSession awaits a
 * network call (_getUser) BEFORE it notifies subscribers. By the time
 * AuthContext's onAuthStateChange callback runs, the lock's pending queue is
 * already populated; that callback awaits a profiles query, which re-enters the
 * lock and waits on the very operation that is waiting for it. The result is a
 * deadlock that only clears at lockAcquireTimeout, by which point fetchRole has
 * hit its own 3s timeout and resolved the role to null — which reads as being
 * signed out.
 *
 * A throwaway client has zero state-change subscribers, so there is no callback
 * to await and no re-entrant lock wait. It derives the SAME storage key from the
 * same URL (`sb-<ref>-auth-token`), so the session it writes is exactly what the
 * app reads on the next page load.
 */
async function persistSessionOutOfBand({ access_token, refresh_token }) {
  const tmp = createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession:     true,   // must write to the shared storage key
        autoRefreshToken:   false,  // discarded immediately by the reload
        detectSessionInUrl: false,
      },
    }
  )
  const { error } = await tmp.auth.setSession({ access_token, refresh_token })
  if (error) throw new Error(error.message || 'Could not store the new session.')
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
      // Read-only on the shared client: getSession() does not notify
      // subscribers, so it cannot trigger the deadlock described above.
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
      console.log(`[switch-user] ${target.role} → HTTP ${res.status}`, body?.email ?? '')

      if (!res.ok) throw new Error(body.detail || `Switch failed (HTTP ${res.status}).`)
      if (!body.access_token || !body.refresh_token) {
        throw new Error('The server did not return a usable session.')
      }

      await persistSessionOutOfBand(body)

      // Hard navigation. Auth then boots through _initialize(), the same path a
      // normal page load takes — the one path known to resolve the role
      // correctly. Nothing here can disturb the login flow.
      window.location.replace('/clients')
    } catch (err) {
      // Nothing above mutates the shared client's session, so a failure leaves
      // the current login exactly as it was. Only the message needs showing.
      console.error('[switch-user] FAILED:', err)
      setSwitchError(err.message || 'Switch failed')
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
