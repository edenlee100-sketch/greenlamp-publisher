import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth, useAuthProfile } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

const API_BASE = 'https://greenlamp-publisher-production-75fd.up.railway.app'

// Switch targets are identified by ROLE — the backend resolves each to a real
// user at click time, so the buttons keep working as users are added/removed.
const ROLE_BUTTONS = {
  or:        { role: 'or',        initial: 'O', label: 'Switch to Or',        color: '#16a34a' },
  denise:    { role: 'denise',    initial: 'D', label: 'Switch to Denise',    color: '#7c3aed' },
  publisher: { role: 'publisher', initial: 'E', label: 'Switch to Publisher', color: '#0369a1' },
}

// Any user may switch into any role — the backend enforces only that the
// caller presents a valid access token.
const ALL_TARGETS = [ROLE_BUTTONS.or, ROLE_BUTTONS.denise, ROLE_BUTTONS.publisher]

function UserSwitcher({ role }) {
  const [switchingTo, setSwitchingTo] = useState(null)
  const [switchError,  setSwitchError]  = useState('')

  if (!role) return null
  const targets = ALL_TARGETS

  const handleSwitch = async (target) => {
    if (switchingTo) return
    setSwitchingTo(target.role)
    setSwitchError('')

    // Keep the current session so we can put the user back exactly as they were
    // if any step fails. Without this a failed setSession leaves them signed out.
    let previousSession = null

    try {
      console.log(`[switch-user] → ${target.role}`)

      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
      if (sessionErr) {
        console.error('[switch-user] getSession failed:', sessionErr)
        throw new Error('Could not read your current session. Try signing in again.')
      }
      previousSession = sessionData?.session ?? null
      if (!previousSession?.access_token) {
        throw new Error('Your session has expired — please sign in again.')
      }

      const res = await fetch(`${API_BASE}/api/admin/switch-user`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${previousSession.access_token}`,
        },
        body: JSON.stringify({ target_role: target.role }),
      })

      const data = await res.json().catch(() => ({}))
      console.log(`[switch-user] backend responded ${res.status}`, data?.email ?? '')

      if (!res.ok) {
        throw new Error(data.detail || `Switch failed (HTTP ${res.status}).`)
      }
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

      console.log(`[switch-user] now signed in as ${data.email}`)

      // Full reload rather than client-side navigation. Reading the new user's
      // profile immediately races the client's token swap — the query can still
      // carry the old token, return no rows under RLS, and null out the role,
      // which reads as being signed out. Reloading bootstraps auth cleanly and
      // also drops any data cached for the previous user.
      window.location.replace('/clients')
    } catch (err) {
      console.error('[switch-user] FAILED:', err)

      // Restore the previous session if it was disturbed, so a failed switch
      // never logs the user out of the account they were already using.
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
