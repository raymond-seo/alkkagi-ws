// server.js (CommonJS)

// ========================================================
// 1. 초기 설정
// ========================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// === 세션 미들웨어 ===
const cookieSession = require('cookie-session');
const axios = require('axios');
const crypto = require('crypto');

// === Firestore ===
const admin = require('firebase-admin');
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:  process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

app.set('trust proxy', 1);

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || 'https://mellow-parfait-132923.netlify.app';
app.use(cors({ origin: [ALLOW_ORIGIN], credentials: true }));

app.use(express.json());
app.use(cookieSession({
  name: 'sid',
  secret: process.env.SESSION_SECRET,
  httpOnly: true,
  sameSite: 'none',
  secure: true,
  maxAge: 1000 * 60 * 60 * 24 * 7,
}));

// === 내 정보 (세션 + Firestore) ===
app.get('/api/me', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ ok:false, error:'NO_SESSION' });
  const { id, name } = req.session.user; // toss/exchange에서 저장한 필드

  try {
    const snap = await db.collection('users').doc(id).get();
    const base = snap.exists ? snap.data() : { rating:1000, wins:0, losses:0 };
    return res.json({ ok:true, id, name, ...base });
  } catch (e) {
    console.error('/api/me error', e);
    return res.status(500).json({ ok:false });
  }
});

// === 앱인토스: 인가코드 교환 → 이름 복호화 → 세션 저장 ===
app.post('/api/toss/exchange', async (req, res) => {
  try {
    const { authorizationCode, referrer } = req.body || {};
    if (!authorizationCode || !referrer) {
      return res.status(400).json({ error: 'BAD_REQUEST' });
    }

    // 1) 토큰 발급
    const tokenResp = await axios.post(
      'https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/user/oauth2/generate-token',
      { authorizationCode, referrer },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const tok = tokenResp.data?.success || tokenResp.data; // 가이드 포맷 맞춤
    const accessToken = tok?.accessToken;
    if (!accessToken) throw new Error('NO_ACCESS_TOKEN');

    // 2) 유저 정보 조회 (암호화된 필드)
    const meResp = await axios.get(
      'https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/user/oauth2/login-me',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const me = meResp.data?.success || meResp.data;
    const userKey = me.userKey;
    // 암호화된 이름 복호화
    const nameEnc = me.name; // "ENCRYPTED_VALUE"
    const name = nameEnc ? decryptTossField(nameEnc) : '토스유저';

    // 세션 저장 (필요하면 accessToken/refreshToken도 넣어두면 재발급 가능)
    req.session.user = { id: String(userKey || '0'), name };
    return res.json(req.session.user);
  } catch (e) {
    console.error('toss exchange error:', e?.response?.data || e.message);
    return res.status(500).json({ error: 'EXCHANGE_FAILED' });
  }
});

// === AES-256-GCM 복호화 ===
// 토스 가이드: 암호문(베이스64) 앞부분에 IV/Nonce 포함, AAD 제공
function decryptTossField(b64) {
  const keyB64 = process.env.TOSS_DECRYPTION_KEY_B64;
  const aadStr = process.env.TOSS_AAD || 'TOSS';
  if (!keyB64) throw new Error('NO_DECRYPTION_KEY');

  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);                  // 일반적으로 GCM IV 12바이트
  const tag = buf.subarray(buf.length - 16);       // GCM AuthTag 16바이트
  const data = buf.subarray(12, buf.length - 16);  // 실제 암호문

  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  if (aadStr) decipher.setAAD(Buffer.from(aadStr, 'utf8'));
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  return out.toString('utf8');
}


// === 결과 반영(서버 권위) ===
// body: { win: boolean }
app.post('/api/reportResult', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ ok:false, error:'NO_SESSION' });
  const { id, name } = req.session.user;
  const win = !!req.body.win;

  try {
    const ref = db.collection('users').doc(id);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur  = snap.exists ? snap.data() : { rating:1000, wins:0, losses:0, name };
      const next = {
        name,
        wins:   (cur.wins||0)   + (win ? 1 : 0),
        losses: (cur.losses||0) + (win ? 0 : 1),
        rating: Math.max(0, (cur.rating||1000) + (win ? 15 : -7)),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      tx.set(ref, next, { merge: true });
      return next;
    });

    res.json({ ok:true, rating:result.rating, wins:result.wins, losses:result.losses });
  } catch (e) {
    console.error('/api/reportResult error', e);
    res.status(500).json({ ok:false });
  }
});

// === 추가: 리더보드/등급(상대평가) ===
function tierByPercentile(pct){ // 0~100 (작을수록 상위)
  if (pct <= 1)  return 'CHALLENGER';
  if (pct <= 5)  return 'DIAMOND';
  if (pct <= 15) return 'PLATINUM';
  if (pct <= 35) return 'GOLD';
  if (pct <= 65) return 'SILVER';
  return 'BRONZE';
}

