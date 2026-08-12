import { useState } from 'react'
import { Link } from 'react-router-dom'
import { createClient } from '@supabase/supabase-js'
import { useAuth, useAuthProfile } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

const API_BASE = 'https://greenlamp-publisher-production-75fd.up.railway.app'

// DIAGNOSTIC BUILD — remove SWITCH_DEBUG_DELAY_MS once the switch works.
const SWITCH_DEBUG_DELAY_MS = 5000

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

const log  = (...a) => console.log('[switch]', ...a)
const warn = (...a) => console.warn('[switch]', ...a)
const err  = (...a) => console.error('[switch]', ...a)

// supabase-js derives this as `sb-<first hostname label>-auth-token`.
function storageKeyForUrl(url) {
  try {
    return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`
  } catch {
    return null
  }
}

// Read the persisted session back out of localStorage and summarise who it is for.
function readStoredSession(key) {
  if (!key) return { key, present: false, note: 'no storage key' }
  const raw = localStorage.getItem(key)
  if (!raw) return { key, present: false, note: 'key absent from localStorage' }
  try {
    const parsed = JSON.parse(raw)
    const sess   = parsed?.currentSession ?? parsed
    return {
      key,
      present:   true,
      userId:    sess?.user?.id    ?? '(none)',
      userEmail: sess?.user?.email ?? '(none)',
      tokenTail: (sess?.access_token ?? '').slice(-12),
      expiresAt: sess?.expires_at ?? '(none)',
    }
  } catch (e) {
    return { key, present: true, note: `unparseable: ${e.message}`, rawLength: raw.length }
  }
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

    const t0 = performance.now()
    const ms = () => `${Math.round(performance.now() - t0)}ms`
    const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
    const storageKey   = storageKeyForUrl(SUPABASE_URL)

    // ── PROBE ─────────────────────────────────────────────────────────────
    // Purely observational, synchronous, and torn down before we navigate.
    // supabase-js names its BroadcastChannel after the storageKey, so a second
    // client sharing that key is NOT isolated: its SIGNED_IN is rebroadcast to
    // this client, whose in-memory session is still the OLD user. If that is
    // what breaks the switch, this probe fires with the NEW user id while the
    // shared client still holds the old token.
    let probe = null
    try {
      probe = supabase.auth.onAuthStateChange((event, session) => {
        warn(`[${ms()}] PROBE: shared client saw auth event "${event}"`,
             '| session user:', session?.user?.id ?? '(none)',
             '| email:', session?.user?.email ?? '(none)')
      })
      log('probe attached to the shared client')
    } catch (e) {
      warn('could not attach probe:', e)
    }

    const detachProbe = () => {
      try { probe?.data?.subscription?.unsubscribe() } catch { /* ignore */ }
    }

    try {
      log('════════ SWITCH START ════════')
      log(`[${ms()}] target role:`, target.role)
      log(`[${ms()}] supabase url:`, SUPABASE_URL)
      log(`[${ms()}] derived storage key:`, storageKey)
      log(`[${ms()}] stored session BEFORE:`, readStoredSession(storageKey))

      // ── 1. Current session (read-only on the shared client) ──────────────
      log(`[${ms()}] reading current session from shared client…`)
      const { data: sessData, error: sessErr } = await supabase.auth.getSession()
      if (sessErr) {
        err(`[${ms()}] getSession error:`, sessErr)
        throw new Error('Could not read your current session.')
      }
      const cur = sessData?.session
      log(`[${ms()}] current session:`, {
        userId:    cur?.user?.id    ?? '(none)',
        userEmail: cur?.user?.email ?? '(none)',
        tokenTail: (cur?.access_token ?? '').slice(-12),
      })
      if (!cur?.access_token) throw new Error('Your session has expired — please sign in again.')

      // ── 2. Backend call ──────────────────────────────────────────────────
      log(`[${ms()}] POST /api/admin/switch-user  target_role=${target.role}`)
      const res = await fetch(`${API_BASE}/api/admin/switch-user`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${cur.access_token}`,
        },
        body: JSON.stringify({ target_role: target.role }),
      })
      const body = await res.json().catch(e => ({ _parseError: String(e) }))
      log(`[${ms()}] backend HTTP ${res.status} ${res.ok ? '(ok)' : '(NOT ok)'}`)
      log(`[${ms()}] backend response body:`, body)

      if (!res.ok) throw new Error(body.detail || `Switch failed (HTTP ${res.status}).`)
      if (!body.access_token || !body.refresh_token) {
        err(`[${ms()}] response missing tokens`, body)
        throw new Error('The server did not return a usable session.')
      }
      log(`[${ms()}] target account:`, {
        email:   body.email   ?? '(none)',
        role:    body.role    ?? '(none)',
        user_id: body.user_id ?? '(none)',
        accessTokenTail:  body.access_token.slice(-12),
        refreshTokenTail: body.refresh_token.slice(-12),
      })

      // ── 3. Isolated client ───────────────────────────────────────────────
      log(`[${ms()}] creating isolated supabase client…`)
      const tmp = createClient(
        SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_ANON_KEY,
        { auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false } }
      )
      log(`[${ms()}] isolated client created.`, {
        storageKey:       tmp.auth.storageKey,
        matchesShared:    tmp.auth.storageKey === supabase.auth.storageKey,
        ownSubscribers:   tmp.auth.stateChangeEmitters?.size,
        sharedSubscribers: supabase.auth.stateChangeEmitters?.size,
        hasBroadcastChannel: !!tmp.auth.broadcastChannel,
        sharedHasBroadcastChannel: !!supabase.auth.broadcastChannel,
      })
      if (tmp.auth.broadcastChannel && supabase.auth.broadcastChannel) {
        warn(`[${ms()}] BOTH clients have a BroadcastChannel named "${tmp.auth.storageKey}" — ` +
             'the isolated client is NOT isolated; its SIGNED_IN will be rebroadcast ' +
             'to the shared client. Watch for a PROBE line next.')
      }

      // ── 4. setSession on the isolated client ─────────────────────────────
      const tSet = performance.now()
      log(`[${ms()}] calling setSession on isolated client…`)
      const { data: setData, error: setErr } = await tmp.auth.setSession({
        access_token:  body.access_token,
        refresh_token: body.refresh_token,
      })
      const setMs = Math.round(performance.now() - tSet)
      log(`[${ms()}] setSession returned after ${setMs}ms`)
      if (setErr) {
        err(`[${ms()}] setSession error:`, setErr)
        throw new Error(setErr.message || 'Could not store the new session.')
      }
      log(`[${ms()}] setSession result user:`, {
        userId:    setData?.session?.user?.id    ?? '(none)',
        userEmail: setData?.session?.user?.email ?? '(none)',
      })

      // ── 5. Did it actually reach storage? ────────────────────────────────
      const after = readStoredSession(storageKey)
      log(`[${ms()}] stored session AFTER:`, after)
      if (after.userId && body.user_id && after.userId === body.user_id) {
        log(`[${ms()}] ✅ storage now holds the TARGET user (${after.userEmail})`)
      } else {
        warn(`[${ms()}] ⚠️ storage does NOT hold the target user — ` +
             `expected ${body.user_id}, found ${after.userId ?? '(none)'}`)
      }

      // ── 6. What does the shared client think now? ────────────────────────
      const { data: sharedNow } = await supabase.auth.getSession()
      log(`[${ms()}] shared client session AFTER setSession:`, {
        userId:    sharedNow?.session?.user?.id    ?? '(none)',
        userEmail: sharedNow?.session?.user?.email ?? '(none)',
        tokenTail: (sharedNow?.session?.access_token ?? '').slice(-12),
        note: 'if this is still the OLD user while a PROBE fired for the NEW user, ' +
              'that mismatch is what makes the role lookup fail under RLS',
      })

      // ── 7. Deliberate pause so the console can be read/screenshotted ─────
      log(`[${ms()}] ⏳ waiting ${SWITCH_DEBUG_DELAY_MS / 1000}s so logs can be read ` +
          '— screenshot the console NOW (enable "Preserve log" to keep it across the reload)')
      await new Promise(r => setTimeout(r, SWITCH_DEBUG_DELAY_MS))

      log(`[${ms()}] stored session immediately BEFORE navigation:`, readStoredSession(storageKey))
      detachProbe()
      log(`[${ms()}] navigating to /clients via window.location.replace …`)
      log('════════ SWITCH END ════════')
      window.location.replace('/clients')
    } catch (e) {
      err('FAILED:', e)
      err('stored session at failure:', readStoredSession(storageKey))
      detachProbe()
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
