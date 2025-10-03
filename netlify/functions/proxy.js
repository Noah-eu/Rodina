const fetch = require('node-fetch')

exports.handler = async function(event) {
  // Základní proxy z Netlify Functions na náš backend server
  // Prefer BACKEND_URL, fallback VITE_API_URL, jinak localhost
  const API = process.env.BACKEND_URL || process.env.VITE_API_URL || 'http://localhost:3001'
  let path = event.path.replace('/.netlify/functions/proxy', '')
  // ochrana: nesmíme proxovat zpět do Functions
  if (path.startsWith('/.netlify/functions')) {
    return { statusCode: 400, body: 'Invalid target path' }
  }
  const qs = event.rawQuery ? `?${event.rawQuery}` : ''
  const url = API + path + qs
  const method = event.httpMethod
  // Odstranit hlavičky, které nemají být přeposílány (Netlify-specific)
  const { host, connection, 'content-length': contentLength, ...rest } = event.headers || {}
  const headers = { ...rest }
  const isBase64 = event.isBase64Encoded
  const body = event.body ? (isBase64 ? Buffer.from(event.body, 'base64') : event.body) : undefined
  try{
    const res = await fetch(url, { method, headers, body })
    const buf = await res.buffer()
    const contentType = res.headers.get('content-type') || 'application/octet-stream'
    return {
      statusCode: res.status,
      headers: { 'content-type': contentType },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    }
  }catch(e){
    return { statusCode: 500, body: 'Proxy error: '+e.message }
  }
}