app.get('/api/leaderboard/me', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ ok:false, error:'NO_SESSION' });
  const { id } = req.session.user;

  try {
    // 내 점수
    const meDoc = await db.collection('users').doc(id).get();
    const me = meDoc.exists ? meDoc.data() : { rating:1000, wins:0, losses:0 };

    // 총 유저 수 (Aggregation)
    const totalAgg = await db.collection('users').count().get();
    const total = totalAgg.data().count || 1;

    // 나보다 점수 높은 사람 수 → 랭크 = higher + 1
    const higherAgg = await db.collection('users')
      .where('rating', '>', me.rating || 1000)
      .count()
      .get();
    const higher = higherAgg.data().count || 0;
    const rank = higher + 1;

    const percentile = Math.round((rank - 1) / total * 100); // 0% = 1등
    const tier = tierByPercentile(percentile);

    // 상위 50명 스냅샷
    const topSnap = await db.collection('users')
      .orderBy('rating', 'desc')
      .limit(50)
      .get();
    const snapshot = topSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    res.json({ ok:true, rank, total, percentile, tier, snapshot });
  } catch (e) {
    console.error('/api/leaderboard/me error', e);
    res.status(500).json({ ok:false });
  }
});


// --- Admin 보호 미들웨어 ---
function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || req.query.token;
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ ok:false, error:'FORBIDDEN' });
  }
  next();
}

// 방 목록 조회
app.get('/api/admin/rooms', requireAdmin, (req, res) => {
  const list = Object.values(gameRooms).map(roomPublic);
  res.json({ ok:true, rooms: list });
});

// 방 이름 변경
app.patch('/api/admin/rooms/:id/rename', requireAdmin, express.json(), (req, res) => {
  const id = req.params.id;
  const room = gameRooms[id];
  if (!room) return res.status(404).json({ ok:false, error:'NOT_FOUND' });

  const { clean, blocked } = sanitizeText(req.body?.name, room.name);
  room.name = clean;
  io.to(id).emit('updateRoom', roomPublic(room));
  broadcastRooms();
  res.json({ ok:true, name: room.name, wasBlocked: blocked });
});

// 방 강제 삭제 (내보내기 + 삭제)
app.delete('/api/admin/rooms/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const room = gameRooms[id];
  if (!room) return res.status(404).json({ ok:false, error:'NOT_FOUND' });

  io.to(id).emit('errorMsg', '운영자에 의해 방이 종료되었습니다.');
  io.socketsLeave(id);           // 모든 소켓을 방에서 빼기
  delete gameRooms[id];
  broadcastRooms();
  res.json({ ok:true });
});


// Netlify 도메인만 허용 (필요하면 프리뷰 도메인 추가 가능)

app.get('/health', (req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: [ALLOW_ORIGIN], methods: ['GET', 'POST'] }
});

// 게임 상수
const BOARD_W = 360;
const BOARD_H = 640;
const STONE_RADIUS = 18;
const FRICTION = 0.985;

// --- Moderation utils (욕설/금칙어) ---
const BAD_WORDS = [
  'fuck','shit','bitch','asshole','dick','cunt',
  '좆','씨발','시발','개새','개새끼','병신','ㅅㅂ','ㅈ같','꺼져','자지', '보지', 'ㅄ'
];

// 공통 정화: 공백/특수문자 처리 + 금칙어 * 마스킹
function sanitizeText(raw, fallback='무제 방') {
  const str = (raw || '').toString().trim().slice(0, 20);
  if (!str) return { clean: fallback, blocked: false };

  const lower = str.toLowerCase().replace(/\s+/g, '');
  let blocked = false;
  for (const w of BAD_WORDS) {
    if (!w) continue;
    const t = w.toLowerCase().replace(/\s+/g, '');
    if (t && lower.includes(t)) { blocked = true; break; }
  }

  if (blocked) {
    // 완전 차단 대신 마스킹하고 싶으면 여기서 처리
    return { clean: fallback, blocked: true };
  }
  return { clean: str, blocked: false };
}


// --- 로비/방 목록용 유틸 ---
const clients = new Map(); // socket.id -> { name }
const roomPublic = (r) => ({
  id: r.id,
  name: r.name,
  slots: r.players.length,
  status: r.gameState ? 'playing' : 'waiting',
  players: r.players.map(p => ({ id: p.id, name: p.name, ready: !!p.ready })),
});
const broadcastRooms = () => {
  const list = Object.values(gameRooms).map(roomPublic);
  io.emit('roomsUpdate', list);
};



// 전역 상태(메모리) — 단일 인스턴스 기준 데모
const gameRooms = {}; // roomId -> { id, name, players:[{id,name,ready}], gameState, simulationInterval }

