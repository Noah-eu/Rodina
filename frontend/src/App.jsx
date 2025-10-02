import React, { useEffect, useState } from 'react'
import axios from 'axios'
import io from 'socket.io-client'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const socket = io(API)

export default function App(){
  const [user, setUser] = useState(null)
  const [users, setUsers] = useState([])
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')

  useEffect(()=>{
    fetchUsers()
    socket.on('message', msg => setMessages(m => [...m, msg]))
    socket.on('presence', p => setUsers(u => u.map(us => us.id===p.id?{...us, online:p.online}:us)))
  }, [])

  useEffect(()=>{
    if (user) socket.emit('registerSocket', user.id)
  }, [user])

  async function fetchUsers(){
    const res = await axios.get(`${API}/api/users`)
    setUsers(res.data)
  }

  async function send(){
    if(!user) return alert('Přihlašte se')
    await axios.post(`${API}/api/message`, { from: user.id, text })
    setText('')
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
            </li>
          ))}
        </ul>
      </aside>
      <main className="chat">
        <div className="messages">
          {messages.map(m=> (
            <div key={m.id} className={m.from===user.id? 'me':'them'}>
              <div className="msg-text">{m.text}</div>
            </div>
          ))}
        </div>
        <div className="composer">
          <input value={text} onChange={e=>setText(e.target.value)} placeholder="Napište zprávu..." />
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
