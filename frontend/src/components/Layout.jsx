import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
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

// Which roles each role can switch into — mirrors SWITCH_GRAPH on the backend.
const SWITCH_TARGETS_BY_ROLE = {
  or:        [ROLE_BUTTONS.denise, ROLE_BUTTONS.publisher],
  denise:    [ROLE_BUTTONS.or],
  publisher: [ROLE_BUTTONS.or],
}

function UserSwitcher({ role }) {
  const [switchingTo, setSwitchingTo] = useState(null)
  const [switchError,  setSwitchError]  = useState('')
  const navigate = useNavigate()

  const targets = SWITCH_TARGETS_BY_ROLE[role] ?? []
  if (targets.length === 0) return null

  const handleSwitch = async (target) => {
    if (switchingTo) return
    setSwitchingTo(target.role)
    setSwitchError('')
    try {
      // Send our own access token so the backend can verify who is asking.
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Your session expired — sign in again.')

      const res = await fetch(`${API_BASE}/api/admin/switch-user`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ target_role: target.role }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || 'Could not switch user.')

      const { error } = await supabase.auth.setSession({
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
      })
      if (error) throw error
      navigate('/clients')
    } catch (err) {
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