// ========================================================
// 2. 게임 로직
// ========================================================
function startGame(roomId) {
  const room = gameRooms[roomId];
  if (!room || room.players.length !== 2) return;

  console.log(`[게임 시작] ${roomId}`);

  room.gameState = {
    stones: [],
    turn: Math.round(Math.random()), // 0 or 1
    players: [
      { id: room.players[0].id, isCat: true },
      { id: room.players[1].id, isCat: false }
    ]
  };

   // 초기 말 배치(클라와 동일 레이아웃)
   let stoneId = 0;
   const cols = 3, gap = 52, offY = 120;
   // 고양이(상단)
   for (let i = 0; i < 5; i++) {
     const x = BOARD_W * 0.5 + (i % cols - 1) * gap;
     const y = offY + Math.floor(i / cols) * gap;
     room.gameState.stones.push({
       id: stoneId++, ownerIndex: 0, isCat: true,
       x, y, vx: 0, vy: 0, radius: STONE_RADIUS
     });
   }
   // 강아지(하단)
   for (let i = 0; i < 5; i++) {
     const x = BOARD_W * 0.5 + (i % cols - 1) * gap;
     const y = BOARD_H - offY - Math.floor(i / cols) * gap;
     room.gameState.stones.push({
       id: stoneId++, ownerIndex: 1, isCat: false,
       x, y, vx: 0, vy: 0, radius: STONE_RADIUS
     });
   }

  // 플레이어들에게 시작 브로드캐스트
  room.players.forEach((p, idx) => {
    io.to(p.id).emit('gameStart', {
      gameState: room.gameState,
      playerIndex: idx
    });
  });
  broadcastRooms();
}

function runSimulation(roomId) {
  const room = gameRooms[roomId];
  if (!room || room.simulationInterval) return;

  room.simulationInterval = setInterval(() => {
    const { stones } = room.gameState;
    let isMoving = false;

    // 1) 이동/마찰
    stones.forEach(s => {
      s.x += s.vx;
      s.y += s.vy;
      s.vx *= FRICTION;
      s.vy *= FRICTION;
      if (Math.abs(s.vx) < 0.05) s.vx = 0;
      if (Math.abs(s.vy) < 0.05) s.vy = 0;
      if (s.vx !== 0 || s.vy !== 0) isMoving = true;
    });

    // 2) 충돌 (간단)
    for (let i = 0; i < stones.length; i++) {
      for (let j = i + 1; j < stones.length; j++) {
        const s1 = stones[i], s2 = stones[j];
        const dx = s2.x - s1.x, dy = s2.y - s1.y;
        const dist = Math.hypot(dx, dy);
        const min = s1.radius + s2.radius;
        if (dist < min && dist > 0) {
          const angle = Math.atan2(dy, dx);
          const sin = Math.sin(angle), cos = Math.cos(angle);

          let vx1 = s1.vx * cos + s1.vy * sin;
          let vy1 = s1.vy * cos - s1.vx * sin;
          let vx2 = s2.vx * cos + s2.vy * sin;
          let vy2 = s2.vy * cos - s2.vx * sin;

          // 속도 교환
          [vx1, vx2] = [vx2, vx1];

          s1.vx = vx1 * cos - vy1 * sin;
          s1.vy = vy1 * cos + vx1 * sin;
          s2.vx = vx2 * cos - vy2 * sin;
          s2.vy = vy2 * cos + vx2 * sin;

          // 겹침 해결
          const overlap = min - dist;
          s1.x -= (overlap / 2) * cos;
          s1.y -= (overlap / 2) * sin;
          s2.x += (overlap / 2) * cos;
          s2.y += (overlap / 2) * sin;
        }
      }
    }

  // 3) 직사각형 보드 밖 제거 (반지름 여유 포함)
  room.gameState.stones = stones.filter(s => {
    return (
      s.x >= -s.radius &&
      s.x <= BOARD_W + s.radius &&
      s.y >= -s.radius &&
      s.y <= BOARD_H + s.radius
    );
  });

    // 4) 상태 방송
    io.to(roomId).emit('gameStateUpdate', room.gameState.stones);

    // 5) 모두 정지 → 승패/턴
    if (!isMoving) {
      clearInterval(room.simulationInterval);
      room.simulationInterval = null;

      const catCnt = room.gameState.stones.filter(s => s.isCat).length;
      const dogCnt = room.gameState.stones.filter(s => !s.isCat).length;

      if (catCnt === 0 || dogCnt === 0) {
        const winnerIndex = catCnt === 0
          ? room.gameState.players.findIndex(p => !p.isCat)
          : room.gameState.players.findIndex(p => p.isCat);
        io.to(roomId).emit('gameOver', winnerIndex);
        delete gameRooms[roomId];
        broadcastRooms();
      } else {
        room.gameState.turn = 1 - room.gameState.turn;
        io.to(roomId).emit('turnChange', room.gameState);
      }
    }
  }, 1000 / 60);
}

