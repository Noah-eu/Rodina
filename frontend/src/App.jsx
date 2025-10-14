import React, { useEffect, useState, useRef } from 'react'
import { db, ensureAuth, storage } from './firebase'
import { collection, doc, getDoc, getDocs, query, where, setDoc, updateDoc } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import bcrypt from 'bcryptjs'

// Komponenta pro zobrazení jednoho uživatele v seznamu
function UserListItem({ user, isSelected, onSelect }) {
  return (
    <li className={(user.online ? 'online ' : '') + (isSelected ? 'selected' : '')} onClick={() => onSelect(user)}>
      <img src={user.avatar || '/assets/default-avatar.png'} alt="avatar" />
      <div>
        <div className="name">{user.name}</div>
        <div className="last">{user.online ? 'Online' : 'Offline'}</div>
      </div>
    </li>
  )
}

// Hlavní komponenta aplikace
export default function App() {
  const [user, setUser] = useState(null)
  const [users, setUsers] = useState([])
  const [selectedUser, setSelectedUser] = useState(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)

  // Načtení uživatele z localStorage při startu
  useEffect(() => {
    const storedUser = localStorage.getItem('rodina:user')
    if (storedUser) {
      try {
        setUser(JSON.parse(storedUser))
      } catch (e) {
        localStorage.removeItem('rodina:user')
      }
    }
  }, [])

  // Načítání seznamu ostatních uživatelů
  useEffect(() => {
    if (!user) return
    const fetchUsers = async () => {
      await ensureAuth
      const usersCol = collection(db, 'users')
      const q = query(usersCol, where('id', '!=', user.id))
      const snap = await getDocs(q)
      const userList = snap.docs.map(d => d.data())
      setUsers(userList)
    }
    fetchUsers().catch(console.error)
    const interval = setInterval(fetchUsers, 15000) // Aktualizace každých 15s
    return () => clearInterval(interval)
  }, [user])


  const handleAuth = (authedUser) => {
    localStorage.setItem('rodina:user', JSON.stringify(authedUser))
    setUser(authedUser)
  }

  const handleLogout = () => {
    localStorage.removeItem('rodina:user')
    localStorage.removeItem('rodina:lastUserId')
    localStorage.removeItem('rodina:lastName')
    setUser(null)
    setSelectedUser(null)
  }

  if (!user) return <Auth onAuth={handleAuth} />

  return (
    <div className="app">
      {isSettingsOpen && <SettingsModal user={user} onAuth={handleAuth} onClose={() => setIsSettingsOpen(false)} />}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>Rodina</h2>
          <button className="settings-btn" onClick={() => setIsSettingsOpen(true)}>⚙️</button>
        </div>
        <button onClick={handleLogout}>Odhlásit se</button>
        <ul>
          {users.map(u => (
            <UserListItem
              key={u.id}
              user={u}
              isSelected={selectedUser?.id === u.id}
              onSelect={setSelectedUser}
            />
          ))}
        </ul>
      </aside>
      <main className="chat">
        {selectedUser ? (
          <div style={{ padding: '20px' }}>
            <h2>Chat s {selectedUser.name}</h2>
            <p>Tady bude chatovací okno (zatím není implementováno).</p>
          </div>
        ) : (
          <div style={{ textAlign: 'center', marginTop: '40px', opacity: 0.7 }}>
            Vyberte uživatele ze seznamu vlevo pro zahájení konverzace.
          </div>
        )}
      </main>
    </div>
  )
}

function SettingsModal({ user, onAuth, onClose }) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [avatarFile, setAvatarFile] = useState(null)
  const [feedback, setFeedback] = useState('')

  async function handleAvatarChange(e) {
    e.preventDefault()
    if (!avatarFile) {
      setFeedback('Nejprve vyberte soubor.')
      return
    }
    setIsSubmitting(true)
    setFeedback('Nahrávám fotku...')

    try {
      await ensureAuth
      const storageRef = ref(storage, `avatars/${user.id}/${avatarFile.name}`)
      const snapshot = await uploadBytes(storageRef, avatarFile)
      const avatarUrl = await getDownloadURL(snapshot.ref)

      const userDocRef = doc(db, 'users', user.id)
      await updateDoc(userDocRef, { avatar: avatarUrl })

      const updatedUser = { ...user, avatar: avatarUrl }
      onAuth(updatedUser) // Aktualizuje stav v App a localStorage

      setFeedback('Profilová fotka byla úspěšně změněna!')
      setTimeout(() => {
        onClose()
      }, 1500)

    } catch (error) {
      console.error("Avatar upload failed:", error)
      setFeedback('Nahrávání se nezdařilo: ' + error.message)
      setIsSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Nastavení</h2>
        <form onSubmit={handleAvatarChange}>
          <label>Změnit profilovou fotku:</label>
          <img src={user.avatar || '/assets/default-avatar.png'} alt="Current Avatar" className="avatar-preview" />
          <input type="file" accept="image/*" onChange={e => setAvatarFile(e.target.files[0])} />
          <button type="submit" disabled={isSubmitting || !avatarFile}>
            {isSubmitting ? 'Ukládám...' : 'Uložit změny'}
          </button>
          {feedback && <p className="feedback">{feedback}</p>}
        </form>
        <button className="close-btn" onClick={onClose}>Zavřít</button>
      </div>
    </div>
  )
}

