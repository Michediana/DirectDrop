const DEFAULT_STUN: RTCIceServer = { urls: 'stun:stun.l.google.com:19302' }

export type PeerHandlers = {
  onOpen?: (channel: RTCDataChannel) => void
  onMessage?: (data: string | ArrayBuffer) => void
  onClose?: (channel?: RTCDataChannel) => void
  onIceState?: (state: string) => void
}

export function createPeer(localName: string, handlers: PeerHandlers = {}) {
  const pc = new RTCPeerConnection({ iceServers: [DEFAULT_STUN] })
  let dc: RTCDataChannel | null = null

  const MAX_BUFFER_SIZE = 16 * 1024 * 1024 // 16 MB
  const LOW_WATER_MARK = 256 * 1024 // 256 KB

  const send = (payload: string | ArrayBuffer) => {
    if (dc && dc.readyState === 'open') {
      dc.send(payload)
    } else {
      console.warn('DataChannel not open yet')
    }
  }

  // Invio con controllo del buffer
  const sendWithBackpressure = (payload: string | ArrayBuffer): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (!dc || dc.readyState !== 'open') {
        reject(new Error('DataChannel not open'))
        return
      }

      const trySend = () => {
        if (dc.bufferedAmount > MAX_BUFFER_SIZE) {
          // Buffer pieno, aspetta
          setTimeout(trySend, 50)
        } else {
          try {
            dc.send(payload)
            resolve()
          } catch (e) {
            reject(e)
          }
        }
      }

      trySend()
    })
  }

  // Helper per inviare file in chunk
  const sendFile = async (file: File | Blob, onProgress?: (progress: number) => void): Promise<void> => {
    if (!dc || dc.readyState !== 'open') {
      throw new Error('DataChannel not open')
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
    let chunkIndex = 0

    // Invia metadata prima
    await sendWithBackpressure(JSON.stringify({
      type: 'file-start',
      name: file instanceof File ? file.name : 'blob',
      size: file.size,
      totalChunks
    }))

    // Invia chunk
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      const chunk = file.slice(offset, offset + CHUNK_SIZE)
      const arrayBuffer = await chunk.arrayBuffer()
      
      await sendWithBackpressure(arrayBuffer)
      
      chunkIndex++
      if (onProgress) {
        onProgress((chunkIndex / totalChunks) * 100)
      }
    }

    // Invia segnale di fine
    await sendWithBackpressure(JSON.stringify({
      type: 'file-end'
    }))
  }

  pc.ondatachannel = (evt: RTCDataChannelEvent) => {
    console.log('Received DataChannel:', evt.channel.label)
    dc = evt.channel
    setupChannel(dc)
  }

  pc.oniceconnectionstatechange = () => {
    console.log('ICE state:', pc.iceConnectionState)
    handlers.onIceState && handlers.onIceState(pc.iceConnectionState)
  }

  function setupChannel(channel: RTCDataChannel) {
    console.log('Setting up DataChannel:', channel.label)
    channel.binaryType = 'arraybuffer'
    
    // Imposta la soglia per il buffer
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK
    
    channel.onopen = () => {
      console.log('DataChannel opened:', channel.label)
      handlers.onOpen && handlers.onOpen(channel)
    }
    channel.onclose = () => handlers.onClose && handlers.onClose(channel)
    channel.onmessage = (evt) => handlers.onMessage && handlers.onMessage(evt.data)
    
    // Opzionale: monitor del buffer
    channel.onbufferedamountlow = () => {
      console.log('Buffer low, bufferedAmount:', channel.bufferedAmount)
    }
  }

  async function createOffer(): Promise<string> {
    console.log('Creating DataChannel for offer')
    dc = pc.createDataChannel('file')
    setupChannel(dc)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    await waitForIceGathering(pc)
    console.log('Offer created, SDP length:', pc.localDescription!.sdp.length)
    return pc.localDescription!.sdp
  }

  async function createAnswerFromOffer(offerSdp: string): Promise<string> {
    console.log('Creating answer from offer')
    const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: offerSdp }
    await pc.setRemoteDescription(offer)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    await waitForIceGathering(pc)
    console.log('Answer created, SDP length:', pc.localDescription!.sdp.length)
    return pc.localDescription!.sdp
  }

  async function acceptAnswer(answerSdp: string): Promise<void> {
    const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: answerSdp }
    await pc.setRemoteDescription(answer)
  }

  function addIceCandidate(sdpCandidate: RTCIceCandidateInit | null) {
    if (!sdpCandidate) return
    try {
      pc.addIceCandidate(sdpCandidate)
    } catch (e) {
      console.warn('addIceCandidate error', e)
    }
  }

  function close(): void {
    try { pc.close() } catch { /* ignored */ }
  }

  return {
    pc,
    send, // Per messaggi piccoli
    sendWithBackpressure, // Per dati più grandi
    sendFile, // Helper per file completi
    createOffer,
    createAnswerFromOffer,
    acceptAnswer,
    addIceCandidate,
    close,
  }
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    function check() {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', check)
  })
}

export const CHUNK_SIZE = 16 * 1024 // 16KB