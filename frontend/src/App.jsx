import React, { useEffect, useState } from 'react'
import axios from 'axios'
import io from 'socket.io-client'
import Pusher from 'pusher-js'
import { createPeerConnection } from './webrtc'

const isProd = import.meta.env.PROD
const DEV_API = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const API_BASE = isProd ? '/.netlify/functions/proxy' : DEV_API
const api = (path) => `${API_BASE}${path}`
const mediaUrl = (u) => {
  if (!u) return ''
  if (/^https?:\/\//.test(u)) return u
  return `${API_BASE}${u}`
}
// Socket.IO pouze v dev; v produkci používáme Pusher + REST signaling
const socket = isProd ? { on: ()=>{}, emit: ()=>{} } : io(DEV_API)

let pusher = null, channel = null
if (import.meta.env.VITE_PUSHER_KEY && import.meta.env.VITE_PUSHER_CLUSTER){
  pusher = new Pusher(import.meta.env.VITE_PUSHER_KEY, { cluster: import.meta.env.VITE_PUSHER_CLUSTER })
  channel = pusher.subscribe('famcall')
}

export default function App(){
  const [user, setUser] = useState(null)
  const [users, setUsers] = useState([])
  const [messages, setMessages] = useState([])
  const [selected, setSelected] = useState(null)
  const [text, setText] = useState('')
  const [file, setFile] = useState(null)
  const [recorder, setRecorder] = useState(null)
  const [recording, setRecording] = useState(false)
  const [localStream, setLocalStream] = useState(null)
  const [remoteStream, setRemoteStream] = useState(null)
  const [incomingCall, setIncomingCall] = useState(null)
  const [inCall, setInCall] = useState(false)
  const [ringing, setRinging] = useState(false)
  const [typing, setTyping] = useState(false)
  const [peerTyping, setPeerTyping] = useState(false)
  const pcRef = React.useRef(null)
  const iceServersRef = React.useRef(null)
  const localVideoRef = React.useRef()
  const remoteVideoRef = React.useRef()

  useEffect(()=>{
    fetchUsers()
    const onMessage = (msg)=> setMessages(m => [...m, msg])
    const onPresence = (p)=> setUsers(u => u.map(us => us.id===p.id?{...us, online:p.online}:us))
    const onIncoming = (callInfo)=>{ setIncomingCall(callInfo); startRingtone() }
    const onOffer = async ({ sdp })=>{ setIncomingCall({ type: 'video', sdp }) }
    socket.on('message', onMessage)
    socket.on('presence', onPresence)
    socket.on('incoming_call', onIncoming)
    socket.on('webrtc_offer', onOffer)
    if(channel){
      channel.bind('message', onMessage)
      channel.bind('presence', onPresence)
      channel.bind('incoming_call', onIncoming)
      channel.bind('webrtc_offer', onOffer)
      channel.bind('webrtc_answer', ({sdp})=> pcRef.current?.setRemoteDescription(sdp))
      channel.bind('webrtc_ice', ({candidate})=> pcRef.current?.addIceCandidate(candidate).catch(()=>{}))
      channel.bind('typing', ({ from, to })=>{ if(user && selected && to===user.id && from===selected.id){ setPeerTyping(true); setTimeout(()=>setPeerTyping(false), 1500) } })
      channel.bind('delivered', ({ id })=>{ setMessages(m=> m.map(x=> x.id===id? { ...x, delivered: true }: x)) })
    }
  }, [])

  useEffect(()=>{ if (user) socket.emit('registerSocket', user.id) }, [user])
  useEffect(()=>{ if(remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream }, [remoteStream])
  useEffect(()=>{ if(localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream }, [localStream])

  async function fetchUsers(){
    const res = await axios.get(api('/api/users'))
    setUsers(res.data)
  }

  useEffect(()=>{
    if(!user || !selected) return
    ;(async ()=>{
      try{
        const qs = `?me=${encodeURIComponent(user.id)}&peer=${encodeURIComponent(selected.id)}&limit=200`
        const res = await fetch(api('/api/messages')+qs)
        if(res.ok){ const list = await res.json(); setMessages(list) }
      }catch(_){ }
    })()
  }, [user, selected?.id])

  async function send(){
    if(!user) return alert('Přihlašte se')
    if(!selected) return alert('Vyberte příjemce v seznamu vlevo')
    if (file){
      const form = new FormData()
      form.append('from', user.id)
      form.append('to', selected.id)
      form.append('file', file)
      if (text) form.append('text', text)
      const resp = await fetch(api('/api/message'), { method: 'POST', body: form })
      const sent = await resp.json().catch(()=>null)
      if(sent?.id){ setMessages(m=> [...m, { ...sent, delivered: true }]) }
      setFile(null)
    } else {
      const { data: sent } = await axios.post(api('/api/message'), { from: user.id, to: selected.id, text })
      if(sent?.id){ setMessages(m=> [...m, { ...sent, delivered: true }]) }
    }
    setText('')
  }

  async function startVoice(){
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      const chunks = []
      rec.ondataavailable = e=>{ if(e.data.size) chunks.push(e.data) }
      rec.onstop = async ()=>{
        const blob = new Blob(chunks, { type: 'audio/webm' })
        const form = new FormData()
        form.append('from', user.id)
        form.append('file', blob, 'voice.webm')
        await fetch(api('/api/message'), { method: 'POST', body: form })
        stream.getTracks().forEach(t=>t.stop())
      }
      rec.start()
      setRecorder(rec); setRecording(true)
    }catch(e){ alert('Mikrofon nedostupný: '+e.message) }
  }
  function stopVoice(){ if(recorder){ recorder.stop(); setRecording(false); setRecorder(null) } }

  // Typing indicator
  useEffect(()=>{
    if(!user || !selected) return
    if(!typing) return
    const payload = { from: user.id, to: selected.id }
    fetch('/.netlify/functions/proxy/api/rt/typing', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
    const t = setTimeout(()=> setTyping(false), 800)
    return ()=> clearTimeout(t)
  }, [typing])

  async function startCall(type='video', toUserId=null){
    if(!user) return
    if(!iceServersRef.current){
      try{
        const fnUrl = '/.netlify/functions/ice'
        const resFn = await fetch(fnUrl)
        if(resFn.ok){ const data = await resFn.json(); iceServersRef.current = data.iceServers }
      }catch(e){}
      if(!iceServersRef.current){
        try{
          const res = await fetch(api('/api/ice'))
          if(res.ok){ const data = await res.json(); iceServersRef.current = data.iceServers }
        }catch(e){}
      }
    }
    const pc = createPeerConnection({ socket, onTrack: (s)=>setRemoteStream(s), iceServers: iceServersRef.current||undefined })
    pcRef.current = pc
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ video: type==='video', audio: true })
      setLocalStream(stream)
      stream.getTracks().forEach(t=>pc.addTrack(t, stream))
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const offerBody = { sdp: pc.localDescription, from: user.id, to: toUserId }
      try{ await fetch('/.netlify/functions/proxy/api/rt/offer', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(offerBody) }) }catch(e){ socket.emit('webrtc_offer', offerBody) }
      setInCall(true)
    }catch(e){ alert('Nelze získat média: '+e.message) }
  }

  async function acceptCall(){
    if(!incomingCall) return
    if(!iceServersRef.current){
      try{
        const fnUrl = '/.netlify/functions/ice'
        const resFn = await fetch(fnUrl)
        if(resFn.ok){ const data = await resFn.json(); iceServersRef.current = data.iceServers }
      }catch(e){}
      if(!iceServersRef.current){
        try{
          const res = await fetch(api('/api/ice'))
          if(res.ok){ const data = await res.json(); iceServersRef.current = data.iceServers }
        }catch(e){}
      }
    }
    const pc = createPeerConnection({ socket, onTrack: (s)=>setRemoteStream(s), iceServers: iceServersRef.current||undefined })
    pcRef.current = pc
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      setLocalStream(stream)
      stream.getTracks().forEach(t=>pc.addTrack(t, stream))
      await pc.setRemoteDescription(incomingCall.sdp)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      const answerBody = { sdp: pc.localDescription, from: user.id, to: incomingCall?.from }
      try{ await fetch('/.netlify/functions/proxy/api/rt/answer', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(answerBody) }) }catch(e){ socket.emit('webrtc_answer', answerBody) }
      setInCall(true)
      stopRingtone()
      setIncomingCall(null)
    }catch(e){ alert('Nelze přijmout hovor: '+e.message) }
  }

  function endCall(){
    if(pcRef.current){ pcRef.current.close(); pcRef.current=null }
    localStream?.getTracks().forEach(t=>t.stop())
    setLocalStream(null); setRemoteStream(null); setInCall(false)
  }

  // Ringtone pomocí WebAudio (abychom nemuseli vkládat binární soubory)
  const audioCtxRef = React.useRef(null)
  const oscRef = React.useRef(null)
  function startRingtone(){
    try{
      if(!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext||window.webkitAudioContext)()
      const ctx = audioCtxRef.current
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.02; o.connect(g); g.connect(ctx.destination); o.start()
      oscRef.current = { o, g }
      setRinging(true)
    }catch(e){}
  }
  function stopRingtone(){ try{ oscRef.current?.o.stop(); oscRef.current=null; setRinging(false) }catch(e){} }

  if(!user) return <Auth onAuth={u=>setUser(u)} />

  return (
    <div className="app">
      <aside className="sidebar">
        <h2>Rodina</h2>
        <ul>
          {users.filter(u=>u.id!==user.id).map(u=> (
            <li key={u.id} className={(u.online? 'online ':'') + (selected?.id===u.id?'selected':'')} onClick={()=>setSelected(u)}>
              <img src={(u.avatar? mediaUrl(u.avatar):'/assets/default-avatar.png')} alt="avatar" />
              <div>
                <div className="name">{u.name}</div>
                <div className="last">{u.online? 'Online':'Offline'}</div>
              </div>
              <div>
                <button onClick={()=>startCall('video', u.id)}>Video</button>
                <button onClick={()=>startCall('audio', u.id)}>Hovor</button>
              </div>
            </li>
          ))}
        </ul>
      </aside>
      <main className="chat">
        {selected && (
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'8px 12px',borderBottom:'1px solid rgba(255,255,255,.08)'}}>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <img src={(selected.avatar? mediaUrl(selected.avatar):'/assets/default-avatar.png')} alt="avatar" style={{width:36,height:36,borderRadius:18,objectFit:'cover'}}/>
              <div>
                <div style={{fontWeight:600}}>{selected.name}</div>
                {peerTyping && <div style={{fontSize:12,opacity:.8}}>píše…</div>}
              </div>
            </div>
            <div style={{display:'flex',gap:8}}>
              <button onClick={()=>startCall('video', selected.id)}>🎥</button>
              <button onClick={()=>startCall('audio', selected.id)}>📞</button>
            </div>
          </div>
        )}
        {!!incomingCall && !inCall && (
          <div className="call-overlay">
            <div className="overlay-card">
              <h3>Příchozí hovor</h3>
              <div className="buttons">
                <button onClick={acceptCall}>Přijmout</button>
                <button onClick={()=>{ setIncomingCall(null); stopRingtone() }}>Odmítnout</button>
              </div>
            </div>
          </div>
        )}
        {inCall && <div className="call-screen">
          <video ref={remoteVideoRef} autoPlay playsInline style={{width:'100%'}}></video>
          <video ref={localVideoRef} autoPlay playsInline muted style={{width:120,position:'absolute',right:16,top:16}}></video>
          <div className="call-controls"><button onClick={endCall}>Ukončit</button></div>
        </div>}
        <div className="messages">
          {messages
            .filter(m=> !selected || (m.to? ((m.from===user.id && m.to===selected.id) || (m.from===selected.id && m.to===user.id)) : true))
            .map(m=> (
            <div key={m.id} className={m.from===user.id? 'me':'them'}>
              {m.type==='image' && <img src={mediaUrl(m.url)} alt="foto" style={{maxWidth:'60%'}} />}
              {m.type==='video' && <video src={mediaUrl(m.url)} controls style={{maxWidth:'60%'}} />}
              {m.type==='audio' && <audio src={mediaUrl(m.url)} controls />}
              {(!m.type || m.type==='text') && <div className="msg-text">{m.text}</div>}
            </div>
          ))}
        </div>
        <div className="composer">
          <input value={text} onChange={e=>{ setText(e.target.value); setTyping(true) }} placeholder={selected?`Zpráva pro ${selected.name}…`:'Vyberte příjemce vlevo'} />
          <input type="file" onChange={e=>setFile(e.target.files?.[0]||null)} />
          {!recording ? <button onClick={startVoice}>🎤 Hlasovka</button> : <button onClick={stopVoice}>⏹️ Stop</button>}
          <button onClick={send}>Odeslat</button>
        </div>
      </main>
    </div>
  )
}

