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

// Must stay in sync with the profiles.role CHECK constraint.
const ROLE_OPTIONS = [
  { value: 'or',        label: 'Or' },
  { value: 'denise',    label: 'Denise' },
  { value: 'publisher', label: 'Publisher' },
]

const ROLE_ORDER = ['or', 'publisher', 'denise']

function sortUsers(list) {
  return [...list].sort((a, b) => {
    // Unknown roles sort last rather than first (indexOf returns -1).
    const ra = ROLE_ORDER.indexOf(a.role), rb = ROLE_ORDER.indexOf(b.role)
    const oa = ra === -1 ? ROLE_ORDER.length : ra
    const ob = rb === -1 ? ROLE_ORDER.length : rb
    if (oa !== ob) return oa - ob
    return (a.email || '').localeCompare(b.email || '')
  })
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

  // ── Add user form ──
  const [newEmail,    setNewEmail]    = useState('')
  const [newPass,     setNewPass]     = useState('')
  const [newRole,     setNewRole]     = useState('denise')
  const [adding,      setAdding]      = useState(false)
  const [addError,    setAddError]    = useState('')
  const [addedEmail,  setAddedEmail]  = useState('')

  // ── Per-user role change / delete ──
  const [rowBusyId,   setRowBusyId]   = useState(null)  // user id mid-request
  const [rowError,    setRowError]    = useState('')
  const [confirmId,   setConfirmId]   = useState(null)  // user pending delete confirm

  // Guard — only Or may access this page
  useEffect(() => {
    if (role && role !== 'or') navigate('/', { replace: true })
  }, [role, navigate])

  async function loadUsers() {
    try {
      const res  = await fetch(`${API_BASE}/api/admin/users`)
      const data = await res.json()
      if (!data.users) throw new Error()
      setUsers(sortUsers(data.users))
      setLoadError('')
    } catch {
      setLoadError('Failed to load users.')
    }
  }

  useEffect(() => {
    if (role !== 'or') return
    loadUsers()
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

  // Auto-dismiss the "user added" confirmation
  useEffect(() => {
    if (!addedEmail) return
    const t = setTimeout(() => setAddedEmail(''), 3000)
    return () => clearTimeout(t)
  }, [addedEmail])

  async function postAdmin(path, body) {
    const res  = await fetch(`${API_BASE}${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.detail || 'Request failed.')
    return data
  }

  async function handleAddUser(e) {
    e.preventDefault()
    const email = newEmail.trim().toLowerCase()
    setAddError('')
    setAddedEmail('')

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setAddError('Enter a valid email address.'); return
    }
    if (newPass.length < 6) {
      setAddError('Password must be at least 6 characters.'); return
    }

    setAdding(true)
    try {
      await postAdmin('/api/admin/create-user', {
        email, password: newPass, role: newRole,
      })
      setNewEmail(''); setNewPass(''); setNewRole('denise')
      setAddedEmail(email)
      await loadUsers()
    } catch (err) {
      setAddError(err.message)
    } finally {
      setAdding(false)
    }
  }

  async function handleRoleChange(user, nextRole) {
    if (nextRole === user.role) return
    setRowError('')
    setRowBusyId(user.id)
    try {
      await postAdmin('/api/admin/update-user-role', {
        user_id: user.id, role: nextRole,
      })
      await loadUsers()
    } catch (err) {
      setRowError(err.message)
      await loadUsers()   // resync the dropdown with the server's actual state
    } finally {
      setRowBusyId(null)
    }
  }

  async function handleDelete(user) {
    setRowError('')
    setRowBusyId(user.id)
    try {
      await postAdmin('/api/admin/delete-user', { user_id: user.id })
      setConfirmId(null)
      await loadUsers()
    } catch (err) {
      setRowError(err.message)
      setConfirmId(null)
    } finally {
      setRowBusyId(null)
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

      <section className="add-user-section">
        <h2 className="settings-heading">Add User</h2>
        {addedEmail && <p className="users-success">✓ Added {addedEmail}</p>}
        <form className="add-user-form" onSubmit={handleAddUser}>
          <input
            type="email"
            className="pw-input"
            placeholder="Email"
            value={newEmail}
            onChange={e => { setNewEmail(e.target.value); setAddError('') }}
            disabled={adding}
          />
          <input
            type="password"
            className="pw-input"
            placeholder="Password (min 6 characters)"
            value={newPass}
            onChange={e => { setNewPass(e.target.value); setAddError('') }}
            disabled={adding}
          />
          <select
            className="pw-input role-select"
            value={newRole}
            onChange={e => setNewRole(e.target.value)}
            disabled={adding}
          >
            {ROLE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button type="submit" className="btn-primary pw-save" disabled={adding}>
            {adding ? 'Adding…' : 'Add User'}
          </button>
        </form>
        {addError && <p className="pw-error">{addError}</p>}
      </section>

      {rowError && <p className="form-error">{rowError}</p>}

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
            ) : confirmId === user.id ? (
              <div className="confirm-delete">
                <span className="confirm-text">
                  Are you sure you want to delete this user?
                </span>
                <div className="pw-actions">
                  <button
                    className="btn-danger"
                    onClick={() => handleDelete(user)}
                    disabled={rowBusyId === user.id}
                  >
                    {rowBusyId === user.id ? 'Deleting…' : 'Confirm'}
                  </button>
                  <button
                    className="btn-cancel"
                    onClick={() => setConfirmId(null)}
                    disabled={rowBusyId === user.id}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="user-actions">
                <select
                  className="pw-input role-select"
                  value={ROLE_OPTIONS.some(o => o.value === user.role) ? user.role : ''}
                  onChange={e => handleRoleChange(user, e.target.value)}
                  disabled={rowBusyId === user.id}
                >
                  {/* Placeholder only shows if the stored role is unrecognised */}
                  {!ROLE_OPTIONS.some(o => o.value === user.role) && (
                    <option value="" disabled>No role</option>
                  )}
                  {ROLE_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <button
                  className="btn-change-pw"
                  onClick={() => openForm(user.id)}
                  disabled={rowBusyId === user.id}
                >
                  Change Password
                </button>
                <button
                  className="btn-delete"
                  onClick={() => { setRowError(''); setConfirmId(user.id) }}
                  disabled={rowBusyId === user.id}
                >
                  Delete
                </button>
              </div>
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
