import React, { useEffect, useState, useRef, useMemo } from 'react'
import { db, ensureAuth, storage } from './firebase'
import { collection, doc, getDoc, getDocs, query, where, setDoc, updateDoc, startAfter, limit } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import bcrypt from 'bcryptjs'
import { onSnapshot, orderBy, addDoc, serverTimestamp } from 'firebase/firestore'
import { initPush } from './push'
import Pusher from 'pusher-js'

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
        <span className="unread-badge">{unread}</span>
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
      const player = audioRef.current
      if (!player) return
      if (ev.detail && ev.detail !== player) {
        // jiný přehrávač se spustil => pauza
        if (!player.paused) {
          player.pause()
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
  // Abychom opakovaně nevypisovali foreground notifikace při rebindu listenerů
  const lastNotifiedRef = useRef({}) // { peerUserId: lastMessageId }

  // --- Ukládání příloh do zařízení ---
  async function downloadToDevice(url, suggestedName='soubor'){
    try {
      // Pokud je k dispozici File System Access API (Chrome/Edge/Android), nabídni Uložit jako
      if (window.showSaveFilePicker) {
        const opts = { suggestedName, types: [{ description: 'Soubor', accept: { '*/*': ['.*'] } }] }
        const handle = await window.showSaveFilePicker(opts)
        const writable = await handle.createWritable()
        const res = await fetch(url, { mode: 'cors' })
        if (!res.ok) throw new Error('Stažení selhalo')
        if (res.body && writable.write) {
          // stream copy
          if (writable.write instanceof Function && res.body.getReader) {
            const reader = res.body.getReader()
            while (true) {
              const { value, done } = await reader.read()
              if (done) break
              await writable.write(value)
            }
          } else {
            const blob = await res.blob(); await writable.write(blob)
          }
        }
        await writable.close()
        return
      }
    } catch(_) { /* fallback níže */ }
    try {
      // Firebase Storage: přidej download=filename, aby prohlížeč uložil přímo
      let dlUrl = url
      try {
        const u = new URL(url, window.location.origin)
        if (/firebasestorage\.googleapis\.com/.test(u.hostname)) {
          u.searchParams.set('download', suggestedName)
          dlUrl = u.toString()
        }
      } catch { dlUrl = url }
      const a = document.createElement('a')
      a.href = dlUrl
      a.download = suggestedName
      a.rel = 'noopener'
      a.target = '_blank'
      document.body.appendChild(a)
      a.click()
      setTimeout(()=>{ try{ document.body.removeChild(a) }catch{} }, 0)
    } catch {
      try {
        // Poslední fallback: fetch→blob→ObjectURL
        const res = await fetch(url)
        const blob = await res.blob()
        const obj = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = obj
        a.download = suggestedName
        document.body.appendChild(a)
        a.click()
        setTimeout(()=>{ URL.revokeObjectURL(obj); try{ document.body.removeChild(a) }catch{} }, 0)
      } catch(e) {
        alert('Uložení se nepodařilo: ' + (e.message || e))
      }
    }
  }

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
    // API base is '/api' in PROD (redirected to proxy) and '<DEV_ORIGIN>/api' in DEV (see main.jsx)
    const apiBase = import.meta.env.PROD ? '/api' : ((import.meta.env.VITE_API_URL || 'http://localhost:3001').replace(/\/$/, '') + '/api')
        const textPreview = (input || '').trim()
        const body = textPreview || (imageUrl ? 'Poslal(a) fotku' : (audioUrl ? 'Poslal(a) hlasovou zprávu' : 'Nová zpráva'))
        fetch(`${apiBase}/push/notify`, {
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
                <div className="msg-image" style={{marginBottom: msg.text ? '6px' : '0', position:'relative'}}>
                  <img src={msg.imageUrl} alt="obrázek" onClick={() => setLightboxUrl(msg.imageUrl)} />
                  <button onClick={() => downloadToDevice(msg.imageUrl, `obrazek_${Date.now()}.jpg`)} style={{position:'absolute',right:8,top:8,background:'rgba(0,0,0,0.5)',color:'#fff',padding:'6px 8px',borderRadius:8,border:'none',cursor:'pointer',fontSize:12}} aria-label="Stáhnout obrázek">⬇️ Stáhnout</button>
                </div>
              )}
              {msg.audioUrl && (
                <div className="msg-audio" style={{marginBottom: (msg.text || msg.imageUrl) ? '6px' : '0', display:'flex',alignItems:'center',gap:10}}>
                  <VoiceMessage src={msg.audioUrl} own={msg.from === user.id} />
                  <button onClick={() => downloadToDevice(msg.audioUrl, `hlasovka_${Date.now()}.webm`)} style={{background:'#1f2937',border:'1px solid #374151',color:'#cbd5e1',borderRadius:8,padding:'6px 8px',cursor:'pointer',fontSize:12}} aria-label="Stáhnout zvuk">⬇️ Stáhnout</button>
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
  const usersRef = useRef([])
  const [selectedUser, setSelectedUser] = useState(null)
  const selectedUserRef = useRef(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [unreadMap, setUnreadMap] = useState({})
  // Audio notifikace – odemčení a sdílený kontext
  const audioCtxRef = useRef(null)
  const [audioReady, setAudioReady] = useState(false)
  const ringTimerRef = useRef(null)
  const ringGainRef = useRef(null)
  const ringOscRef = useRef(null)
  const ringVibeTimerRef = useRef(null)
  // Souborový ringtone a nastavení ztlumení
  const ringAudioRef = useRef(null)
  const [ringMuted, setRingMuted] = useState(() => {
    try { return localStorage.getItem('rodina:ringMuted') === '1' } catch { return false }
  })
  const incomingTimeoutRef = useRef(null)
  const clearIncomingTimeout = () => { try { clearTimeout(incomingTimeoutRef.current) } catch{} finally { incomingTimeoutRef.current = null } }

  // --- Hovory (audio/video) ---
  const [callState, setCallState] = useState({
    active: false,
    incoming: false,
    outgoing: false,
    kind: 'audio', // 'audio' | 'video'
    from: null,
    to: null,
    connecting: false,
    remoteName: ''
  })
  const pcRef = useRef(null)
  const localStreamRef = useRef(null)
  const remoteStreamRef = useRef(null)
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const pusherRef = useRef(null)
  const channelRef = useRef(null)
  const peerIdRef = useRef(null)
  const apiBaseRef = useRef(null)
  // Diagnostika
  const [diag, setDiag] = useState({ pusher: 'off', sw: 'off', pushPerm: 'default', pushSub: false, iceCount: 0, apiBase: '' })
  // Aktuální typ hovoru (audio/video) mimo React state, aby se předešlo stale closures
  const callKindRef = useRef('audio')
  // Fronta pro události z SW, než se načte seznam uživatelů
  const pendingCallRef = useRef(null)

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

  // Pokusit se "tiše" obnovit AudioContext při návratu okna do popředí
  useEffect(() => {
    const onVis = async () => {
      try {
        if (document.visibilityState === 'visible' && audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
          await audioCtxRef.current.resume()
          setAudioReady(audioCtxRef.current.state === 'running')
          // pokud probíhá příchozí/odchozí hovor a zatím nezvoní, zkus znovu spustit
          if ((callState.incoming || callState.outgoing) && audioCtxRef.current.state === 'running') {
            startRing()
          }
        }
      } catch {}
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [callState.incoming, callState.outgoing])

  // Když se audio odemkne během příchozího/odchozího hovoru, spustit zvonění
  useEffect(() => {
    if (audioReady && (callState.incoming || callState.outgoing)) {
      startRing()
    }
  }, [audioReady, callState.incoming, callState.outgoing])

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

  // Jednoduchý vyzváněcí tón (foreground only)
  function startRing(){
    try {
      // nepřetržitá vibrace (pattern opakujeme v intervalu)
      try {
        if (navigator.vibrate) {
          navigator.vibrate([250, 200, 250])
          if (ringVibeTimerRef.current) clearInterval(ringVibeTimerRef.current)
          ringVibeTimerRef.current = setInterval(() => { try { navigator.vibrate([250,200,250]) } catch {} }, 2000)
        }
      } catch {}
      // Zkusit probudit AudioContext (pokud to prohlížeč dovolí)
      try { if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume().catch(()=>{}) } catch{}
      // Upřednostni audio soubor, pokud existuje a není ztlumený
      if (!ringMuted) {
        if (!ringAudioRef.current) {
          const a = new Audio('/assets/ringtone.mp3')
          a.loop = true
          a.preload = 'auto'
          ringAudioRef.current = a
        }
        const a = ringAudioRef.current
        // Pokus o přehrání; při blokaci autoplay spadne na oscilátor
        a.currentTime = 0
        a.play().then(() => {
          // Když hraje soubor, neplánuj oscilátor
        }).catch(() => {
          // Fallback na oscilátor
          startOscillatorRing()
        })
      } else {
        // Ztlumeno -> fallback jemný oscilátor, ale velmi potichu nebo vůbec
        startOscillatorRing(0.06)
      }
    } catch {}
  }
  function startOscillatorRing(gainLevel = 0.12){
    try {
      const ctx = audioCtxRef.current
      if (!ctx) return
      stopRing()
      const o = ctx.createOscillator(); const g = ctx.createGain()
      o.type = 'sine'; o.frequency.value = 1200
      g.gain.value = 0
      o.connect(g); g.connect(ctx.destination)
      o.start()
      ringOscRef.current = o
      ringGainRef.current = g
      const tick = () => {
        const t = ctx.currentTime
        g.gain.cancelScheduledValues(t)
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime(gainLevel, t + 0.05)
        g.gain.setValueAtTime(gainLevel, t + 0.75)
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85)
      }
      tick()
      ringTimerRef.current = setInterval(tick, 2000)
    } catch {}
  }
  function stopRing(){
    try { if (ringTimerRef.current) { clearInterval(ringTimerRef.current); ringTimerRef.current = null } } catch{}
    try { if (ringGainRef.current) { const ctx = audioCtxRef.current; const t = ctx?.currentTime || 0; ringGainRef.current.gain.setValueAtTime(0.0001, t) } } catch{}
    try { ringOscRef.current?.stop(); ringOscRef.current?.disconnect(); ringGainRef.current?.disconnect() } catch{}
    try { if (ringAudioRef.current) { ringAudioRef.current.pause(); ringAudioRef.current.currentTime = 0 } } catch{}
    try { if (ringVibeTimerRef.current) { clearInterval(ringVibeTimerRef.current); ringVibeTimerRef.current = null } } catch{}
    try { navigator.vibrate && navigator.vibrate(0) } catch{}
    ringOscRef.current = null; ringGainRef.current = null
  }

  // Fallback: ukázat call notifikaci přes SW i bez push (když máme povolené notifikace)
  async function showCallNotification({ from, fromName='', kind='audio', ts=Date.now() }){
    try {
      if (typeof Notification==='undefined' || Notification.permission!=='granted') return
      const reg = await navigator.serviceWorker?.ready
      if (!reg || !reg.showNotification) return
      const data = { type:'call', from, fromName, kind, ts }
      await reg.showNotification('Rodina', {
        body: `Příchozí ${kind==='video'?'videohovor':'hovor'}${fromName?` od ${fromName}`:''}`,
        tag: `call-${from||''}`,
        requireInteraction: true,
        renotify: true,
        vibrate: [150, 100, 150, 100, 150],
        icon: '/assets/default-avatar.png',
        actions: [ { action:'accept', title:'Přijmout' }, { action:'decline', title:'Odmítnout' } ],
        data
      })
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

  // Když appka startuje po kliknutí na notifikaci, přečteme query parametry
  useEffect(() => {
    try{
      const url = new URL(window.location.href)
      if (url.searchParams.get('notify') === '1'){
        const ntype = url.searchParams.get('ntype') || ''
        const from = url.searchParams.get('from') || ''
        const fromName = url.searchParams.get('fromName') || ''
        const kind = url.searchParams.get('kind') || 'audio'
  const tsStr = url.searchParams.get('ts') || ''
  const auto = url.searchParams.get('autopopup') === '1'
        const ts = tsStr ? parseInt(tsStr, 10) : 0
        // Stará notifikace (starší než 60s) se ignoruje
        if (ts && (Date.now() - ts > 60000)) return
        if (ntype === 'call' && (from || fromName)){
          // Necháme users načíst a potom nastavíme výběr a overlay
          const apply = () => {
            if (!users || !users.length) { setTimeout(apply, 300); return }
            const byId = from ? users.find(u => u.id === from) : null
            const person = byId || users.find(u => (u.name||'').toLowerCase() === fromName.toLowerCase())
            if (person) setSelectedUser(person)
            peerIdRef.current = from || (person && person.id) || null
            callKindRef.current = kind || 'audio'
            setCallState(cs => ({ ...cs, incoming: true, outgoing: false, active: false, connecting: false, kind, from: from || null, to: (user&&user.id)||null, remoteName: fromName || (person && person.name) || '' }))
            if (audioReady) startRing()
            // Při autopopupu ukážeme overlay a necháme uživatele přijmout rovnou
            if (auto && !audioReady) {
              // nic – počkáme na uživatelské gesto
            }
            // Timeout pro nezvednutý příchozí hovor (45s)
            clearIncomingTimeout()
            incomingTimeoutRef.current = setTimeout(() => {
              if (!callState.active) {
                declineCall()
              }
            }, 45000)
          }
          apply()
          // Vyčistíme parametry z URL (nebo to necháme být)
          try { url.searchParams.delete('notify'); window.history.replaceState({}, '', url.pathname + url.search) } catch(_){}
        }
      }
    }catch(_){ }
  }, [users, audioReady, user])

  // Reakce na kliknutí notifikace ze SW (sw:notifyClick)
  useEffect(() => {
    function onMsg(ev){
      if (!ev || !ev.data || ev.data.type !== 'sw:notifyClick') return
      const d = ev.data.data || {}
      if (!users || !users.length) { pendingCallRef.current = { type: 'click', data: d }; return }
      const byId = users.find(u => u.id === d.from)
      if (byId) setSelectedUser(byId)
      else if (d.fromName){
        const byName = users.find(u => (u.name||'').toLowerCase() === (d.fromName||'').toLowerCase())
        if (byName) setSelectedUser(byName)
      }
      if ((d.type === 'call') && d.from) {
        peerIdRef.current = d.from
        callKindRef.current = d.kind || 'audio'
        setCallState(cs => ({ ...cs, incoming: true, outgoing: false, active: false, connecting: false, kind: d.kind || 'audio', from: d.from, to: (user&&user.id)||null, remoteName: d.fromName || '' }))
        if (audioReady) startRing()
        clearIncomingTimeout()
        incomingTimeoutRef.current = setTimeout(() => { if (!callState.active) { declineCall() } }, 45000)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [users, audioReady, user])

  // Reakce na akce z notifikace (accept/decline)
  useEffect(() => {
    function onAction(ev){
      if (!ev || !ev.data || ev.data.type !== 'sw:notifyAction') return
      const { action, data } = ev.data
      if (!data || data.type !== 'call') return
      // Pokud ještě nejsou načtení uživatelé, zařaď do fronty
      if (!usersRef.current || !(usersRef.current.length)) {
        pendingCallRef.current = { type: 'action', action, data }
        return
      }
      const list = usersRef.current || []
      const who = list.find(u => u.id === data.from) || list.find(u => (u.name||'').toLowerCase() === (data.fromName||'').toLowerCase())
      if (who) setSelectedUser(who)
      peerIdRef.current = data.from
      callKindRef.current = data.kind || 'audio'
      setCallState(cs => ({ ...cs, incoming: true, outgoing: false, active: false, connecting: false, kind: data.kind || 'audio', from: data.from, to: (user&&user.id)||null, remoteName: data.fromName || '' }))
      if (audioReady) startRing()
      if (action === 'accept') setTimeout(() => { acceptCall() }, 50)
      else if (action === 'decline') setTimeout(() => { declineCall() }, 50)
    }
    window.addEventListener('message', onAction)
    return () => window.removeEventListener('message', onAction)
  }, [audioReady, user])

  // Pokud přišla notifikace dřív než se načetli uživatelé, aplikuj ji teď
  useEffect(() => {
    const pending = pendingCallRef.current
    if (!pending) return
    if (!users || !users.length) return
    if (pending.type === 'click') {
      const d = pending.data
      const byId = users.find(u => u.id === d.from)
      if (byId) setSelectedUser(byId)
      else if (d.fromName){
        const byName = users.find(u => (u.name||'').toLowerCase() === (d.fromName||'').toLowerCase())
        if (byName) setSelectedUser(byName)
      }
      if ((d.type === 'call') && d.from) {
        peerIdRef.current = d.from
        callKindRef.current = d.kind || 'audio'
        setCallState(cs => ({ ...cs, incoming: true, outgoing: false, active: false, connecting: false, kind: d.kind || 'audio', from: d.from, to: (user&&user.id)||null, remoteName: d.fromName || '' }))
        if (audioReady) startRing()
        clearIncomingTimeout()
        incomingTimeoutRef.current = setTimeout(() => { if (!callState.active) declineCall() }, 45000)
      }
    } else if (pending.type === 'action') {
      const { action, data } = pending
      const who = users.find(u => u.id === data.from) || users.find(u => (u.name||'').toLowerCase() === (data.fromName||'').toLowerCase())
      if (who) setSelectedUser(who)
      peerIdRef.current = data.from
      callKindRef.current = data.kind || 'audio'
      setCallState(cs => ({ ...cs, incoming: true, outgoing: false, active: false, connecting: false, kind: data.kind || 'audio', from: data.from, to: (user&&user.id)||null, remoteName: data.fromName || '' }))
      if (audioReady) startRing()
      if (action === 'accept') setTimeout(() => { acceptCall() }, 50)
      else if (action === 'decline') setTimeout(() => { declineCall() }, 50)
    }
    pendingCallRef.current = null
  }, [users, audioReady, user])

  // Když se objeví <video ref={localVideoRef}> až po získání streamu, znovu ho připni
  useEffect(() => {
    const s = localStreamRef.current
    const v = localVideoRef.current
    if (v && s && v.srcObject !== s) {
      try { v.srcObject = s; v.play && v.play() } catch(_){ }
    }
  }, [callState.kind, callState.incoming, callState.outgoing, callState.active, callState.connecting])

  // API base pro hovory a ICE
  useEffect(() => {
    const base = import.meta.env.PROD ? '/api' : ((import.meta.env.VITE_API_URL || 'http://localhost:3001').replace(/\/$/, '') + '/api')
    apiBaseRef.current = base
    setDiag(d => ({ ...d, apiBase: base }))
    // Zjisti SW/Push stav
    ;(async () => {
      try {
        const swReg = await (navigator.serviceWorker?.ready)
        const sw = Boolean(swReg)
        const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
        let sub = false
        if (swReg) {
          try { sub = Boolean(await swReg.pushManager.getSubscription()) } catch {}
        }
        setDiag(d => ({ ...d, sw: sw ? 'on' : 'off', pushPerm: perm, pushSub: sub }))
      } catch(_) {}
      try {
        const ice = await fetch(base + '/ice').then(r=>r.json()).catch(()=>({ iceServers: [] }))
        const count = Array.isArray(ice.iceServers) ? ice.iceServers.length : 0
        setDiag(d => ({ ...d, iceCount: count }))
      } catch(_) {}
    })()
  }, [])

  // Inicializace Pusher po přihlášení
  useEffect(() => {
    if (!user) return
    try {
      const key = import.meta.env.VITE_PUSHER_KEY
      const cluster = import.meta.env.VITE_PUSHER_CLUSTER || 'eu'
      if (!key) return
      const p = new Pusher(key, { cluster, forceTLS: true })
      const ch = p.subscribe('famcall')
      pusherRef.current = p
      channelRef.current = ch

      // Diagnostika Pusheru
      try {
        p.connection.bind('state_change', (states) => {
          setDiag(d => ({ ...d, pusher: states.current }))
        })
      } catch(_) {}

      const onIncoming = (info) => {
        if (!info || info.to !== user.id) return
        // Zahodit staré příchozí hovory starší než 60s
        if (info.ts && (Date.now() - info.ts > 60000)) return
        peerIdRef.current = info.from
        callKindRef.current = info.kind || 'audio'
        // Auto-select volajícího kontaktu (pokud existuje v seznamu)
        try {
          const list = usersRef.current || []
          const byId = list.find(u => u.id === info.from)
          const byName = !byId && info.fromName ? list.find(u => (u.name||'').toLowerCase() === (info.fromName||'').toLowerCase()) : null
          const who = byId || byName
          if (who) setSelectedUser(who)
        } catch(_){}
        setCallState(cs => ({
          ...cs,
          incoming: true,
          outgoing: false,
          active: false,
          connecting: false,
          kind: info.kind || 'audio',
          from: info.from,
          to: info.to,
          remoteName: info.fromName || ''
        }))
        if (audioReady) startRing()
        // Zobraz fallback notifikaci přes SW (když push případně nedorazí)
        showCallNotification({ from: info.from, fromName: info.fromName||'', kind: info.kind||'audio', ts: info.ts||Date.now() })
        // Timeout pro nezvednutý příchozí hovor (45s)
        clearIncomingTimeout()
        incomingTimeoutRef.current = setTimeout(() => {
          if (!callState.active) {
            declineCall()
          }
        }, 45000)
      }
      const onOffer = async (data) => {
        if (!data || data.to !== user.id) return
        // Zpracuj offer bez závislosti na starém callState v closure
        peerIdRef.current = data.from
        callKindRef.current = data.kind || callKindRef.current || 'audio'
        await ensureLocalMedia(data.kind || 'audio')
        await ensurePeerConnection(data.kind || 'audio')
        try { await pcRef.current.setRemoteDescription(data.sdp) } catch(_){}
        try {
          const answer = await pcRef.current.createAnswer()
          await pcRef.current.setLocalDescription(answer)
          await fetch(`${apiBaseRef.current}/rt/answer`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: user.id, to: data.from, sdp: pcRef.current.localDescription, kind: data.kind || 'audio' })
          })
          stopRing()
          setCallState(cs => ({ ...cs, active: true, incoming: false, outgoing: false, connecting: true }))
        } catch (e) {}
      }
      const onAnswer = async (data) => {
        if (!data || data.to !== user.id) return
        try { await pcRef.current?.setRemoteDescription(data.sdp) } catch(_){}
        stopRing()
        clearIncomingTimeout()
        setCallState(cs => ({ ...cs, connecting: false, active: true }))
      }
      const onIce = async (data) => {
        if (!data) return
        // Candidate může přijít oběma směrům; filtruj na aktuálního peerId
        const peer = peerIdRef.current
        if (data.from && peer && data.from !== peer) return
        try { await pcRef.current?.addIceCandidate(data.candidate) } catch(_){}
      }

      const onAccept = async (data) => {
        if (!data || data.to !== user.id) return
        // Callee přijal — volající teď může poslat offer
        try {
          const k = callKindRef.current || callState.kind || 'audio'
          await ensurePeerConnection(k)
          const offer = await pcRef.current.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: k==='video' })
          await pcRef.current.setLocalDescription(offer)
          await fetch(`${apiBaseRef.current}/rt/offer`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: user.id, to: peerIdRef.current, sdp: pcRef.current.localDescription, kind: k })
          })
        } catch (_) {}
      }

      const onDecline = (data) => {
        if (!data || data.to !== user.id) return
        stopRing()
        clearIncomingTimeout()
        endCall()
      }

      const onHangup = (data) => {
        if (!data) return
        const peer = peerIdRef.current
        if (data.from && peer && data.from !== peer) return
        stopRing()
        clearIncomingTimeout()
        endCall()
      }

      ch.bind('incoming_call', onIncoming)
  ch.bind('webrtc_offer', onOffer)
      ch.bind('webrtc_answer', onAnswer)
      ch.bind('webrtc_ice', onIce)
  ch.bind('webrtc_accept', onAccept)
  ch.bind('webrtc_decline', onDecline)
  ch.bind('webrtc_hangup', onHangup)

      return () => {
        try { ch.unbind('incoming_call', onIncoming); ch.unbind('webrtc_offer', onOffer); ch.unbind('webrtc_answer', onAnswer); ch.unbind('webrtc_ice', onIce); ch.unbind('webrtc_accept', onAccept); ch.unbind('webrtc_decline', onDecline); ch.unbind('webrtc_hangup', onHangup); p.unsubscribe('famcall'); p.disconnect() } catch(_){}
      }
    } catch (_) {}
  }, [user])

  // Pomocné: zajištění lokálního média
  async function ensureLocalMedia(kind='audio'){
    if (localStreamRef.current) return localStreamRef.current
    try {
      const constraints = { audio: true, video: kind === 'video' }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      localStreamRef.current = stream
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
        try { await localVideoRef.current.play() } catch(_){}
      }
      return stream
    } catch (e) {
      alert('Nelze získat přístup k mikrofonu/kameře: ' + (e.message || e.name))
      throw e
    }
  }

  // Pomocné: vytvoř/nahlaš PeerConnection
  const pcCreatingRef = useRef(false)
  async function ensurePeerConnection(kind='audio'){
    if (pcRef.current) {
      // Připojit lokální tracky k existujícím senderům (pokud ještě nejsou)
      const local = await ensureLocalMedia(kind)
      try {
        const pc = pcRef.current
        const aTrack = local.getAudioTracks()[0] || null
        const vTrack = (kind === 'video') ? (local.getVideoTracks()[0] || null) : null
        const trxs = pc.getTransceivers ? pc.getTransceivers() : []
        const snds = pc.getSenders ? pc.getSenders() : []
        const byKind = (list, k) => list.find(x => (x.kind||x.receiver?.track?.kind||x.track?.kind) === k)
        const attach = async (k, track) => {
          if (!track) return
          let trx = byKind(trxs, k)
          if (!trx && pc.addTransceiver) trx = pc.addTransceiver(k, { direction: 'sendrecv' })
          let sender = byKind(snds, k) || trx?.sender
          if (sender && sender.replaceTrack) {
            try { await sender.replaceTrack(track) } catch(_){ }
          } else {
            try { pc.addTrack(track, local) } catch(_){ }
          }
        }
        await attach('audio', aTrack)
        await attach('video', vTrack)
      } catch(_){}
      return pcRef.current
    }
    if (pcCreatingRef.current) { // počkej krátce, než se dokončí předchozí create
      while (pcCreatingRef.current && !pcRef.current) { await new Promise(r=>setTimeout(r,30)) }
      return pcRef.current
    }
    pcCreatingRef.current = true
    try {
      const iceResp = await fetch(`${apiBaseRef.current}/ice`).then(r=>r.json()).catch(()=>({ iceServers: [ { urls: 'stun:stun.l.google.com:19302' } ] }))
      const pc = new RTCPeerConnection({ iceServers: iceResp.iceServers || [ { urls: 'stun:stun.l.google.com:19302' } ] })
      pcRef.current = pc
      pc.ontrack = (ev) => {
        const [remote] = ev.streams
        remoteStreamRef.current = remote
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = remote
          try { remoteVideoRef.current.play() } catch(_){ }
        }
      }
      pc.onicecandidate = async (e) => {
        if (e.candidate && peerIdRef.current) {
          try {
            await fetch(`${apiBaseRef.current}/rt/ice`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: user.id, to: peerIdRef.current, candidate: e.candidate })
            })
          } catch(_){ }
        }
      }
      // Připoj lokální média
      const local = await ensureLocalMedia(kind)
      const aTrack = local.getAudioTracks()[0] || null
      const vTrack = (kind === 'video') ? (local.getVideoTracks()[0] || null) : null
      if (pc.addTransceiver) {
        const ta = pc.addTransceiver('audio', { direction: 'sendrecv' })
        if (aTrack) { try { await ta.sender.replaceTrack(aTrack) } catch { try { pc.addTrack(aTrack, local) } catch {} } }
        const tv = pc.addTransceiver('video', { direction: 'sendrecv' })
        if (vTrack) { try { await tv.sender.replaceTrack(vTrack) } catch { try { pc.addTrack(vTrack, local) } catch {} } }
      } else {
        if (aTrack) { try { pc.addTrack(aTrack, local) } catch{}_ }
        if (vTrack) { try { pc.addTrack(vTrack, local) } catch{}_ }
      }
      return pc
    } finally {
      pcCreatingRef.current = false
    }
  }

  async function startCall(kind='audio'){
    if (!selectedUser) return
    peerIdRef.current = selectedUser.id
    callKindRef.current = kind
    setCallState({ active: false, incoming: false, outgoing: true, kind, from: user.id, to: selectedUser.id, connecting: true, remoteName: selectedUser.name })
    // Oznám příchozí hovor druhé straně (ring); offer se pošle až po explicitním accept
    try { await fetch(`${apiBaseRef.current}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: user.id, to: selectedUser.id, kind, fromName: user.name }) }) } catch(_){}
    try { await ensureLocalMedia(kind) } catch(_){}

    // Nastav timeout na nezdvihnutý odchozí hovor (bez odpovědi)
    clearTimeout(incomingTimeoutRef.current)
    incomingTimeoutRef.current = setTimeout(() => {
      // Pokud se hovor během 45s nerozeběhne, ukonči zvonění a hovor
      if (!pcRef.current || !peerIdRef.current) {
        stopRing()
        endCall()
      }
    }, 45000)
  }

  async function endCall(){
    // pošli hangup peerovi
    if (peerIdRef.current) {
      try { await fetch(`${apiBaseRef.current}/rt/hangup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: user.id, to: peerIdRef.current }) }) } catch(_){}
    }
    stopRing()
    try { pcRef.current?.getSenders?.().forEach(s => { try { s.track && s.track.stop() } catch(_){} }) } catch(_){ }
    try { localStreamRef.current?.getTracks?.().forEach(t => t.stop()) } catch(_){ }
    try { pcRef.current?.close() } catch(_){ }
    pcRef.current = null
    localStreamRef.current = null
    remoteStreamRef.current = null
    if (localVideoRef.current) localVideoRef.current.srcObject = null
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
    peerIdRef.current = null
    setCallState({ active: false, incoming: false, outgoing: false, kind: 'audio', from: null, to: null, connecting: false, remoteName: '' })
  }

  async function acceptCall(){
    setCallState(cs => ({ ...cs, incoming: false, connecting: true }))
    try {
      const k = callKindRef.current || callState.kind || 'audio'
      await ensureLocalMedia(k)
      await ensurePeerConnection(k)
      // signalizuj protistraně, že může poslat offer
      if (peerIdRef.current) {
        await fetch(`${apiBaseRef.current}/rt/accept`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ from: user.id, to: peerIdRef.current }) })
      }
      stopRing()
      clearIncomingTimeout()
    } catch(_){}
  }

  function declineCall(){
    // pošli decline a ukonči
    const peer = peerIdRef.current
    if (peer) {
      fetch(`${apiBaseRef.current}/rt/decline`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ from: user.id, to: peer }) }).catch(()=>{})
    }
    stopRing()
    endCall()
  }

  // Vyčistit timeouty při unmountu
  useEffect(() => {
    return () => { try { clearTimeout(incomingTimeoutRef.current) } catch{} }
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
          if (snap.empty) return
          const doc0 = snap.docs[0]
          const d = doc0.data()
          const msgId = doc0.id
          // Deduplikace: upozorni jen jednou na konkrétní poslední zprávu
          const last = lastNotifiedRef.current[u.id]
          if (last === msgId) return
          // Upozorni jen když je to od protistrany a chat není aktivní
          const activeSel = selectedUserRef.current
          if (d.from === user.id) return
          if (activeSel && activeSel.id === u.id) return
          // Neposílej upozornění na staré zprávy (porovnej s lastRead)
          const created = d.createdAt?.toMillis?.() || 0
          // Pozor: lastRead chceme číst “aktuální”; jednoduše ignoruj >24h staré
          if (created && Date.now() - created > 24*60*60*1000) { lastNotifiedRef.current[u.id] = msgId; return }
          lastNotifiedRef.current[u.id] = msgId
          if (Notification && Notification.permission === 'granted') {
            try {
              new Notification(`${d.name}: ${d.text || (d.imageUrl ? '🖼 Obrázek' : (d.audioUrl ? '🎙 Hlasová zpráva' : 'Nová zpráva'))}`, { body: 'Nová zpráva', icon: d.avatar || '/assets/default-avatar.png' })
              if (audioReady) playBeep()
              try { navigator.vibrate && navigator.vibrate([40, 30, 40]) } catch {}
            } catch(e) { /* ignore */ }
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
  useEffect(() => { usersRef.current = users }, [users])


  const handleAuth = (authedUser) => {
    localStorage.setItem('rodina:user', JSON.stringify(authedUser))
    setUser(authedUser)
    // Po přihlášení znovu zaregistruj push se svým userId
    try {
      if ('serviceWorker' in navigator) {
        const apiBase = import.meta.env.PROD ? '/api' : ((import.meta.env.VITE_API_URL || 'http://localhost:3001').replace(/\/$/, '') + '/api')
        navigator.serviceWorker.ready.then(reg => initPush(reg, apiBase, authedUser.id)).catch(()=>{})
      }
    } catch (_) {}
  }

  // Periodicky ověř, že existuje push subscription – pokud chybí, přihlásí se znovu s current userId
  useEffect(() => {
    if (!user) return
    let tm = null
    const tick = async () => {
      try {
        const reg = await navigator.serviceWorker?.ready
        if (!reg) return
        const sub = await reg.pushManager.getSubscription()
        if (!sub) {
          const apiBase = import.meta.env.PROD ? '/api' : ((import.meta.env.VITE_API_URL || 'http://localhost:3001').replace(/\/$/, '') + '/api')
          await initPush(reg, apiBase, user.id)
        }
      } catch {}
      tm = setTimeout(tick, 30000)
    }
    tick()
    return () => { if (tm) clearTimeout(tm) }
  }, [user])

  const handleLogout = () => {
    localStorage.removeItem('rodina:user')
    localStorage.removeItem('rodina:lastUserId')
    localStorage.removeItem('rodina:lastName')
    setUser(null)
    setSelectedUser(null)
  }

  const [theme, setTheme] = useState(localStorage.getItem('rodina:theme') || 'default')
  const [needNotify, setNeedNotify] = useState(false)
  const [installEvt, setInstallEvt] = useState(null)
  const [showInstallModal, setShowInstallModal] = useState(false)

  const handleThemeChange = (next) => {
    setTheme(next)
    try { localStorage.setItem('rodina:theme', next) } catch (_) {}
  }

  // Lehký průběžný check, zda máme povolené oznámení a subscription existuje
  useEffect(() => {
    let stop = false
    const check = async () => {
      try {
        const perm = typeof Notification !== 'undefined' ? Notification.permission : 'denied'
        let hasSub = false
        const reg = await navigator.serviceWorker?.ready
        if (reg) {
          try { hasSub = Boolean(await reg.pushManager.getSubscription()) } catch {}
        }
        if (!stop) setNeedNotify(!(perm === 'granted' && hasSub))
      } catch {}
    }
    check()
    const t = setInterval(check, 15000)
    return () => { stop = true; clearInterval(t) }
  }, [])

  // PWA instalace na Android (lepší heads-up notifikace a auto-open chování)
  useEffect(() => {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone
    const handler = (e) => { if (!isStandalone) { e.preventDefault(); setInstallEvt(e) } }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  useEffect(() => {
    if (!installEvt) return
    try {
      if (sessionStorage.getItem('rodina:installPromptShown') === '1') return
      sessionStorage.setItem('rodina:installPromptShown', '1')
    } catch (_) {}
    setShowInstallModal(true)
  }, [installEvt])

  const promptInstall = async () => {
    if (!installEvt) return
    try {
      await installEvt.prompt()
      await installEvt.userChoice
    } catch (_) {}
    setShowInstallModal(false)
    setInstallEvt(null)
  }

  const dismissInstallModal = () => {
    setShowInstallModal(false)
  }

  const installModal = showInstallModal && installEvt ? (
    <div className="install-backdrop" onClick={dismissInstallModal}>
      <div className="install-modal" onClick={(e) => e.stopPropagation()}>
        <img src="/icons/icon-192.png" alt="Ikona aplikace Rodina" className="install-modal-icon" />
        <h3>Nainstalovat aplikaci Rodina?</h3>
        <p>Budete ji mít rychle po ruce přímo na ploše telefonu.</p>
        <div className="install-modal-actions">
          <button type="button" className="btn secondary" onClick={dismissInstallModal}>Později</button>
          <button type="button" className="btn primary" onClick={promptInstall}>Instalovat</button>
        </div>
      </div>
    </div>
  ) : null

  if (!user) return <>{installModal}<Auth onAuth={handleAuth} /></>

  return (
  <div className={"app" + (selectedUser ? " chat-open" : " no-chat") + (theme && theme!=='default' ? ` theme-${theme}` : '')}>
      {installModal}
      {/* Globální odemknutí zvuku – pomůže, aby příchozí hovor mohl hned zvonit */}
      {!audioReady && (
        <div style={{position:'fixed',left:10,bottom:10,zIndex:3000}}>
          <button onClick={async()=>{
            try {
              if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()
              if (audioCtxRef.current.state === 'suspended') await audioCtxRef.current.resume()
              setAudioReady(true)
              if (callState.incoming || callState.outgoing) startRing()
            } catch {}
          }} style={{background:'#1f2937',border:'1px solid #374151',color:'#cbd5e1',borderRadius:10,padding:'8px 12px',cursor:'pointer',boxShadow:'0 2px 8px rgba(0,0,0,.3)'}}>
            Zapnout vyzvánění
          </button>
        </div>
      )}
      {isSettingsOpen && <SettingsModal user={user} theme={theme} onThemeChange={handleThemeChange} onAuth={handleAuth} onClose={() => setIsSettingsOpen(false)} />}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>Rodina</h2>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            {needNotify && (
              <button title="Povolit oznámení" onClick={async()=>{
                try{
                  if (typeof Notification!=='undefined' && Notification.permission==='default') await Notification.requestPermission()
                  const reg = await navigator.serviceWorker?.ready
                  if (reg) {
                    const apiBase = import.meta.env.PROD ? '/api' : ((import.meta.env.VITE_API_URL || 'http://localhost:3001').replace(/\/$/, '') + '/api')
                    const u = JSON.parse(localStorage.getItem('rodina:user')||'null')
                    await initPush(reg, apiBase, u?.id || null)
                  }
                  // recheck
                  const reg2 = await navigator.serviceWorker?.ready
                  const perm2 = typeof Notification !== 'undefined' ? Notification.permission : 'denied'
                  const sub2 = await reg2?.pushManager?.getSubscription()
                  setNeedNotify(!(perm2==='granted' && Boolean(sub2)))
                }catch(_){ }
              }} style={{background:'#1f2937',border:'1px solid #374151',color:'#cbd5e1',borderRadius:8,padding:'6px 8px',cursor:'pointer'}}>🔔 Povolit</button>
            )}
            {installEvt && (
              <button title="Instalovat" onClick={promptInstall} style={{background:'#1f2937',border:'1px solid #374151',color:'#cbd5e1',borderRadius:8,padding:'6px 8px',cursor:'pointer'}}>⬇️ Instalovat</button>
            )}
            <button className="settings-btn" onClick={() => setIsSettingsOpen(true)}>⚙️</button>
          </div>
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
              <div style={{display:'flex',alignItems:'center',gap:'12px',flex:1}}>
                <img src={selectedUser.avatar || '/assets/default-avatar.png'} alt={selectedUser.name} style={{width:48,height:48,borderRadius:14,objectFit:'cover',border:'1px solid #3d4b5c'}} />
                <div style={{display:'flex',flexDirection:'column'}}>
                  <strong style={{fontSize:'16px'}}>{selectedUser.name}</strong>
                  <span style={{fontSize:'12px',color:'#9ca3af'}}>{selectedUser.online ? 'Online' : 'Offline'}</span>
                </div>
              </div>
              <div style={{marginLeft:'auto',display:'flex',gap:10}}>
                <button title="Zavolat" aria-label="Zavolat" onClick={() => startCall('audio')} style={{background:'#1f2530',border:'1px solid #2d3748',color:'#e6edf3',width:44,height:44,borderRadius:12,cursor:'pointer',fontSize:'18px',display:'flex',alignItems:'center',justifyContent:'center'}}>📞</button>
                <button title="Videohovor" aria-label="Videohovor" onClick={() => startCall('video')} style={{background:'#1f2530',border:'1px solid #2d3748',color:'#e6edf3',width:44,height:44,borderRadius:12,cursor:'pointer',fontSize:'18px',display:'flex',alignItems:'center',justifyContent:'center'}}>🎥</button>
              </div>
            </div>
            <ChatWindow user={user} selectedUser={selectedUser} />
          </div>
        ) : null}
      </main>
      {/* Call overlay */}
      {(callState.incoming || callState.outgoing || callState.active || callState.connecting) && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:3000}}>
          <div style={{background:'#111827',border:'1px solid #374151',borderRadius:16,padding:16,width:'min(900px,96vw)',minHeight: callState.kind==='video' ? 420 : 220, display:'flex',flexDirection:'column',gap:12}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <strong>{callState.incoming ? `Příchozí ${callState.kind==='video'?'videohovor':'hovor'}${callState.remoteName?` od ${callState.remoteName}`:''}` : (callState.outgoing && !callState.active ? 'Volám…' : 'Hovor')}</strong>
              <button onClick={endCall} style={{background:'#b91c1c',border:'1px solid #7f1d1d',color:'#fff',borderRadius:10,padding:'8px 12px',cursor:'pointer'}}>Zavěsit</button>
            </div>
            {callState.kind==='video' ? (
              <div style={{position:'relative',display:'flex',gap:12,flex:1,minHeight:300}}>
                <video ref={remoteVideoRef} playsInline autoPlay muted={false} style={{width:'100%',height:'100%',background:'#0b1220',borderRadius:12,border:'1px solid #253243',objectFit:'cover'}} />
                <video ref={localVideoRef} playsInline autoPlay muted style={{position:'absolute',right:12,bottom:12,width:180,height:120,background:'#0b1220',borderRadius:10,border:'1px solid #253243',objectFit:'cover'}} />
              </div>
            ) : (
              <div style={{display:'flex',alignItems:'center',justifyContent:'center',flex:1,minHeight:120,color:'#e6edf3'}}>
                <div style={{textAlign:'center'}}>
                  <div style={{fontSize:48,marginBottom:8}}>📞</div>
                  <div>{callState.remoteName || 'Volání'}</div>
                  {callState.connecting && <div style={{fontSize:12,opacity:.8,marginTop:6}}>Připojuji…</div>}
                </div>
              </div>
            )}
            {/* Ovládání vyzvánění */}
            {(callState.incoming || callState.outgoing) && (
              <div style={{display:'flex',justifyContent:'center',alignItems:'center',gap:12}}>
                <label style={{display:'flex',alignItems:'center',gap:8,fontSize:13,opacity:.9}}>
                  <input type="checkbox" checked={ringMuted} onChange={(e)=>{ setRingMuted(e.target.checked); try { localStorage.setItem('rodina:ringMuted', e.target.checked ? '1' : '0') } catch{} }} />
                  Ztlumit vyzvánění
                </label>
                {!audioReady && (
                  <button onClick={async()=>{
                    try {
                      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()
                      if (audioCtxRef.current.state === 'suspended') await audioCtxRef.current.resume()
                      setAudioReady(true)
                      startRing()
                    } catch(_){}
                  }} style={{background:'#1f2937',border:'1px solid #374151',color:'#cbd5e1',borderRadius:6,padding:'6px 10px',cursor:'pointer'}}>Odemknout zvuk</button>
                )}
              </div>
            )}
            {callState.incoming && (
              <div style={{display:'flex',gap:12,justifyContent:'center'}}>
                <button onClick={acceptCall} style={{background:'#059669',border:'1px solid #047857',color:'#fff',borderRadius:10,padding:'10px 16px',cursor:'pointer'}}>Přijmout</button>
                <button onClick={declineCall} style={{background:'#b91c1c',border:'1px solid #7f1d1d',color:'#fff',borderRadius:10,padding:'10px 16px',cursor:'pointer'}}>Odmítnout</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SettingsModal({ user, theme='default', onThemeChange=()=>{}, onAuth, onClose }) {
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
        <div>
          <label style={{display:'block',marginBottom:8}}>Barva pozadí:</label>
          <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
            {[
              { key:'default', name:'Výchozí', sw:'#233044' },
              { key:'green', name:'Zelená', sw:'#065f46' },
              { key:'purple', name:'Fialová', sw:'#4c1d95' },
              { key:'blue', name:'Světle modrá', sw:'#1e3a8a' },
              { key:'orange', name:'Oranžová', sw:'#9a3412' },
              { key:'red', name:'Červená', sw:'#7f1d1d' }
            ].map(opt => (
              <button key={opt.key}
                type="button"
                onClick={() => onThemeChange(opt.key)}
                aria-pressed={theme===opt.key}
                title={opt.name}
                style={{
                  width:42,height:42,borderRadius:12,cursor:'pointer',
                  border: theme===opt.key ? '2px solid #fff' : '1px solid #2d3748',
                  outline:'none', background: opt.sw
                }}
              />
            ))}
          </div>
        </div>
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