function Auth({onAuth}){
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [stage, setStage] = useState('choose')
  const avatarRef = React.useRef()

  useEffect(()=>{
    const lastName = localStorage.getItem('rodina:lastName') || ''
    const lastStage = localStorage.getItem('rodina:lastStage') || 'choose'
    setName(lastName)
    setStage(lastStage)
  }, [])

  async function register(e){
    e.preventDefault()
    const form = new FormData()
    form.append('name', name)
    form.append('pin', pin)
    if (avatarRef.current?.files?.[0]) form.append('avatar', avatarRef.current.files[0])
    await fetch(api('/api/register'), { method: 'POST', body: form })
    const res = await fetch(api('/api/login'), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, pin })})
    if(res.ok){ const user = await res.json(); localStorage.setItem('rodina:lastName', name); localStorage.setItem('rodina:lastUserId', user.id); localStorage.setItem('rodina:lastStage','pin'); onAuth(user) }
  }

  if(stage==='login' || stage==='pin') return (
    <div className="auth">
      <h2>Přihlášení</h2>
      <form onSubmit={async (e)=>{ e.preventDefault(); const payload = stage==='pin'? { id: localStorage.getItem('rodina:lastUserId')||undefined, name: localStorage.getItem('rodina:lastName')||name, pin }: { name, pin }; const res = await fetch(api('/api/login'), { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)}); if(res.ok){ const u = await res.json(); localStorage.setItem('rodina:lastName', u.name); localStorage.setItem('rodina:lastUserId', u.id); localStorage.setItem('rodina:lastStage','pin'); onAuth(u) } else { alert('Chybný PIN nebo uživatel') } }}>
        {stage!=='pin' && <input placeholder="Jméno" value={name} onChange={e=>setName(e.target.value)} />}
        <input placeholder="4-místný PIN" value={pin} onChange={e=>setPin(e.target.value)} />
        <button type="submit">Přihlásit</button>
      </form>
      <p><button onClick={()=>setStage('choose')}>Založit nový profil</button></p>
    </div>
  )

  return (
    <div className="auth">
      <h2>Vítejte v Rodině</h2>
      <form onSubmit={register}>
        <input placeholder="Jméno" value={name} onChange={e=>setName(e.target.value)} />
        <input placeholder="4-místný PIN" value={pin} onChange={e=>setPin(e.target.value)} />
        <input type="file" name="avatar" ref={avatarRef} />
        <button type="submit">Vytvořit profil</button>
      </form>
      <p>Máte už profil? <button onClick={()=>setStage('login')}>Přihlásit se</button> <button onClick={()=>setStage('pin')}>Jen PIN</button></p>
    </div>
  )
}
