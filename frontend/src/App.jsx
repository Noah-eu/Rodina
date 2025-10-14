import React, { useEffect, useState } from 'react'
import { db, ensureAuth } from './firebase'
import { collection, doc, getDoc, getDocs, query, where, setDoc } from 'firebase/firestore'
import bcrypt from 'bcryptjs'

export default function App() {
  const [user, setUser] = useState(null)

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

  const handleAuth = (authedUser) => {
    localStorage.setItem('rodina:user', JSON.stringify(authedUser))
    setUser(authedUser)
  }

  const handleLogout = () => {
    localStorage.removeItem('rodina:user')
    localStorage.removeItem('rodina:lastUserId')
    localStorage.removeItem('rodina:lastName')
    setUser(null)
  }

  if (!user) return <Auth onAuth={handleAuth} />

  return (
    <div className="app">
      <main className="chat">
        <h1>Vítejte, {user.name}!</h1>
        <p>Přihlášení přes Firebase funguje.</p>
        <button onClick={handleLogout}>Odhlásit se</button>
      </main>
    </div>
  )
}

function Auth({ onAuth }) {
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [stage, setStage] = useState('choose')

  useEffect(() => {
    const lastName = localStorage.getItem('rodina:lastName') || ''
    const lastStage = localStorage.getItem('rodina:lastStage') || 'choose'
    setName(lastName)
    setStage(lastStage)
  }, [])

  async function register(e) {
    e.preventDefault()
    if (!name || !pin) return alert('Vyplňte jméno a PIN')
    await ensureAuth
    const usersCol = collection(db, 'users')
    const q = query(usersCol, where('nameNorm', '==', String(name).trim().toLowerCase()))
    const snap = await getDocs(q)
    if (!snap.empty) {
      alert('Uživatel již existuje')
      return
    }
    const id = crypto.randomUUID()
    const salt = bcrypt.genSaltSync(10)
    const pinHash = bcrypt.hashSync(pin, salt)
    const userDoc = doc(db, 'users', id)
    const newUser = { id, name, nameNorm: String(name).trim().toLowerCase(), pinHash, avatar: null, createdAt: Date.now() }
    await setDoc(userDoc, newUser)
    localStorage.setItem('rodina:lastName', name)
    localStorage.setItem('rodina:lastUserId', id)
    localStorage.setItem('rodina:lastStage', 'pin')
    onAuth({ id, name, avatar: null })
  }

  async function login(e) {
    e.preventDefault()
    if (!pin || (!name && !localStorage.getItem('rodina:lastUserId'))) return alert('Vyplňte PIN a případně jméno')
    await ensureAuth
    
    let userData = null
    const lastUserId = localStorage.getItem('rodina:lastUserId')

    if (stage === 'pin' && lastUserId) {
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
      alert('Uživatel nenalezen')
      return
    }
    const ok = bcrypt.compareSync(pin, userData.pinHash)
    if (!ok) {
      alert('Chybný PIN')
      return
    }
    localStorage.setItem('rodina:lastName', userData.name)
    localStorage.setItem('rodina:lastUserId', userData.id)
    localStorage.setItem('rodina:lastStage', 'pin')
    onAuth({ id: userData.id, name: userData.name, avatar: userData.avatar || null })
  }

  if (stage === 'login' || stage === 'pin') {
    const needName = stage === 'pin' && !localStorage.getItem('rodina:lastUserId')
    return (
      <div className="auth">
        <h2>Přihlášení</h2>
        <form onSubmit={login}>
          {(stage !== 'pin' || needName) && (
            <input placeholder="Jméno" value={name} onChange={e => setName(e.target.value)} />
          )}
          <input placeholder="4-místný PIN" type="password" value={pin} onChange={e => setPin(e.target.value)} />
          <button className="btn primary" type="submit">Přihlásit</button>
        </form>
        <p><button onClick={() => setStage('choose')}>Založit nový profil</button></p>
      </div>
    )
  }

  return (
    <div className="auth">
      <h2>Vítejte v Rodině</h2>
      <form onSubmit={register}>
        <input placeholder="Jméno" value={name} onChange={e => setName(e.target.value)} />
        <input placeholder="4-místný PIN" type="password" value={pin} onChange={e => setPin(e.target.value)} />
        <button className="btn primary" type="submit">Vytvořit profil</button>
      </form>
      <p>Máte už profil? <button className="btn secondary" onClick={() => setStage('login')}>Přihlásit se</button> <button className="btn secondary" onClick={() => setStage('pin')}>Jen PIN</button></p>
    </div>
  )
}