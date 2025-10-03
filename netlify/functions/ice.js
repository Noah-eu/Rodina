exports.handler = async function(event) {
  try{
    const channel = (process.env.XIRSYS_CHANNEL || 'rodina')
    const region = (process.env.XIRSYS_REGION || 'global')
    const username = process.env.XIRSYS_USERNAME || ''
    const secret = process.env.XIRSYS_SECRET || process.env.XIRSYS_API_KEY || ''
    const bearer = process.env.XIRSYS_BEARER || ''

    const url = `https://${region}.xirsys.net/_turn/${encodeURIComponent(channel)}`
    const headers = { 'User-Agent': 'Rodina-Netlify/1.0', 'Accept': 'application/json' }
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`
  else if (username && secret) headers['Authorization'] = 'Basic ' + Buffer.from(`${username}:${secret}`).toString('base64')
  else return { statusCode: 200, body: JSON.stringify({ iceServers: [ { urls: 'stun:stun.l.google.com:19302' } ] }) }

  const resp = await fetch(url, { headers })
  const json = await resp.json().catch(()=>({}))
    if(!resp.ok){
      // Fallback to STUN when Xirsys request fails
      return { statusCode: 200, body: JSON.stringify({ iceServers: [ { urls: 'stun:stun.l.google.com:19302' } ] }) }
    }
    const iceServers = (json && (json.v?.iceServers || json.iceServers || json.d?.iceServers)) || []
    if(!Array.isArray(iceServers)){
      // Fallback to STUN on invalid response
      return { statusCode: 200, body: JSON.stringify({ iceServers: [ { urls: 'stun:stun.l.google.com:19302' } ] }) }
    }
    return { statusCode: 200, body: JSON.stringify({ iceServers }) }
  }catch(e){
    // Fallback to STUN on any unexpected error
    return { statusCode: 200, body: JSON.stringify({ iceServers: [ { urls: 'stun:stun.l.google.com:19302' } ] }) }
  }
}
