const fetch = require('node-fetch')

exports.handler = async function(event, context) {
  // jednoduché proxování: nastavte env VITE_API_URL na produkční backend
  const API = process.env.VITE_API_URL || 'http://localhost:3001'
  const path = event.path.replace('/.netlify/functions/proxy', '')
  const url = API + path + (event.rawQuery || '')
  const method = event.httpMethod
  const headers = event.headers
  const body = event.body
  try{
    const res = await fetch(url, { method, headers, body })
    const text = await res.text()
    return { statusCode: res.status, body: text }
  }catch(e){
    return { statusCode: 500, body: 'Proxy error: '+e.message }
  }
}
