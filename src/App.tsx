import { useRef, useState, useEffect } from 'react'
import { createPeer, CHUNK_SIZE } from './webrtc'

export default function App() {
  const [connections, setConnections] = useState<Record<number, ReturnType<typeof createPeer> & { isDataChannelOpen: boolean }>>({})
  const connectionsRef = useRef<Record<number, ReturnType<typeof createPeer> & { isDataChannelOpen: boolean }>>({})
  const [clients, setClients] = useState([])
  const [myID, setMyID] = useState(null)
  const myIDRef = useRef<number | null>(null)
  const [receivedFiles, setReceivedFiles] = useState<Record<number, { name: string, size: number, chunks: ArrayBuffer[] }>>({})
  const [sendingProgress, setSendingProgress] = useState<Record<number, number>>({})
  const abortControllersRef = useRef<Record<number, AbortController>>({})
  const wsRef = useRef(null)

  useEffect(() => {
    const WSS = new WebSocket("ws://192.168.188.10:3000");
    wsRef.current = WSS

    WSS.onopen = () => {
      WSS.send(JSON.stringify({ type: "join" }))
    }

    WSS.onmessage = (message) => {
      const data = JSON.parse(message.data)
      switch (data.type) {
        case "assigned":
          setMyID(data.id)
          myIDRef.current = data.id
          break
        case "clients":
          setClients(data.clients)
          break
        case "offer":
          console.log("Received offer from ", data.from)
          if (data.from) connectFromPeer(data.from, data.sdp)
          break
        case "answer":
          console.log("Received answer from ", data.from)
          if (data.from && connectionsRef.current[data.from]) {
            connectionsRef.current[data.from].acceptAnswer(data.sdp)
          }
          break
        case "candidate":
          console.log("Received candidate from ", data.from)
          if (data.from && connectionsRef.current[data.from]) {
            connectionsRef.current[data.from].addIceCandidate(data.candidate)
          }
          break
        default:
          break
      }
    }

    return () => {
      if (WSS) {
        WSS.close()
      }
      Object.values(connectionsRef.current).forEach(peer => peer.close())
      // Cancella tutti i trasferimenti in corso
      Object.values(abortControllersRef.current).forEach(controller => controller.abort())
    }
  }, [])

  function connectToPeer(peerID: number) {
    const peer = createPeer('local', {
      onOpen: (channel) => {
        console.log('DataChannel open with', peerID)
        connectionsRef.current[peerID] = { ...connectionsRef.current[peerID], isDataChannelOpen: true }
        setConnections(prev => ({ ...prev, [peerID]: { ...prev[peerID], isDataChannelOpen: true } }))
      },
      onMessage: (data) => handleReceivedData(peerID, data),
      onClose: () => {
        console.log('DataChannel closed with', peerID)
        if (connectionsRef.current[peerID]) {
          connectionsRef.current[peerID].close()
          delete connectionsRef.current[peerID]
          setConnections(prev => {
            const newConns = { ...prev }
            delete newConns[peerID]
            return newConns
          })
        }
      },
      onIceState: (state) => console.log('ICE state with', peerID, state),
    })

    peer.pc.onicecandidate = (event) => {
      if (event.candidate && myIDRef.current) {
        wsRef.current.send(JSON.stringify({ type: "candidate", from: myIDRef.current, to: peerID, candidate: event.candidate }))
      }
    }

    const peerWithState = { ...peer, isDataChannelOpen: false }
    connectionsRef.current[peerID] = peerWithState
    setConnections(prev => ({ ...prev, [peerID]: peerWithState }))

    peer.createOffer().then(offerSdp => {
      wsRef.current.send(JSON.stringify({ type: "offer", from: myIDRef.current, to: peerID, sdp: offerSdp }))
    })
  }

  function connectFromPeer(peerID: number, offerSdp: string) {
    const peer = createPeer('remote', {
      onOpen: (channel) => {
        console.log('DataChannel open with', peerID)
        connectionsRef.current[peerID] = { ...connectionsRef.current[peerID], isDataChannelOpen: true }
        setConnections(prev => ({ ...prev, [peerID]: { ...prev[peerID], isDataChannelOpen: true } }))
      },
      onMessage: (data) => handleReceivedData(peerID, data),
      onClose: () => {
        console.log('DataChannel closed with', peerID)
        if (connectionsRef.current[peerID]) {
          connectionsRef.current[peerID].close()
          delete connectionsRef.current[peerID]
          setConnections(prev => {
            const newConns = { ...prev }
            delete newConns[peerID]
            return newConns
          })
        }
      },
      onIceState: (state) => console.log('ICE state with', peerID, state),
    })

    peer.pc.onicecandidate = (event) => {
      if (event.candidate && myIDRef.current) {
        wsRef.current.send(JSON.stringify({ type: "candidate", from: myIDRef.current, to: peerID, candidate: event.candidate }))
      }
    }

    const peerWithState = { ...peer, isDataChannelOpen: false }
    connectionsRef.current[peerID] = peerWithState
    setConnections(prev => ({ ...prev, [peerID]: peerWithState }))

    peer.createAnswerFromOffer(offerSdp).then(answerSdp => {
      wsRef.current.send(JSON.stringify({ type: "answer", from: myIDRef.current, to: peerID, sdp: answerSdp }))
    })
  }

  function handleReceivedData(peerID: number, data: string | ArrayBuffer) {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data)
        if (msg.type === 'file-start') {
          setReceivedFiles(prev => ({
            ...prev,
            [peerID]: { name: msg.name, size: msg.size, chunks: [] }
          }))
        } else if (msg.type === 'file-end') {
          setReceivedFiles(prev => {
            const fileData = prev[peerID]
            if (fileData) {
              const blob = new Blob(fileData.chunks)
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = fileData.name
              a.click()
              URL.revokeObjectURL(url)
              
              const newFiles = { ...prev }
              delete newFiles[peerID]
              return newFiles
            }
            return prev
          })
        } else if (msg.type === 'file-cancelled') {
          // Il mittente ha cancellato il trasferimento
          console.log('File transfer cancelled by sender')
          setReceivedFiles(prev => {
            const newFiles = { ...prev }
            delete newFiles[peerID]
            return newFiles
          })
        }
      } catch (e) {
        console.log('Received string message:', data)
      }
    } else {
      // ArrayBuffer chunk
      setReceivedFiles(prev => {
        const fileData = prev[peerID]
        if (fileData) {
          return {
            ...prev,
            [peerID]: { ...fileData, chunks: [...fileData.chunks, data] }
          }
        }
        return prev
      })
    }
  }

  async function sendFileToPeer(peerID: number) {
    const peer = connectionsRef.current[peerID]
    if (!peer || !peer.isDataChannelOpen) {
      alert('DataChannel not open yet. Please wait for the connection to establish.')
      return
    }

    const fileInput = document.getElementById(`file_to_peer_${peerID}`) as HTMLInputElement
    if (fileInput.files.length === 0) {
      alert('Please select a file first')
      return
    }

    const file = fileInput.files[0]
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
    console.log(`Sending file "${file.name}" in ${totalChunks} chunks to peer ${peerID}`)

    // Crea un AbortController per questo trasferimento
    const abortController = new AbortController()
    abortControllersRef.current[peerID] = abortController
    
    // Helper per inviare con controllo del buffer
    const sendWithBackpressure = (data: string | ArrayBuffer): Promise<void> => {
      return new Promise((resolve, reject) => {
        // Controlla se il trasferimento è stato cancellato
        if (abortController.signal.aborted) {
          reject(new Error('Transfer cancelled'))
          return
        }

        const trySend = () => {
          // Controlla di nuovo se cancellato
          if (abortController.signal.aborted) {
            reject(new Error('Transfer cancelled'))
            return
          }

          try {
            peer.send(data)
            resolve()
          } catch (e) {
            if (e.message && e.message.includes('send queue is full')) {
              // Buffer pieno, riprova tra poco
              setTimeout(trySend, 50)
            } else {
              reject(e)
            }
          }
        }
        trySend()
      })
    }

    try {
      // Send file start
      await sendWithBackpressure(JSON.stringify({ 
        type: 'file-start', 
        name: file.name, 
        size: file.size,
        totalChunks 
      }))

      // Send chunks
      for (let i = 0; i < totalChunks; i++) {
        // Controlla se il trasferimento è stato cancellato
        if (abortController.signal.aborted) {
          throw new Error('Transfer cancelled by user')
        }

        const start = i * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, file.size)
        const blob = file.slice(start, end)
        const arrayBuffer = await blob.arrayBuffer()
        
        await sendWithBackpressure(arrayBuffer)
        
        // Update progress
        const progress = ((i + 1) / totalChunks) * 100
        setSendingProgress(prev => ({ ...prev, [peerID]: progress }))
        
        console.log(`Sent chunk ${i + 1}/${totalChunks} (${progress.toFixed(1)}%)`)
      }

      // Send file end
      await sendWithBackpressure(JSON.stringify({ type: 'file-end' }))
      
      console.log('File sent successfully!')
      setSendingProgress(prev => {
        const newProgress = { ...prev }
        delete newProgress[peerID]
        return newProgress
      })
      
      // Rimuovi l'AbortController
      delete abortControllersRef.current[peerID]
      
    } catch (error) {
      console.error('Error sending file:', error)
      
      if (error.message === 'Transfer cancelled by user') {
        // Notifica il destinatario che il trasferimento è stato cancellato
        try {
          peer.send(JSON.stringify({ type: 'file-cancelled' }))
        } catch (e) {
          console.warn('Could not send cancellation message:', e)
        }
        console.log('File transfer cancelled')
      } else {
        alert('Error sending file: ' + error.message)
      }
      
      setSendingProgress(prev => {
        const newProgress = { ...prev }
        delete newProgress[peerID]
        return newProgress
      })
      
      // Rimuovi l'AbortController
      delete abortControllersRef.current[peerID]
    }
  }

  function stopSendFileToPeer(peerID: number) {
    const controller = abortControllersRef.current[peerID]
    if (controller) {
      console.log('Stopping file transfer to peer', peerID)
      controller.abort()
    }
  }

  return (
    <div className="App">
      <h1>LOCAL DROP</h1>
      <h2>Your ID: {myID}</h2>
      <h3>Available Clients:</h3>
      <ul>
        {clients.map((client) => (
          client.id !== myID &&
          <li key={client.id}>
            {client.id} <a onClick={() => connectToPeer(client.id)}>CONNETTI</a>
          </li>
        ))}
      </ul>
      <h3>Active Connections:</h3>
      <ul>
        {Object.keys(connections).map((key) => {
          const peerID = parseInt(key)
          const progress = sendingProgress[peerID]
          return (
            <li key={key}>
              {key} | 
              <input type='file' id={`file_to_peer_${key}`} disabled={!!progress} />
              <a onClick={() => !progress && sendFileToPeer(peerID)} style={{ cursor: progress ? 'not-allowed' : 'pointer' }}>
                {progress ? `INVIO... ${progress.toFixed(1)}%` : 'INVIA FILE'}
              </a>
              {progress && (<a onClick={() => {stopSendFileToPeer(peerID)}} style={{ marginLeft: '10px', cursor: 'pointer', color: 'red' }}>STOP</a>)}
            </li>
          )
        })}
      </ul>
      {Object.keys(receivedFiles).length > 0 && (
        <div>
          <h3>Receiving Files:</h3>
          <ul>
            {Object.entries(receivedFiles).map(([peerID, fileData]) => {
              const received = fileData.chunks.reduce((acc, chunk) => acc + chunk.byteLength, 0)
              const progress = (received / fileData.size) * 100
              return (
                <li key={peerID}>
                  DA {peerID}: {fileData.name} - {progress.toFixed(1)}% ({received} / {fileData.size} bytes)
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}