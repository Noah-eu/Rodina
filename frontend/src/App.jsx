import React, { useEffect, useState } from 'react'
import axios from 'axios'
import io from 'socket.io-client'
import Pusher from 'pusher-js'
import { createPeerConnection } from './webrtc'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const socket = io(API)
let pusher = null, channel = null
if (import.meta.env.VITE_PUSHER_KEY && import.meta.env.VITE_PUSHER_CLUSTER){
  pusher = new Pusher(import.meta.env.VITE_PUSHER_KEY, { cluster: import.meta.env.VITE_PUSHER_CLUSTER })
  channel = pusher.subscribe('famcall')
}

export default function App(){
  const [user, setUser] = useState(null)
  const [users, setUsers] = useState([])
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [file, setFile] = useState(null)
  const [recorder, setRecorder] = useState(null)
  const [recording, setRecording] = useState(false)
  const [localStream, setLocalStream] = useState(null)
  const [remoteStream, setRemoteStream] = useState(null)
  const [incomingCall, setIncomingCall] = useState(null)
  const [inCall, setInCall] = useState(false)
  const [ringing, setRinging] = useState(false)
  const pcRef = React.useRef(null)
  const iceServersRef = React.useRef(null)
  const localVideoRef = React.useRef()
  const remoteVideoRef = React.useRef()

  useEffect(()=>{
    fetchUsers()
    const onMessage = (msg)=> setMessages(m => [...m, msg])
    const onPresence = (p)=> setUsers(u => u.map(us => us.id===p.id?{...us, online:p.online}:us))
    const onIncoming = (callInfo)=>{ setIncomingCall(callInfo); startRingtone() }
    const onOffer = async ({ sdp })=>{
      setIncomingCall({ type: 'video', sdp })
    }
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
    }
  }, [])

  useEffect(()=>{
    if (user) socket.emit('registerSocket', user.id)
  }, [user])

  useEffect(()=>{
    if(remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream
  }, [remoteStream])

  useEffect(()=>{
    if(localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream
  }, [localStream])

  async function fetchUsers(){
    const res = await axios.get(`${API}/api/users`)
    setUsers(res.data)
  }

  async function send(){
    if(!user) return alert('Přihlašte se')
    if (file){
      const form = new FormData()
      form.append('from', user.id)
      form.append('file', file)
      if (text) form.append('text', text)
      await fetch(`${API}/api/message`, { method: 'POST', body: form })
      setFile(null)
    } else {
      await axios.post(`${API}/api/message`, { from: user.id, text })
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
        await fetch(`${API}/api/message`, { method: 'POST', body: form })
        stream.getTracks().forEach(t=>t.stop())
      }
      rec.start()
      setRecorder(rec); setRecording(true)
    }catch(e){ alert('Mikrofon nedostupný: '+e.message) }
  }
  function stopVoice(){ if(recorder){ recorder.stop(); setRecording(false); setRecorder(null) } }

  async function startCall(type='video'){
    if(!user) return
    // ensure ICE config is loaded once
    if(!iceServersRef.current){
      try{
        // Prefer Netlify function in production
        const fnUrl = '/.netlify/functions/ice'
        const resFn = await fetch(fnUrl)
        if(resFn.ok){ const data = await resFn.json(); iceServersRef.current = data.iceServers }
      }catch(e){ }
      if(!iceServersRef.current){
        try{
          const res = await fetch(`${API}/api/ice`)
          if(res.ok){ const data = await res.json(); iceServersRef.current = data.iceServers }
        }catch(e){ /* ignore, fallback to default STUN */ }
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
  // REST signaling pro produkci (Pusher)
  try{ await fetch('/.netlify/functions/proxy/api/rt/offer', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ sdp: pc.localDescription }) }) }catch(e){ socket.emit('webrtc_offer', { sdp: pc.localDescription }) }
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
      }catch(e){ }
      if(!iceServersRef.current){
        try{
          const res = await fetch(`${API}/api/ice`)
          if(res.ok){ const data = await res.json(); iceServersRef.current = data.iceServers }
        }catch(e){ }
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
  try{ await fetch('/.netlify/functions/proxy/api/rt/answer', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ sdp: pc.localDescription }) }) }catch(e){ socket.emit('webrtc_answer', { sdp: pc.localDescription }) }
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
  function stopRingtone(){
    try{ oscRef.current?.o.stop(); oscRef.current=null; setRinging(false) }catch(e){}
  }

  if(!user) return <Auth onAuth={u=>setUser(u)} />

  return (
    <div className="app">
      <aside className="sidebar">
        <h2>Rodina</h2>
        <ul>
          {users.map(u=> (
            <li key={u.id} className={u.online? 'online':''}>
              <img src={u.avatar||'/assets/default-avatar.png'} alt="avatar" />
              <div>
                <div className="name">{u.name}</div>
                <div className="last">{u.online? 'Online':'Offline'}</div>
              </div>
              <div>
                <button onClick={()=>startCall('video')}>Video</button>
                <button onClick={()=>startCall('audio')}>Hovor</button>
              </div>
            </li>
          ))}
        </ul>
      </aside>
      <main className="chat">
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
          {messages.map(m=> (
            <div key={m.id} className={m.from===user.id? 'me':'them'}>
              {m.type==='image' && <img src={m.url} alt="foto" style={{maxWidth:'60%'}} />}
              {m.type==='video' && <video src={m.url} controls style={{maxWidth:'60%'}} />}
              {m.type==='audio' && <audio src={m.url} controls />}
              {(!m.type || m.type==='text') && <div className="msg-text">{m.text}</div>}
            </div>
          ))}
        </div>
        <div className="composer">
          <input value={text} onChange={e=>setText(e.target.value)} placeholder="Napište zprávu..." />
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

  async function register(e){
    e.preventDefault()
    const form = new FormData()
    form.append('name', name)
    form.append('pin', pin)
    await fetch(`${API}/api/register`, { method: 'POST', body: form })
    const res = await fetch(`${API}/api/login`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, pin })})
    if(res.ok){ const user = await res.json(); onAuth(user) }
  }

  if(stage==='login') return (
    <div className="auth">
      <h2>Přihlášení</h2>
      <form onSubmit={async (e)=>{ e.preventDefault(); const res = await fetch(`${API}/api/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, pin })}); if(res.ok){ onAuth(await res.json()) } else { alert('Chybný PIN nebo uživatel') } }}>
        <input placeholder="Jméno" value={name} onChange={e=>setName(e.target.value)} />
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
        <input type="file" name="avatar" />
        <button type="submit">Vytvořit profil</button>
      </form>
      <p>Máte už profil? <button onClick={()=>setStage('login')}>Přihlásit se</button></p>
    </div>
  )
}
