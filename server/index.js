#!/usr/bin/env node
/* eslint-env node */
import http from 'http'
import WebSocket, { WebSocketServer } from 'ws'

const PORT = globalThis?.process?.env?.PORT || 3000

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('WebRTC signaling server (ws)')
})

const wss = new WebSocketServer({ server })

// clients: id -> { id, name, ws }
const clients = new Map()
const usedIds = new Set()

function broadcastClients() {
  const list = [...clients.values()].map(c => ({ id: c.id, name: c.name }))
  const msg = JSON.stringify({ type: 'clients', clients: list })
  for (const c of clients.values()) {
    try { c.ws.send(msg) } catch { /* ignore */ }
  }
}

function assignID() {
  let id
  do {
    id = Math.floor(Math.random() * 900000) + 100000 // 100000 to 999999
  } while (usedIds.has(id))
  usedIds.add(id)
  return id
}

wss.on('connection', (socket) => {
  let rid = null

  socket.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'join') {
        rid = assignID()
        clients.set(rid, { id: rid, name: msg.name, ws: socket })
        console.clear()
        console.log(clients.size, 'clients connected')
        //console.log('join', rid, msg.name)
        socket.send(JSON.stringify({ type: 'assigned', id: rid }))
        broadcastClients()
        return
      }

      if (msg.type === 'leave') {
        if (msg.id) {
          clients.delete(msg.id)
          usedIds.delete(msg.id)
        }
        console.clear()
        console.log(clients.size, 'clients connected')
        rid = null
        broadcastClients()
        return
      }

      // forward offer / answer by 'to'
      if ((msg.type === 'offer' || msg.type === 'answer') && msg.to) {
        const dest = clients.get(msg.to)
        if (dest && dest.ws && dest.ws.readyState === WebSocket.OPEN) {
          dest.ws.send(JSON.stringify({ type: msg.type, from: msg.from, sdp: msg.sdp }))
        }
        return
      }

      // forward ice candidate
      if (msg.type === 'candidate' && msg.to) {
        const dest = clients.get(msg.to)
        if (dest && dest.ws && dest.ws.readyState === WebSocket.OPEN) {
          dest.ws.send(JSON.stringify({ type: 'candidate', from: msg.from, candidate: msg.candidate }))
        }
        return
      }

      // optional: ping/pong
      if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }))
      }
    } catch (e) {
      console.warn('bad message', e)
    }
  })

  socket.on('close', () => {
    if (rid) {
      clients.delete(rid)
      usedIds.delete(rid)
      console.clear()
      console.log(clients.size, 'clients connected')
      broadcastClients()
    }
  })
})

server.listen(PORT, () => {
  console.log('Signaling server listening on port', PORT)
})