// Komponenta pro přihlášení a registraci
function Auth({ onAuth }) {
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [stage, setStage] = useState('choose')
  const [avatarFile, setAvatarFile] = useState(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    const lastName = localStorage.getItem('rodina:lastName') || ''
    const lastStage = localStorage.getItem('rodina:lastStage') || 'choose'
    setName(lastName)
    setStage(lastStage)
  }, [])

  async function register(e) {
    e.preventDefault()
    if (!name || !pin) return alert('Vyplňte jméno a PIN')
    setIsSubmitting(true)

    try {
      await ensureAuth
      const usersCol = collection(db, 'users')
      const q = query(usersCol, where('nameNorm', '==', String(name).trim().toLowerCase()))
      const snap = await getDocs(q)
      if (!snap.empty) {
        alert('Uživatel s tímto jménem již existuje.')
        setIsSubmitting(false)
        return
      }

      const id = crypto.randomUUID()
      const salt = bcrypt.genSaltSync(10)
      const pinHash = bcrypt.hashSync(pin, salt)
      
      let avatarUrl = null
      if (avatarFile) {
        const storageRef = ref(storage, `avatars/${id}/${avatarFile.name}`)
        const snapshot = await uploadBytes(storageRef, avatarFile)
        avatarUrl = await getDownloadURL(snapshot.ref)
      }

      const userDocRef = doc(db, 'users', id)
      const newUser = { id, name, nameNorm: String(name).trim().toLowerCase(), pinHash, avatar: avatarUrl, createdAt: Date.now(), online: true }
      await setDoc(userDocRef, newUser)
      
      const authedUser = { id, name, avatar: avatarUrl }
      localStorage.setItem('rodina:lastName', name)
      localStorage.setItem('rodina:lastUserId', id)
      localStorage.setItem('rodina:lastStage', 'pin')
      onAuth(authedUser)

    } catch (error) {
      console.error("Registration failed:", error)
      alert("Registrace se nezdařila: " + error.message)
      setIsSubmitting(false)
    }
  }

  async function login(e) {
    e.preventDefault()
    if (!pin || (!name && !localStorage.getItem('rodina:lastUserId'))) return alert('Vyplňte PIN a případně jméno')
    setIsSubmitting(true)

    try {
      await ensureAuth
      let userData = null
      const lastUserId = localStorage.getItem('rodina:lastUserId')

      if (stage === 'pin' && lastUserId && !name) {
        const d = await getDoc(doc(db, 'users', lastUserId))
        if (d.exists()) userData = d.data()
      } else {
        const usersCol = collection(db, 'users')
        const q = query(usersCol, where('nameNorm', '==', String(name).trim().toLowerCase()))
        const snap = await getDocs(q)
        if (!snap.empty) {
          userData = snap.docs[0].data()
        }
      }

      if (!userData) {
        alert('Uživatel nenalezen.')
        setIsSubmitting(false)
        return
      }

      const ok = bcrypt.compareSync(pin, userData.pinHash)
      if (!ok) {
        alert('Chybný PIN.')
        setIsSubmitting(false)
        return
      }
      
      // Aktualizace stavu online
      const userDocRef = doc(db, 'users', userData.id)
      await updateDoc(userDocRef, { online: true });

      const authedUser = { id: userData.id, name: userData.name, avatar: userData.avatar || null }
      localStorage.setItem('rodina:lastName', userData.name)
      localStorage.setItem('rodina:lastUserId', userData.id)
      localStorage.setItem('rodina:lastStage', 'pin')
      onAuth(authedUser)

    } catch (error) {
      console.error("Login failed:", error)
      alert("Přihlášení se nezdařilo: " + error.message)
      setIsSubmitting(false)
    }
  }

  if (stage === 'login' || stage === 'pin') {
    const needName = stage === 'pin' && !localStorage.getItem('rodina:lastUserId')
    return (
      <div className="auth">
        <h2>Přihlášení</h2>
        <form onSubmit={login}>
          {(stage !== 'pin' || needName) && (
            <input placeholder="Jméno" value={name} onChange={e => setName(e.target.value)} required />
          )}
          <input placeholder="4-místný PIN" type="password" value={pin} onChange={e => setPin(e.target.value)} required />
          <button className="btn primary" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Přihlašuji...' : 'Přihlásit'}</button>
        </form>
        <p><button onClick={() => setStage('choose')}>Založit nový profil</button></p>
      </div>
    )
  }

  return (
    <div className="auth">
      <h2>Vítejte v Rodině</h2>
      <form onSubmit={register}>
        <input placeholder="Jméno" value={name} onChange={e => setName(e.target.value)} required />
        <input placeholder="4-místný PIN" type="password" value={pin} onChange={e => setPin(e.target.value)} required />
        <label>Profilová fotka (volitelné):</label>
        <input type="file" accept="image/*" onChange={e => setAvatarFile(e.target.files[0])} />
        <button className="btn primary" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Vytvářím...' : 'Vytvořit profil'}</button>
      </form>
      <p>Máte už profil? <button className="btn secondary" onClick={() => setStage('login')}>Přihlásit se</button> <button className="btn secondary" onClick={() => setStage('pin')}>Jen PIN</button></p>
    </div>
  )
}