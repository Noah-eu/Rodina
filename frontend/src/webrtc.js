// Jednoduchý WebRTC helper pro peer connection a signaling přes Socket.IO
export function createPeerConnection({socket, onTrack, onIceCandidate, isCaller=false, iceServers}){
  const pc = new RTCPeerConnection({
    iceServers: iceServers && iceServers.length ? iceServers : [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  })

  pc.onicecandidate = (e)=>{ if(e.candidate) socket.emit('webrtc_ice', { candidate: e.candidate }) }
  pc.ontrack = (e)=> onTrack && onTrack(e.streams[0])

  socket.on('webrtc_offer', async ({sdp})=>{
    await pc.setRemoteDescription(sdp)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    socket.emit('webrtc_answer', { sdp: pc.localDescription })
  })

  socket.on('webrtc_answer', async ({sdp})=>{
    await pc.setRemoteDescription(sdp)
  })

  socket.on('webrtc_ice', async ({candidate})=>{
    try{ await pc.addIceCandidate(candidate) }catch(e){}
  })

  return pc
}
