import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { supabase } from '../lib/supabase'

const API_BASE = 'https://greenlamp-publisher-production-75fd.up.railway.app'

async function registerPush(userId) {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.log('[push] browser does not support service workers or PushManager')
      return
    }

    const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
    if (!vapidKey) {
      console.warn('[push] VITE_VAPID_PUBLIC_KEY not set — skipping')
      return
    }

    // Check permission without prompting first so we can log the current state
    console.log('[push] current Notification.permission:', Notification.permission)
    if (Notification.permission === 'denied') {
      console.warn('[push] permission is denied — Or must re-enable in browser settings (chrome://settings/content/notifications)')
      return
    }
    const permission = await Notification.requestPermission()
    console.log('[push] permission after requestPermission():', permission)
    if (permission !== 'granted') return

    const registration = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
    console.log('[push] service worker ready — active SW state:', registration.active?.state)

    // Convert base64url VAPID public key to Uint8Array
    const padding = '='.repeat((4 - vapidKey.length % 4) % 4)
    const base64  = (vapidKey + padding).replace(/-/g, '+').replace(/_/g, '/')
    const rawKey  = Uint8Array.from(atob(base64), c => c.charCodeAt(0))

    // Always unsubscribe first so we get a guaranteed-fresh endpoint from the
    // push service. Stale endpoints (e.g. after a SW update or a browser
    // push-service rotation) cause silent 410 delivery failures on the backend.
    const existing = await registration.pushManager.getSubscription()
    if (existing) {
      console.log('[push] unsubscribing stale endpoint:', existing.endpoint.slice(-50))
      await existing.unsubscribe()
    }

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: rawKey,
    })
    console.log('[push] new subscription endpoint:', subscription.endpoint.slice(-50))

    const res = await fetch(`${API_BASE}/api/push/subscribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ user_id: userId, subscription: subscription.toJSON() }),
    })
    console.log('[push] /api/push/subscribe →', res.status, res.ok ? 'OK' : 'FAILED')
  } catch (err) {
    console.warn('[push] registerPush failed:', err)
  }
}

// ─── Contexts ───────────────────────────────────────────────────────────────
// Split into two so the topbar (email / sign-out) can subscribe without
// re-rendering the entire page when auth-profile data changes.
const AuthContext        = createContext(null)  // { loading, role, signOut }
const AuthProfileContext = createContext(null)  // { user }

// ─── Provider ────────────────────────────────────────────────────────────────
export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null)
  const [role,    setRole]    = useState(null)
  const [loading, setLoading] = useState(true)

  // Tracks the ID of the currently authenticated user in a ref so that
  // token-refresh events (same user, new JWT) can be detected and ignored
  // without triggering any state updates or consumer re-renders.
  const authedUserIdRef = useRef(null)

  // Role supplied out-of-band by the user switcher, which already learned it
  // from the backend. Lets the switch path skip the RLS-guarded profiles query
  // entirely — that query contends with the auth lock during setSession and is
  // the slow, failure-prone step.
  const roleHintRef = useRef(null)   // { userId, role }

  const primeRole = useCallback((userId, role) => {
    if (userId && role) roleHintRef.current = { userId, role }
  }, [])

  const fetchRoleOnce = async (userId) => {
    try {
      const result = await Promise.race([
        supabase.from('profiles').select('role').eq('id', userId).single(),
        new Promise(resolve =>
          setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 3000)
        ),
      ])
      const { data, error } = result
      if (error) return { role: null, error }
      return { role: data?.role ?? null, error: null }
    } catch (err) {
      return { role: null, error: err }
    }
  }

  // A null role bounces the user to /login, so one transient failure must not
  // decide it. Retry once — this also covers the window just after a user
  // switch, where the first query can still carry the previous access token
  // and return no rows under RLS.
  const fetchRole = async (userId) => {
    const first = await fetchRoleOnce(userId)
    if (first.role) return first.role
    if (first.error) console.warn('[auth] role lookup failed, retrying:', first.error)
    await new Promise(r => setTimeout(r, 600))
    const second = await fetchRoleOnce(userId)
    if (!second.role) {
      console.error('[auth] role lookup failed after retry:', second.error)
    }
    return second.role
  }

  useEffect(() => {
    let mounted = true

    // IMPORTANT: this callback must stay synchronous and must not call any
    // supabase.* API directly.
    //
    // supabase-js invokes state-change subscribers from inside its auth lock
    // (_acquireLock -> _notifyAllSubscribers) and AWAITS each callback. Any
    // Supabase call made here re-enters that lock — every DB query resolves its
    // token via auth.getSession() — and the re-entrant call queues behind the
    // very callback the lock is waiting on. That deadlocks until
    // lockAcquireTimeout, which previously surfaced as the switcher hanging and
    // then logging the user out when the role lookup timed out to null.
    //
    // Deferring with setTimeout(0) lets the callback return, releases the lock,
    // and runs the work on a clean tick.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (!mounted) return

        if (session?.user) {
          const userId    = session.user.id
          const isNewUser = userId !== authedUserIdRef.current

          if (isNewUser) {
            // Genuine new login, user switch, or first page load.
            authedUserIdRef.current = userId
            setUser(session.user)

            setTimeout(async () => {
              if (!mounted) return   // stale mount (StrictMode)

              // Fast path: the switcher already told us this user's role.
              const hint = roleHintRef.current
              let r = hint && hint.userId === userId ? hint.role : null
              if (r) {
                console.log('[auth] using role supplied by switcher:', r)
                roleHintRef.current = null
              } else {
                r = await fetchRole(userId)
              }
              if (!mounted) return

              if (r) {
                setRole(r)
              } else {
                // A failed lookup must NOT sign the user out. We hold a valid
                // session, so nulling the role here would send ProtectedRoute
                // to /login even though authentication succeeded.
                console.error(
                  '[auth] could not resolve role for the signed-in user; ' +
                  'keeping the session and leaving the previous role in place.'
                )
              }
              // Only now is auth state complete — keep `loading` true until the
              // role is settled, or ProtectedRoute sees role=null and bounces.
              setLoading(false)

              // Background, non-blocking.
              registerPush(userId)
            }, 0)
          } else {
            // Same user (TOKEN_REFRESHED, etc.) — user/role already correct.
            setLoading(false)
          }
        } else {
          // Signed out
          authedUserIdRef.current = null
          setUser(null)
          setRole(null)
          setLoading(false)
        }
      }
    )

    // Safety net: if onAuthStateChange never fires (stale/corrupt localStorage),
    // don't leave the app stuck on "Loading…" indefinitely.
    const fallback = setTimeout(() => {
      if (mounted) setLoading(false)
    }, 5000)

    return () => {
      mounted = false
      // Reset so the next effect invocation (React StrictMode double-invoke)
      // treats the first session as a fresh login rather than a same-user event.
      authedUserIdRef.current = null
      clearTimeout(fallback)
      subscription.unsubscribe()
    }
  }, [])

  // useCallback so the function reference is stable across renders —
  // prevents useMemo below from generating a new context object every render.
  const signOut = useCallback(async () => {
    setUser(null)
    setRole(null)

    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('sb-')) localStorage.removeItem(key)
    })

    await supabase.auth.signOut()
  }, [])

  // ── Split context values ──────────────────────────────────────────────────
  // authValue: consumed by ProtectedRoute, page components, any role-gated UI.
  // Stable as long as loading/role/signOut don't change — TOKEN_REFRESHED won't
  // touch any of these, so page components won't re-render.
  const authValue = useMemo(
    () => ({ loading, role, signOut, primeRole }),
    [loading, role, signOut, primeRole]
  )

  // profileValue: consumed only by the topbar (Layout).
  // Kept separate so a future email/avatar update doesn't re-render every page.
  const profileValue = useMemo(
    () => ({ user }),
    [user]
  )

  return (
    <AuthContext.Provider value={authValue}>
      <AuthProfileContext.Provider value={profileValue}>
        {children}
      </AuthProfileContext.Provider>
    </AuthContext.Provider>
  )
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

// Used by ProtectedRoute and page components (role-gated rendering, signOut).
export const useAuth = () => useContext(AuthContext)

// Used by Layout / topbar only — isolates re-renders caused by user object
// changes from the rest of the component tree.
export const useAuthProfile = () => useContext(AuthProfileContext)
