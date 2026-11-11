// Small, dependency-free WebSocket server for the port PVP mode.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = 8;
const RESPAWN_MS = 3000;
const ROOT = __dirname;
const SPAWNS = [
  [-19, 0, -1.4], [3.5, 0, -1.6], [14.2, 0, 16.4], [-3.2, 0, 16.6],
  [-16, 0, 26], [6, 0, 26], [-12.4, 0, -24.8], [9.6, 0, -25.3],
  [27.7, 0, -24.2], [27.2, 0, -12.6], [23.4, 0, 23.2], [18, 0, 24.4]
];
const rooms = new Map();
let nextId = 1;

function send(client, message) {
  if (client.socket.destroyed) return;
  const data = Buffer.from(JSON.stringify(message));
  const header = data.length < 126 ? Buffer.from([129, data.length])
    : data.length < 65536 ? Buffer.from([129, 126, data.length >> 8, data.length & 255])
    : null;
  if (header) client.socket.write(Buffer.concat([header, data]));
}
function broadcast(room, message, except) {
  for (const c of room.players.values()) if (c !== except) send(c, message);
}
function spawn(room) {
  const occupied = [...room.players.values()].filter(p => p.alive);
  const candidates = SPAWNS.map((pos, index) => ({pos, index,
    distance: occupied.length ? Math.min(...occupied.map(p => Math.hypot(p.pos[0]-pos[0], p.pos[2]-pos[2]))) : 100}));
  candidates.sort((a,b) => b.distance - a.distance);
  const pool = candidates.slice(0, Math.min(4, candidates.length));
  return pool[Math.floor(Math.random() * pool.length)].pos.slice();
}
function join(client, msg) {
  if (client.room) return;
  const roomCode = String(msg.room || 'PORT').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'PORT';
  let room = rooms.get(roomCode);
  if (!room) rooms.set(roomCode, room = {players: new Map()});
  if (room.players.size >= MAX_PLAYERS) return send(client, {type:'error', text:'房间已满（最多 8 人）'});
  client.id = nextId++;
  client.name = String(msg.name || '队员').trim().slice(0, 16) || '队员';
  client.room = room;
  client.roomCode = roomCode;
  client.pos = spawn(room);
  client.yaw = 0; client.pitch = 0;
  client.hp = 100; client.alive = true;
  client.kills = 0; client.deaths = 0; client.lastShot = 0; client.lastHurt = 0;
  room.players.set(client.id, client);
  send(client, {type:'welcome', id:client.id, room:roomCode, pos:client.pos});
  broadcast(room, {type:'notice', text:`${client.name} 加入了房间`}, client);
  console.log(`${roomCode}: ${client.name} joined (${room.players.size})`);
}
function leave(client) {
  if (!client.room) return;
  const room = client.room;
  room.players.delete(client.id);
  broadcast(room, {type:'left', id:client.id, text:`${client.name} 离开了房间`});
  if (!room.players.size) rooms.delete(client.roomCode);
  client.room = null;
}
function finitePosition(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
    && value[0] >= -42 && value[0] <= 42 && value[1] >= -2 && value[1] <= 14
    && value[2] >= -33 && value[2] <= 33;
}
function handle(client, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'join') return join(client, msg);
  if (!client.room) return;
  if (msg.type === 'state' && client.alive) {
    if (finitePosition(msg.pos)) client.pos = msg.pos;
    if (Number.isFinite(msg.yaw)) client.yaw = Math.max(-10000, Math.min(10000, msg.yaw));
    if (Number.isFinite(msg.pitch)) client.pitch = Math.max(-1.6, Math.min(1.6, msg.pitch));
    return;
  }
  if (msg.type === 'shot' && client.alive) {
    const now = Date.now();
    if (now - client.lastShot < 85) return;
    client.lastShot = now;
    const target = client.room.players.get(Number(msg.target));
    // The client checks walls; the server also checks target proximity and shot cadence.
    if (target && target !== client && target.alive && Array.isArray(msg.origin) && Array.isArray(msg.dir)
      && msg.origin.length === 3 && msg.dir.length === 3
      && [...msg.origin, ...msg.dir].every(Number.isFinite)) {
      const origin = msg.origin, dir = msg.dir;
      const eyeDistance = Math.hypot(origin[0]-client.pos[0], origin[1]-(client.pos[1]+1.55), origin[2]-client.pos[2]);
      const len = Math.hypot(...dir);
      const to = [target.pos[0]-origin[0], target.pos[1]+0.9-origin[1], target.pos[2]-origin[2]];
      const along = (to[0]*dir[0]+to[1]*dir[1]+to[2]*dir[2]) / (len || 1);
      const miss = Math.sqrt(Math.max(0, to.reduce((a,v)=>a+v*v,0)-along*along));
      if (eyeDistance < 2.2 && len > .9 && len < 1.1 && along > 0 && along < 120 && miss < 1.15) {
        target.hp = Math.max(0, target.hp - 28);
        target.lastHurt = now;
        send(target, {type:'hurt', hp:target.hp, by:client.name});
        send(client, {type:'hit', target:target.id, hp:target.hp});
        if (!target.hp) {
          target.alive = false; target.deaths++; client.kills++;
          broadcast(client.room, {type:'kill', killer:client.name, victim:target.name});
          setTimeout(() => {
            if (!target.room || target.alive) return;
            target.pos = spawn(target.room); target.hp = 100; target.alive = true;
            send(target, {type:'respawn', pos:target.pos, hp:100});
          }, RESPAWN_MS);
        }
      }
    }
    broadcast(client.room, {type:'fire', id:client.id, origin:msg.origin, dir:msg.dir}, client);
  }
}
function receive(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const b = client.buffer;
    const opcode = b[0] & 15, masked = !!(b[1] & 128);
    let length = b[1] & 127, offset = 2;
    if (!masked) return client.socket.destroy();
    if (length === 126) { if (b.length < 4) return; length = b.readUInt16BE(2); offset = 4; }
    if (length === 127) return client.socket.destroy();
    if (length > 8192) return client.socket.destroy();
    if (b.length < offset + 4 + length) return;
    const mask = b.subarray(offset, offset+4), data = Buffer.from(b.subarray(offset+4, offset+4+length));
    for (let i=0;i<data.length;i++) data[i] ^= mask[i & 3];
    client.buffer = b.subarray(offset+4+length);
    if (opcode === 8) return client.socket.end();
    if (opcode === 9) { client.socket.write(Buffer.from([0x8a,0])); continue; }
    if (opcode !== 1) continue;
    try { handle(client, JSON.parse(data.toString('utf8'))); } catch {}
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const files = {'/':'pvp.html','/pvp.html':'pvp.html','/pvp-client.js':'pvp-client.js'};
  const file = files[url.pathname];
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  const full = path.join(ROOT, file);
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(500); return res.end('File unavailable'); }
    res.writeHead(200, {'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8',
      'Cache-Control':'no-store'});
    res.end(data);
  });
});
server.on('upgrade', (req, socket) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/ws'
    || req.headers.upgrade?.toLowerCase() !== 'websocket'
    || !req.headers['sec-websocket-key']) return socket.destroy();
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const client = {socket, buffer:Buffer.alloc(0), room:null};
  socket.on('data', chunk => receive(client, chunk));
  socket.on('close', () => leave(client));
  socket.on('error', () => leave(client));
});
setInterval(() => {
  for (const [code, room] of rooms) {
    const now = Date.now();
    for (const p of room.players.values()) if (p.alive && p.hp < 100 && now-p.lastHurt > 4000)
      p.hp = Math.min(100, p.hp + 1.25);
    const players = [...room.players.values()].map(p => ({id:p.id, name:p.name, pos:p.pos,
      yaw:p.yaw, pitch:p.pitch, hp:p.hp, alive:p.alive, kills:p.kills, deaths:p.deaths}));
    broadcast(room, {type:'snapshot', players});
  }
}, 50);
server.listen(PORT, HOST, () => console.log(`PVP server: http://localhost:${PORT} (${HOST})`));
