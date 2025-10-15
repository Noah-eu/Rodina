import React, { useEffect, useState, useRef, useMemo } from 'react'
import { db, ensureAuth, storage } from './firebase'
import { collection, doc, getDoc, getDocs, query, where, setDoc, updateDoc, startAfter, limit } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import bcrypt from 'bcryptjs'
import { onSnapshot, orderBy, addDoc, serverTimestamp } from 'firebase/firestore'
import { initPush } from './push'

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

// Jednoduchý přehrávač hlasové zprávy ve stylu "kliknu a hraju"
function VoiceMessage({ src, own = false }) {
  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [current, setCurrent] = useState(0)

  // Pseudo-waveform segmenty (stabilní podle src)
  const bars = useMemo(() => {
    const N = 40
    // jednoduchý seed ze src
    let seed = 0
    try { for (let i = 0; i < Math.min(64, src.length); i++) seed = (seed * 31 + src.charCodeAt(i)) >>> 0 } catch {}
    const arr = []
    for (let i = 0; i < N; i++) {
      const t = i / N
      const v = Math.abs(Math.sin((i + seed % 17) * 0.6) * 0.6 + Math.sin((i + seed % 13) * 1.3) * 0.3)
      const h = 6 + Math.round(v * 22) // 6..28 px (viz CSS height:28px)
      arr.push(h)
    }
    return arr
  }, [src])

  const fmt = (sec) => {
    const s = Math.floor(sec || 0)
    const m = Math.floor(s / 60)
    const r = s % 60
    return `${String(m).padStart(1,'0')}:${String(r).padStart(2,'0')}`
  }

  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    const onLoaded = () => setDuration(a.duration || 0)
    const onTime = () => {
      setCurrent(a.currentTime || 0)
      setProgress(a.duration ? (a.currentTime / a.duration) * 100 : 0)
    }
    const onEnded = () => { setPlaying(false); setProgress(0); setCurrent(0) }
    a.addEventListener('loadedmetadata', onLoaded)
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('ended', onEnded)
    return () => {
      a.removeEventListener('loadedmetadata', onLoaded)
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('ended', onEnded)
    }
  }, [])

  // Zastaví ostatní přehrávače v rámci stránky
  useEffect(() => {
    const handler = (ev) => {
      if (ev.detail && ev.detail !== audioRef.current) {
        // jiný přehrávač se spustil => pauza
        if (!audioRef.current.paused) {
          audioRef.current.pause()
          setPlaying(false)
        }
      }
    }
    window.addEventListener('rodina:voice:play', handler)
    return () => window.removeEventListener('rodina:voice:play', handler)
  }, [])

  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) {
      window.dispatchEvent(new CustomEvent('rodina:voice:play', { detail: a }))
      a.play().then(() => setPlaying(true)).catch(() => {})
    } else {
      a.pause()
      setPlaying(false)
    }
  }

  const seek = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
    const ratio = rect.width ? x / rect.width : 0
    const a = audioRef.current
    if (a && a.duration) {
      a.currentTime = a.duration * ratio
    }
  }

  return (
    <div className={"voice" + (own ? " own" : "")}> 
      <button type="button" className={"voice-btn" + (playing ? " playing" : "")} onClick={toggle} aria-label={playing ? 'Pozastavit' : 'Přehrát'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="voice-wave" onClick={seek} role="progressbar" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={current}>
        <div className="voice-bars" aria-hidden="true">
          {bars.map((h, i) => (<span key={i} style={{height: h}} />))}
        </div>
        <div className="voice-bars voice-bars--active" style={{ width: `${progress}%` }} aria-hidden="true">
          {bars.map((h, i) => (<span key={i} style={{height: h}} />))}
        </div>
      </div>
      <div className="voice-time">{fmt(current)} / {fmt(duration)}</div>
      <audio ref={audioRef} src={src} preload="metadata" />
    </div>
  )
}

