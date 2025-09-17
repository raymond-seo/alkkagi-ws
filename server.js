// server.js (CommonJS)

// ========================================================
// 1. 초기 설정
// ========================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// Netlify 도메인만 허용 (필요하면 프리뷰 도메인 추가 가능)
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || 'https://mellow-parfait-132923.netlify.app';

app.use(cors({ origin: [ALLOW_ORIGIN], credentials: true }));
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

// 전역 상태(메모리) — 단일 인스턴스 기준 데모
const gameRooms = {};

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
      } else {
        room.gameState.turn = 1 - room.gameState.turn;
        io.to(roomId).emit('turnChange', room.gameState);
      }
    }
  }, 1000 / 60);
}

// ========================================================
// 3. 소켓 이벤트
// ========================================================
io.on('connection', (socket) => {
  console.log('[연결]', socket.id);

  socket.on('createRoom', () => {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    socket.join(roomId);
    gameRooms[roomId] = {
      id: roomId,
      players: [{ id: socket.id, ready: false }],
      gameState: null,
      simulationInterval: null
    };
    socket.emit('roomCreated', roomId);
    io.to(roomId).emit('updateRoom', gameRooms[roomId]);
  });

  socket.on('joinRoom', (roomId) => {
    const room = gameRooms[roomId];
    if (room && room.players.length < 2) {
      socket.join(roomId);
      room.players.push({ id: socket.id, ready: false });
      io.to(roomId).emit('updateRoom', room);
    } else {
      socket.emit('joinError', room ? '방이 꽉 찼습니다.' : '존재하지 않는 방입니다.');
    }
  });

  socket.on('playerReady', (roomId) => {
    const room = gameRooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.ready = !player.ready;
    io.to(roomId).emit('updateRoom', room);

    const allReady = room.players.length === 2 && room.players.every(p => p.ready);
    if (allReady) startGame(roomId);
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
    console.log('[끊김]', socket.id);
    for (const roomId in gameRooms) {
      const room = gameRooms[roomId];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const opp = 1 - idx;
        if (room.players[opp]) {
          io.to(room.players[opp].id).emit('gameOver', opp);
        }
        delete gameRooms[roomId];
        console.log(`[방 삭제] ${roomId}`);
        break;
      }
    }
  });
});

// ========================================================
// 4. 서버 실행
// ========================================================
const PORT = process.env.PORT || 8080; // ← 호스팅이 넘겨주는 포트 우선
server.listen(PORT, () => {
  console.log(`Socket server listening on ${PORT}`);
});
