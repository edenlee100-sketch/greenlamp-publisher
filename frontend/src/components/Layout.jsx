import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth, useAuthProfile } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

const API_BASE = 'https://greenlamp-publisher-production-75fd.up.railway.app'

// Targets are identified by ROLE, never by email address. The three roles are
// permanent; the accounts behind them change as users are added and removed.
const ROLE_BUTTONS = {
  or:        { role: 'or',        initial: 'O', label: 'Switch to Or',        color: '#16a34a' },
  denise:    { role: 'denise',    initial: 'D', label: 'Switch to Denise',    color: '#7c3aed' },
  publisher: { role: 'publisher', initial: 'E', label: 'Switch to Publisher', color: '#0369a1' },
}

// Which roles each role can switch into — unchanged from today's behaviour.
const SWITCH_TARGETS_BY_ROLE = {
  or:        [ROLE_BUTTONS.denise, ROLE_BUTTONS.publisher],
  denise:    [ROLE_BUTTONS.or],
  publisher: [ROLE_BUTTONS.or],
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

    // Held so a failure can put the user back exactly where they were.
    let previousSession = null

    try {
      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
      if (sessionErr) {
        console.error('[switch-user] getSession failed:', sessionErr)
        throw new Error('Could not read your current session.')
      }
      previousSession = sessionData?.session ?? null
      if (!previousSession?.access_token) {
        throw new Error('Your session has expired — please sign in again.')
      }

      // The backend resolves the role to the oldest matching profile, verifies
      // this caller's token, and returns a session for that account.
      const res = await fetch(`${API_BASE}/api/admin/switch-user`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${previousSession.access_token}`,
        },
        body: JSON.stringify({ target_role: target.role }),
      })

      const data = await res.json().catch(() => ({}))
      console.log(`[switch-user] ${target.role} → HTTP ${res.status}`, data?.email ?? '')

      if (!res.ok) throw new Error(data.detail || `Switch failed (HTTP ${res.status}).`)
      if (!data.access_token || !data.refresh_token) {
        console.error('[switch-user] response missing tokens:', data)
        throw new Error('The server did not return a usable session.')
      }

      const { error: setErr } = await supabase.auth.setSession({
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
      })
      if (setErr) {
        console.error('[switch-user] setSession failed:', setErr)
        throw new Error(setErr.message || 'Could not apply the new session.')
      }

      // Full reload, deliberately. Auth then bootstraps through the normal
      // first-load path, which is known-good. Client-side navigation here
      // depends on the order in which AuthContext resolves the role and has
      // previously bounced users to the login page.
      window.location.replace('/clients')
    } catch (err) {
      console.error('[switch-user] FAILED:', err)

      // Never leave the user signed out: if the stored session was replaced or
      // cleared, put the original one back.
      if (previousSession?.access_token && previousSession?.refresh_token) {
        try {
          const { data: current } = await supabase.auth.getSession()
          if (current?.session?.access_token !== previousSession.access_token) {
            console.warn('[switch-user] restoring previous session')
            await supabase.auth.setSession({
              access_token:  previousSession.access_token,
              refresh_token: previousSession.refresh_token,
            })
          }
        } catch (restoreErr) {
          console.error('[switch-user] could not restore previous session:', restoreErr)
        }
      }

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