// Komponenta pro chat mezi uživateli
function ChatWindow({ user, selectedUser }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [imageFile, setImageFile] = useState(null)
  const [imagePreview, setImagePreview] = useState(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [lightboxUrl, setLightboxUrl] = useState(null)
  // Hlasové zprávy
  const [recording, setRecording] = useState(false)
  const mediaRecorderRef = useRef(null)
  const streamRef = useRef(null)
  const [audioBlob, setAudioBlob] = useState(null)
  const [audioPreviewUrl, setAudioPreviewUrl] = useState(null)
  const [recordingMs, setRecordingMs] = useState(0)
  const recordingTimerRef = useRef(null)
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

  // Zavření náhledu ESC
  useEffect(() => {
    if (!lightboxUrl) return
    const onKey = (e) => { if (e.key === 'Escape') setLightboxUrl(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightboxUrl])

  // --- Hlasové zprávy ---
  function formatMs(ms) {
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    const r = s % 60
    return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`
  }

  async function startRecording() {
    try {
      if (imageFile) { setImageFile(null); setImagePreview(null) }
      if (audioPreviewUrl) { URL.revokeObjectURL(audioPreviewUrl); setAudioPreviewUrl(null) }
      setAudioBlob(null)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) ? 'audio/webm;codecs=opus' : undefined
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      const chunks = []
      mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data) }
      mr.onstop = () => {
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' })
        const url = URL.createObjectURL(blob)
        setAudioBlob(blob)
        setAudioPreviewUrl(url)
        setRecording(false)
        stream.getTracks().forEach(t => t.stop())
        streamRef.current = null
        if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null }
      }
      mr.start()
      mediaRecorderRef.current = mr
      setRecording(true)
      setRecordingMs(0)
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
      recordingTimerRef.current = setInterval(() => setRecordingMs(prev => prev + 1000), 1000)
    } catch (err) {
      console.error('Mic error', err)
      alert('Nelze spustit mikrofon: ' + (err.message || err.name))
    }
  }

  function stopRecording() {
    try { mediaRecorderRef.current?.stop() } catch {}
  }

  function cancelAudio() {
    try { if (recording) stopRecording() } catch {}
    if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl)
    setAudioPreviewUrl(null)
    setAudioBlob(null)
    setRecording(false)
    setRecordingMs(0)
  }

  async function sendMessage(e) {
    e.preventDefault()
    if (sending) return
    if (!input.trim() && !imageFile && !audioBlob) return
    setSendError('')
    setSending(true)
    let imageUrl = null
    let audioUrl = null
    try {
      if (imageFile) {
        const imgRef = ref(storage, `chatImages/${roomId}/${Date.now()}_${imageFile.name}`)
        const snap = await uploadBytes(imgRef, imageFile, {
          contentType: imageFile.type || 'application/octet-stream',
          cacheControl: 'public, max-age=31536000, immutable'
        })
        imageUrl = await getDownloadURL(snap.ref)
      }
      if (audioBlob) {
        const filename = `voice_${Date.now()}.webm`
        const aRef = ref(storage, `chatAudio/${roomId}/${filename}`)
        const snapA = await uploadBytes(aRef, audioBlob, {
          contentType: audioBlob.type || 'audio/webm',
          cacheControl: 'public, max-age=31536000, immutable'
        })
        audioUrl = await getDownloadURL(snapA.ref)
      }
      const msgsCol = collection(db, 'chats', roomId, 'messages')
      await addDoc(msgsCol, {
        text: input.trim() || '',
        imageUrl: imageUrl || null,
        audioUrl: audioUrl || null,
        from: user.id,
        to: selectedUser.id,
        createdAt: serverTimestamp(),
        name: user.name,
        avatar: user.avatar || null
      })
      // Fire-and-forget push notify via backend (if configured for dev or via Netlify proxy in prod)
      try {
        const apiBase = import.meta.env.PROD ? '/.netlify/functions/proxy' : (import.meta.env.VITE_API_URL || 'http://localhost:3001')
        const textPreview = (input || '').trim()
        const body = textPreview || (imageUrl ? 'Poslal(a) fotku' : (audioUrl ? 'Poslal(a) hlasovou zprávu' : 'Nová zpráva'))
        fetch(`${apiBase}/api/push/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: `${user.name}`, body, to: selectedUser.id })
        }).catch(()=>{})
      } catch (_) {}
      setInput('')
      setImageFile(null)
      setImagePreview(null)
      if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl)
      setAudioPreviewUrl(null)
      setAudioBlob(null)
      setRecordingMs(0)
    } catch (err) {
      console.error('Send failed:', err)
      setSendError('Nepodařilo se odeslat zprávu. Zkuste to znovu.')
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
                <div className="msg-image" style={{marginBottom: msg.text ? '6px' : '0'}}>
                  <img src={msg.imageUrl} alt="obrázek" onClick={() => setLightboxUrl(msg.imageUrl)} />
                </div>
              )}
              {msg.audioUrl && (
                <div className="msg-audio" style={{marginBottom: (msg.text || msg.imageUrl) ? '6px' : '0'}}>
                  <VoiceMessage src={msg.audioUrl} own={msg.from === user.id} />
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
        {audioPreviewUrl && (
          <div className="preview-strip" style={{display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
            <audio controls src={audioPreviewUrl} />
            <button type="button" className="btn danger" onClick={cancelAudio}>Zrušit hlasovku</button>
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
        {!recording && (
          <button type="button" onClick={startRecording} style={{background:'#2a3442',border:'1px solid #344250',color:'#e6edf3',width:48,height:48,borderRadius:14,cursor:'pointer',fontSize:'20px',display:'flex',alignItems:'center',justifyContent:'center'}} title="Nahrát hlasovou zprávu">🎤</button>
        )}
        {recording && (
          <button type="button" onClick={stopRecording} style={{background:'#b91c1c',border:'1px solid #7f1d1d',color:'#fff',minWidth:120,height:48,borderRadius:14,cursor:'pointer',fontSize:'15px',display:'flex',alignItems:'center',justifyContent:'center',gap:8}} title="Zastavit nahrávání">⏺ Nahrávám {formatMs(recordingMs)}</button>
        )}
        <button type="submit" aria-label="Odeslat" className="send-icon-btn" disabled={sending || (!input.trim() && !imageFile && !audioBlob)}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path>
          </svg>
        </button>
  {sendError && <div style={{color:'#dc2626',marginTop:8,fontSize:14}}>{sendError}</div>}
      </form>
      {lightboxUrl && (
        <div className="lightbox" onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="náhled" onClick={(e) => e.stopPropagation()} />
          <button className="lightbox-close" onClick={() => setLightboxUrl(null)} aria-label="Zavřít">×</button>
        </div>
      )}
    </div>
  )
}

// Hlavní komponenta aplikace
export default function App() {
  const [user, setUser] = useState(null)
  const [users, setUsers] = useState([])
  const [selectedUser, setSelectedUser] = useState(null)
  const selectedUserRef = useRef(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [unreadMap, setUnreadMap] = useState({})
  // Audio notifikace – odemčení a sdílený kontext
  const audioCtxRef = useRef(null)
  const [audioReady, setAudioReady] = useState(false)

  // Po prvním gestu uživatele odemkni AudioContext a případně požádej o notifikační oprávnění
  useEffect(() => {
    const unlock = async () => {
      try {
        if (!audioCtxRef.current) {
          audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()
        }
        if (audioCtxRef.current.state === 'suspended') {
          await audioCtxRef.current.resume()
        }
        setAudioReady(true)
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
          try { await Notification.requestPermission() } catch {}
        }
      } catch {}
    }
    const once = () => { unlock(); window.removeEventListener('pointerdown', once); window.removeEventListener('keydown', once); window.removeEventListener('touchstart', once) }
    window.addEventListener('pointerdown', once)
    window.addEventListener('keydown', once)
    window.addEventListener('touchstart', once)
    return () => {
      window.removeEventListener('pointerdown', once)
      window.removeEventListener('keydown', once)
      window.removeEventListener('touchstart', once)
    }
  }, [])

  const playBeep = () => {
    try {
      const ctx = audioCtxRef.current
      if (!ctx) return
      const o = ctx.createOscillator(); const g = ctx.createGain()
      o.type = 'sine'; o.frequency.value = 880
      o.connect(g); g.connect(ctx.destination)
      const t = ctx.currentTime
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25)
      o.start(t); o.stop(t + 0.25)
    } catch {}
  }

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
            const activeSel = selectedUserRef.current
            if (d.from !== user.id && (!activeSel || activeSel.id !== u.id)) {
              // Neaktivní room – pokus o notifikaci
              if (Notification && Notification.permission === 'granted') {
                try {
                  new Notification(`${d.name}: ${d.text || '🖼 Obrázek'}`, { body: 'Nová zpráva', icon: d.avatar || '/assets/default-avatar.png' })
                  // Zvuková a haptická odezva (pokud je odemčený audio kontext)
                  if (audioReady) playBeep()
                  try { navigator.vibrate && navigator.vibrate([40, 30, 40]) } catch {}
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

  // Udržuj referenci na aktuálně vybraného uživatele pro notifikační callbacky
  useEffect(() => { selectedUserRef.current = selectedUser }, [selectedUser])


  const handleAuth = (authedUser) => {
    localStorage.setItem('rodina:user', JSON.stringify(authedUser))
    setUser(authedUser)
    // Po přihlášení znovu zaregistruj push se svým userId
    try {
      if ('serviceWorker' in navigator) {
        const apiBase = import.meta.env.PROD ? '/.netlify/functions/proxy' : (import.meta.env.VITE_API_URL || 'http://localhost:3001')
        navigator.serviceWorker.ready.then(reg => initPush(reg, apiBase, authedUser.id)).catch(()=>{})
      }
    } catch (_) {}
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
    <div className={"app" + (selectedUser ? " chat-open" : "")}>
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
      const snapshot = await uploadBytes(storageRef, avatarFile, {
        contentType: avatarFile.type || 'application/octet-stream',
        cacheControl: 'public, max-age=31536000, immutable'
      })
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
        const snapshot = await uploadBytes(storageRef, avatarFile, {
          contentType: avatarFile.type || 'application/octet-stream',
          cacheControl: 'public, max-age=31536000, immutable'
        })
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