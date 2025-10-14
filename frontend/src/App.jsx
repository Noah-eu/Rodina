import React, { useEffect, useState, useRef } from 'react'
import { db, ensureAuth, storage } from './firebase'
import { collection, doc, getDoc, getDocs, query, where, setDoc, updateDoc, startAfter, limit } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import bcrypt from 'bcryptjs'
import { onSnapshot, orderBy, addDoc, serverTimestamp } from 'firebase/firestore'

// Komponenta pro zobrazení jednoho uživatele v seznamu
function UserListItem({ user, isSelected, onSelect, unread = 0 }) {
  return (
    <li className={(user.online ? 'online ' : '') + (isSelected ? 'selected' : '')} onClick={() => onSelect(user)}>
      <img src={user.avatar || '/assets/default-avatar.png'} alt="avatar" />
      <div>
        <div className="name">{user.name}</div>
        <div className="last">{user.online ? 'Online' : 'Offline'}</div>
      </div>
      {unread > 0 && (
        <span style={{marginLeft:'auto',background:'#6366f1',color:'#fff',fontSize:'12px',minWidth:24,height:24,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:12,fontWeight:600}}>{unread}</span>
      )}
    </li>
  )
}

// Komponenta pro chat mezi uživateli
function ChatWindow({ user, selectedUser }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [imageFile, setImageFile] = useState(null)
  const [imagePreview, setImagePreview] = useState(null)
  const [sending, setSending] = useState(false)
  const messagesEndRef = useRef(null)
  const messagesContainerRef = useRef(null)
  const firstBatchLoadedRef = useRef(false)
  const earliestDocRef = useRef(null)
  const loadingMoreRef = useRef(false)

  // Vytvoření unikátního ID místnosti pro dvojici uživatelů (nezávislé na pořadí)
  const roomId = [user.id, selectedUser.id].sort().join('_')

  useEffect(() => {
  const msgsCol = collection(db, 'chats', roomId, 'messages')
  const qMsgs = query(msgsCol, orderBy('createdAt'))
    const unsub = onSnapshot(qMsgs, snap => {
      const list = snap.docs.map(d => d.data())
      setMessages(list)
      if (!firstBatchLoadedRef.current && list.length) firstBatchLoadedRef.current = true
      if (list.length) {
        const latest = list[list.length - 1]
        const ts = latest.createdAt?.toMillis?.() || Date.now()
        const readDocRef = doc(db, 'chats', roomId, 'reads', user.id)
        setDoc(readDocRef, { lastRead: ts }, { merge: true }).catch(()=>{})
      }
      // Ulož nejstarší doc pro pagination
      earliestDocRef.current = snap.docs[0] || null
    })
    return () => unsub()
  }, [roomId, user.id])

  // Lazy load na scroll top
  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const handler = async () => {
      if (el.scrollTop > 0) return
      if (loadingMoreRef.current) return
      if (!earliestDocRef.current) return
      loadingMoreRef.current = true
      try {
        const msgsCol = collection(db, 'chats', roomId, 'messages')
        const qMore = query(msgsCol, orderBy('createdAt'), startAfter(earliestDocRef.current), limit(30))
        const snapMore = await getDocs(qMore)
        if (!snapMore.empty) {
          const older = snapMore.docs.map(d => d.data())
          // Prepend starší zprávy
          setMessages(prev => [...older, ...prev])
          earliestDocRef.current = snapMore.docs[0]
          // Zachovat pozici scrollu aby neodskočilo
          const prevHeight = el.scrollHeight
          requestAnimationFrame(() => {
            const newHeight = el.scrollHeight
            el.scrollTop = newHeight - prevHeight
          })
        }
      } catch (e) {
        console.warn('Lazy load failed', e)
      } finally {
        loadingMoreRef.current = false
      }
    }
    el.addEventListener('scroll', handler)
    return () => el.removeEventListener('scroll', handler)
  }, [roomId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendMessage(e) {
    e.preventDefault()
    if (sending) return
    if (!input.trim() && !imageFile) return
    setSending(true)
    let imageUrl = null
    try {
      if (imageFile) {
        const imgRef = ref(storage, `chatImages/${roomId}/${Date.now()}_${imageFile.name}`)
        const snap = await uploadBytes(imgRef, imageFile)
        imageUrl = await getDownloadURL(snap.ref)
      }
      const msgsCol = collection(db, 'chats', roomId, 'messages')
      await addDoc(msgsCol, {
        text: input.trim() || '',
        imageUrl: imageUrl || null,
        from: user.id,
        to: selectedUser.id,
        createdAt: serverTimestamp(),
        name: user.name,
        avatar: user.avatar || null
      })
      setInput('')
      setImageFile(null)
      setImagePreview(null)
    } catch (err) {
      console.error('Send failed:', err)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="chat-window">
  <div className="messages" ref={messagesContainerRef}>
        {messages.map((msg, i) => (
          <div key={i} className={msg.from === user.id ? 'message own' : 'message'}>
            <img src={msg.avatar || '/assets/default-avatar.png'} alt="avatar" />
            <div>
              <div className="msg-name">{msg.name}</div>
              {msg.imageUrl && (
                <div style={{marginBottom: msg.text ? '6px' : '0'}}>
                  <img src={msg.imageUrl} alt="obrázek" style={{maxWidth:'220px',borderRadius:'12px',display:'block',border:'1px solid #344250'}} />
                </div>
              )}
              {msg.text && <div className="msg-text">{msg.text}</div>}
              <div className="msg-time">{msg.createdAt?.toDate ? msg.createdAt.toDate().toLocaleTimeString() : ''}</div>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <form className="send-form" onSubmit={sendMessage}>
        {imagePreview && (
          <div style={{display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
            <img src={imagePreview} alt="preview" style={{maxWidth:120,borderRadius:12,border:'1px solid #344250'}} />
            <button type="button" onClick={() => {setImageFile(null); setImagePreview(null)}} style={{background:'#dc2626',border:'none',color:'#fff',padding:'8px 12px',borderRadius:10,cursor:'pointer'}}>Zrušit obrázek</button>
          </div>
        )}
        <input value={input} onChange={e => setInput(e.target.value)} placeholder="Napište zprávu..." autoFocus />
        <input id="chat-image-input" style={{display:'none'}} type="file" accept="image/*" onChange={e => {
          const f = e.target.files?.[0]
          if (f) {
            setImageFile(f)
            const reader = new FileReader()
            reader.onload = ev => setImagePreview(ev.target.result)
            reader.readAsDataURL(f)
          }
        }} />
        <button type="button" onClick={() => document.getElementById('chat-image-input').click()} style={{background:'#2a3442',border:'1px solid #344250',color:'#e6edf3',width:48,height:48,borderRadius:14,cursor:'pointer',fontSize:'22px',display:'flex',alignItems:'center',justifyContent:'center'}} title="Připojit obrázek">📎</button>
        <button type="submit" disabled={sending} style={{minWidth:110}}>{sending ? 'Odesílám…' : 'Odeslat'}</button>
      </form>
    </div>
  )
}

// Hlavní komponenta aplikace
export default function App() {
  const [user, setUser] = useState(null)
  const [users, setUsers] = useState([])
  const [selectedUser, setSelectedUser] = useState(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [unreadMap, setUnreadMap] = useState({})

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

  // Načítání seznamu ostatních uživatelů + unread listeners
  useEffect(() => {
    if (!user) return
    let unsubList = []
    const fetchUsers = async () => {
      await ensureAuth
      const usersCol = collection(db, 'users')
      const qUsers = query(usersCol, where('id', '!=', user.id))
      const snap = await getDocs(qUsers)
      const userList = snap.docs.map(d => d.data())
      setUsers(userList)

      // Zrušíme předchozí listenery
      unsubList.forEach(fn => fn())
      unsubList = []

      userList.forEach(u => {
        const roomId = [user.id, u.id].sort().join('_')
        const readDocRef = doc(db, 'chats', roomId, 'reads', user.id)
        const unsub = onSnapshot(readDocRef, async readSnap => {
          const lastRead = readSnap.exists() ? readSnap.data().lastRead : 0
          // Načteme zprávy (zatím bez optimalizace – lze zrychlit limit/where)
          const msgsCol = collection(db, 'chats', roomId, 'messages')
          const qMsgs = query(msgsCol, orderBy('createdAt', 'desc'))
          const msgSnap = await getDocs(qMsgs)
          let count = 0
          msgSnap.forEach(m => {
            const created = m.data().createdAt?.toMillis?.() || 0
            if (created > lastRead && m.data().from !== user.id) count++
          })
          setUnreadMap(prev => ({ ...prev, [u.id]: count }))
        })
        unsubList.push(unsub)

        // Notifikační listener na poslední zprávu (lehké – bere všechny zprávy; lze optimalizovat limit(1) desc)
        const msgsCol = collection(db, 'chats', roomId, 'messages')
        const unsubMsg = onSnapshot(query(msgsCol, orderBy('createdAt', 'desc'), limit(1)), snap => {
          if (!snap.empty) {
            const d = snap.docs[0].data()
            if (d.from !== user.id && (!selectedUser || selectedUser.id !== u.id)) {
              // Neaktivní room – pokus o notifikaci
              if (Notification && Notification.permission === 'granted') {
                try {
                  new Notification(`${d.name}: ${d.text || '🖼 Obrázek'}`, { body: 'Nová zpráva', icon: d.avatar || '/assets/default-avatar.png' })
                  // Zvuková odezva
                  try {
                    const ctx = new (window.AudioContext || window.webkitAudioContext)()
                    const o = ctx.createOscillator(); const g = ctx.createGain();
                    o.type='sine'; o.frequency.value=880; o.connect(g); g.connect(ctx.destination);
                    g.gain.setValueAtTime(0.001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
                    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
                    o.start(); o.stop(ctx.currentTime + 0.25)
                  } catch(e) { /* ignore audio errors */ }
                } catch(e) { /* ignore */ }
              }
            }
          }
        })
        unsubList.push(unsubMsg)
      })
    }
    fetchUsers().catch(console.error)
    const interval = setInterval(fetchUsers, 20000)
    return () => {
      clearInterval(interval)
      unsubList.forEach(fn => fn())
    }
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
              unread={unreadMap[u.id] || 0}
            />
          ))}
        </ul>
      </aside>
      <main className="chat">
        {selectedUser ? (
          <div style={{display:'flex',flexDirection:'column',height:'100%'}}>
            <div style={{display:'flex',alignItems:'center',gap:'12px',padding:'12px 16px',borderBottom:'1px solid #2d3748',background:'rgba(0,0,0,.15)'}}>
              <button aria-label="Zpět" onClick={() => setSelectedUser(null)} style={{background:'#1f2530',border:'1px solid #2d3748',color:'#e6edf3',width:44,height:44,borderRadius:12,cursor:'pointer',fontSize:'20px',display:'flex',alignItems:'center',justifyContent:'center'}}>
                ←
              </button>
              <div style={{display:'flex',alignItems:'center',gap:'12px'}}>
                <img src={selectedUser.avatar || '/assets/default-avatar.png'} alt={selectedUser.name} style={{width:48,height:48,borderRadius:14,objectFit:'cover',border:'1px solid #3d4b5c'}} />
                <div style={{display:'flex',flexDirection:'column'}}>
                  <strong style={{fontSize:'16px'}}>{selectedUser.name}</strong>
                  <span style={{fontSize:'12px',color:'#9ca3af'}}>{selectedUser.online ? 'Online' : 'Offline'}</span>
                </div>
              </div>
            </div>
            <ChatWindow user={user} selectedUser={selectedUser} />
          </div>
        ) : (
          <div className="empty-state">
            Vyberte uživatele ze seznamu pro zahájení konverzace.
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