// 소켓이 어떤 방에 들어가 있든 정리 + 필요시 상대에게 gameOver
function removeFromAnyRooms(socketId){
  for (const roomId in gameRooms){
    const room = gameRooms[roomId];
    const idx = room.players.findIndex(p => p.id === socketId);
    if (idx !== -1){
      const oppIdx = 1 - idx;

      // 게임 진행 중이었으면 남은 쪽 승리 처리
      if (room.gameState && room.players[oppIdx]) {
        io.to(room.players[oppIdx].id).emit('gameOver', oppIdx);
      }

      // 방에서 제거
      room.players.splice(idx, 1);
      io.socketsLeave(roomId);

      // 방 비면 삭제, 아니면 상태 브로드캐스트
      if (room.players.length === 0) {
        delete gameRooms[roomId];
      } else {
        io.to(roomId).emit('updateRoom', roomPublic(room));
      }
      broadcastRooms();
      // 한 방만 있을 수 있으니 바로 종료
      return;
    }
  }
}

// ========================================================
// 3. 소켓 이벤트
// ========================================================
io.on('connection', (socket) => {
  console.log('[연결]', socket.id);

  socket.on('setName', (name) => {
    const { clean, blocked } = sanitizeText(name, '플레이어');
    clients.set(socket.id, { name: clean + (blocked ? '⚠️' : '') });
  });

  socket.on('listRooms', () => {
    const list = Object.values(gameRooms).map(roomPublic);
    socket.emit('rooms', list);
  });

  socket.on('createRoom', (payload = {}) => {
    removeFromAnyRooms(socket.id);
    const { clean: roomName, blocked } = sanitizeText(payload.name, '무제 방');
    if (blocked) return socket.emit('joinError', '부적절한 방 이름입니다.');
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();

    socket.join(roomId);
    const myName = clients.get(socket.id)?.name || '플레이어';
    gameRooms[roomId] = {
      id: roomId,
      name: roomName,
      players: [{ id: socket.id, name: myName, ready: false }],
      gameState: null,
      simulationInterval: null
    };
    // 방 생성자에게 방 정보, 전체에 목록
    socket.emit('roomCreated', roomPublic(gameRooms[roomId]));
    io.to(roomId).emit('updateRoom', roomPublic(gameRooms[roomId]));
    broadcastRooms();
  });

  socket.on('joinRoom', (roomId) => {
    removeFromAnyRooms(socket.id);
    const room = gameRooms[roomId];
    if (!room) return socket.emit('joinError', '존재하지 않는 방입니다.');
    if (room.players.length >= 2) return socket.emit('joinError', '방이 꽉 찼습니다.');
    if (room.gameState) return socket.emit('joinError', '이미 게임 중입니다.');

    socket.join(roomId);
    const myName = clients.get(socket.id)?.name || '플레이어';
    room.players.push({ id: socket.id, name: myName, ready: false });

    io.to(roomId).emit('updateRoom', roomPublic(room));
    broadcastRooms();
  });

  socket.on('playerReady', (roomId) => {
    const room = gameRooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.ready = !player.ready;
    io.to(roomId).emit('updateRoom', roomPublic(room));
    broadcastRooms();

    const allReady = room.players.length === 2 && room.players.every(p => p.ready);
    if (allReady) startGame(roomId);
  });

  socket.on('leaveRoom', (roomId) => {
    const room = gameRooms[roomId];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(roomId);

    if (room.players.length === 0) {
      delete gameRooms[roomId];
    } else {
      io.to(roomId).emit('updateRoom', roomPublic(room));
    }
    broadcastRooms();
  });


  socket.on('shoot', ({ roomId, stoneId, force }) => {
    const room = gameRooms[roomId];
    if (!room || !room.gameState) return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== room.gameState.turn) return;

    const stone = room.gameState.stones.find(s => s.id === stoneId);
    if (!stone) return;
    if (stone.ownerIndex !== playerIndex) return;

    stone.vx = force.x;
    stone.vy = force.y;
    runSimulation(roomId);
  });

  socket.on('disconnect', () => {
    removeFromAnyRooms(socket.id);
    clients.delete(socket.id);
    broadcastRooms();
  });
});

setInterval(() => {
  let changed = false;
  for (const id in gameRooms){
    const r = gameRooms[id];
    if (!r.players || r.players.length === 0){
      delete gameRooms[id];
      changed = true;
    }
  }
  if (changed) broadcastRooms();
}, 60 * 1000);

// ========================================================
// 4. 서버 실행
// ========================================================
const PORT = process.env.PORT || 8080; // ← 호스팅이 넘겨주는 포트 우선
server.listen(PORT, () => {
  console.log(`Socket server listening on ${PORT}`);
});
