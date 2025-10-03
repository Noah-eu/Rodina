exports.handler = async function(event) {
  // Základní proxy z Netlify Functions na náš backend server
  // Vyžadujeme BACKEND_URL. Nepoužíváme VITE_API_URL (mohlo by vést k rekurzi přes functions).
  const API = process.env.BACKEND_URL
  if (!API) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error: 'BACKEND_URL not configured',
        hint: 'Set Netlify env BACKEND_URL to your public backend URL (e.g., https://rodina.onrender.com) and redeploy.'
      })
    }
  }
  if (/\.netlify\/functions/.test(API)) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error: 'Invalid BACKEND_URL: points to Netlify Functions',
        hint: 'BACKEND_URL must point to external backend (e.g., Render), not another Netlify function.'
      })
    }
  }
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
    const ab = await res.arrayBuffer()
    const buf = Buffer.from(ab)
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
