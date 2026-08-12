import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import Layout from '../components/Layout'

const API_BASE = 'https://greenlamp-publisher-production-75fd.up.railway.app'

const RETAINER_SETTING_KEY = 'retainer_email'

const ROLE_LABEL = {
  or:        'Or',
  publisher: 'Publisher (Eden)',
  denise:    'Denise',
}

export default function UsersPage() {
  const { role } = useAuth()
  const navigate = useNavigate()

  const [users,       setUsers]       = useState([])
  const [loadError,   setLoadError]   = useState('')
  const [activeId,    setActiveId]    = useState(null)   // user whose form is open
  const [newPassword, setNewPassword] = useState('')
  const [saving,      setSaving]      = useState(false)
  const [saveError,   setSaveError]   = useState('')
  const [saveSuccess, setSaveSuccess] = useState('')     // email of last success

  // ── Retainer email setting (settings table, key = 'retainer_email') ──
  const [retainer,        setRetainer]        = useState('')
  const [retainerLoaded,  setRetainerLoaded]  = useState(false)
  const [retainerSaving,  setRetainerSaving]  = useState(false)
  const [retainerError,   setRetainerError]   = useState('')
  const [retainerSaved,   setRetainerSaved]   = useState(false)

  // Guard — only Or may access this page
  useEffect(() => {
    if (role && role !== 'or') navigate('/', { replace: true })
  }, [role, navigate])

  useEffect(() => {
    if (role !== 'or') return
    fetch(`${API_BASE}/api/admin/users`)
      .then(r => r.json())
      .then(d => {
        if (d.users) {
          // Sort by a stable order: or → publisher → denise → others
          const order = ['or', 'publisher', 'denise']
          const sorted = [...d.users].sort(
            (a, b) => order.indexOf(a.role) - order.indexOf(b.role)
          )
          setUsers(sorted)
        } else {
          setLoadError('Failed to load users.')
        }
      })
      .catch(() => setLoadError('Failed to load users.'))
  }, [role])

  // Load the current retainer email from the settings table
  useEffect(() => {
    if (role !== 'or') return
    let cancelled = false
    supabase
      .from('settings')
      .select('value')
      .eq('key', RETAINER_SETTING_KEY)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          setRetainerError('Could not load the current retainer email.')
        } else {
          setRetainer(data?.value ?? '')
        }
        setRetainerLoaded(true)
      })
    return () => { cancelled = true }
  }, [role])

  // Auto-dismiss the brief success confirmation
  useEffect(() => {
    if (!retainerSaved) return
    const t = setTimeout(() => setRetainerSaved(false), 3000)
    return () => clearTimeout(t)
  }, [retainerSaved])

  async function saveRetainer(e) {
    e.preventDefault()
    const value = retainer.trim()
    setRetainerError('')
    setRetainerSaved(false)

    if (!value) { setRetainerError('Enter an email address.'); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setRetainerError('Enter a valid email address.'); return
    }

    setRetainerSaving(true)
    try {
      // .select() so we can tell an RLS-blocked / missing-row no-op from a real
      // update — without it Supabase reports success even when nothing changed.
      const { data, error } = await supabase
        .from('settings')
        .update({ value })
        .eq('key', RETAINER_SETTING_KEY)
        .select('key')

      if (error) throw new Error(error.message)
      if (!data || data.length === 0) {
        throw new Error('Nothing was updated — the setting row may be missing.')
      }
      setRetainer(value)
      setRetainerSaved(true)
    } catch (err) {
      setRetainerError(err.message || 'Could not save.')
    } finally {
      setRetainerSaving(false)
    }
  }

  function openForm(userId) {
    setActiveId(userId)
    setNewPassword('')
    setSaveError('')
    setSaveSuccess('')
  }

  function closeForm() {
    setActiveId(null)
    setNewPassword('')
    setSaveError('')
  }

  async function handleSave(user) {
    if (!newPassword) { setSaveError('Enter a new password.'); return }
    if (newPassword.length < 6) { setSaveError('Must be at least 6 characters.'); return }
    setSaving(true)
    setSaveError('')
    try {
      const res = await fetch(`${API_BASE}/api/admin/change-password`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ user_id: user.id, new_password: newPassword }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Error')
      setSaveSuccess(user.email)
      setActiveId(null)
      setNewPassword('')
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (role !== 'or') return null

  return (
    <Layout title="User Management">
      {loadError && <p className="form-error">{loadError}</p>}

      {saveSuccess && (
        <p className="users-success">
          ✓ Password updated for {saveSuccess}
        </p>
      )}

      <div className="users-list">
        {users.map(user => (
          <div key={user.id} className="user-row">
            <div className="user-info">
              <span className="user-name">{ROLE_LABEL[user.role] ?? user.role}</span>
              <span className="user-email">{user.email}</span>
            </div>

            {activeId === user.id ? (
              <form
                className="pw-form"
                onSubmit={e => { e.preventDefault(); handleSave(user) }}
              >
                <input
                  type="password"
                  className="pw-input"
                  placeholder="New password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  autoFocus
                  minLength={6}
                />
                {saveError && <span className="pw-error">{saveError}</span>}
                <div className="pw-actions">
                  <button
                    type="submit"
                    className="btn-primary pw-save"
                    disabled={saving}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className="btn-cancel"
                    onClick={closeForm}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                className="btn-change-pw"
                onClick={() => openForm(user.id)}
              >
                Change Password
              </button>
            )}
          </div>
        ))}
      </div>

      <section className="settings-section">
        <h2 className="settings-heading">Retainer Email</h2>
        <p className="settings-hint">
          "Please add to retainer" emails are sent to this address.
        </p>

        {retainerSaved && (
          <p className="users-success">✓ Retainer email updated</p>
        )}

        <form className="retainer-form" onSubmit={saveRetainer}>
          <input
            type="email"
            className="pw-input"
            placeholder={retainerLoaded ? 'name@example.com' : 'Loading…'}
            value={retainer}
            onChange={e => { setRetainer(e.target.value); setRetainerError('') }}
            disabled={!retainerLoaded || retainerSaving}
          />
          {retainerError && <span className="pw-error">{retainerError}</span>}
          <div className="pw-actions">
            <button
              type="submit"
              className="btn-primary pw-save"
              disabled={!retainerLoaded || retainerSaving}
            >
              {retainerSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </section>
    </Layout>
  )
}
