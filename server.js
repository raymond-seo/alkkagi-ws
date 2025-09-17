// ========================================================
// 1. 초기 설정
// ========================================================
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '')));

// 게임 상수
const CANVAS_SIZE = 500; // 캔버스 크기는 서버와 클라이언트가 동일하게 알고 있어야 함
const STONE_RADIUS = CANVAS_SIZE / 20;
const FRICTION = 0.985; // 마찰 계수

// 전역 상태
let gameRooms = {};


// ========================================================
// 2. 게임 로직 핵심 함수
// ========================================================

function startGame(roomId) {
    const room = gameRooms[roomId];
    if (!room || room.players.length !== 2) return;

    console.log(`[게임 시작] ${roomId} 방 게임 시작!`);

    // 게임 상태 초기화
    room.gameState = {
        stones: [],
        turn: Math.round(Math.random()), // 0 또는 1, 첫 턴 랜덤
        players: [
            { id: room.players[0].id, isCat: true },
            { id: room.players[1].id, isCat: false }
        ]
    };

    // 돌 생성 및 배치
    let stoneIdCounter = 0;
    for (let i = 0; i < 5; i++) {
        // 플레이어 0 (냥) 돌
        room.gameState.stones.push({
            id: stoneIdCounter++, ownerIndex: 0, isCat: true,
            x: CANVAS_SIZE / 4, y: (CANVAS_SIZE / 6) * (i + 1),
            vx: 0, vy: 0, radius: STONE_RADIUS
        });
        // 플레이어 1 (멍) 돌
        room.gameState.stones.push({
            id: stoneIdCounter++, ownerIndex: 1, isCat: false,
            x: CANVAS_SIZE * 3 / 4, y: (CANVAS_SIZE / 6) * (i + 1),
            vx: 0, vy: 0, radius: STONE_RADIUS
        });
    }

    // 모든 클라이언트에게 게임 시작 알림
    room.players.forEach((player, index) => {
        io.to(player.id).emit('gameStart', {
            gameState: room.gameState,
            playerIndex: index
        });
    });
}

function runSimulation(roomId) {
    const room = gameRooms[roomId];
    if (!room || room.simulationInterval) return;

    room.simulationInterval = setInterval(() => {
        const { stones } = room.gameState;
        let isMoving = false;

        // 1. 물리 업데이트
        stones.forEach(s => {
            s.x += s.vx;
            s.y += s.vy;
            s.vx *= FRICTION;
            s.vy *= FRICTION;

            // 속도가 매우 느려지면 멈춤
            if (Math.abs(s.vx) < 0.05) s.vx = 0;
            if (Math.abs(s.vy) < 0.05) s.vy = 0;
            if (s.vx !== 0 || s.vy !== 0) isMoving = true;
        });

        // 2. 충돌 처리
        for (let i = 0; i < stones.length; i++) {
            for (let j = i + 1; j < stones.length; j++) {
                const s1 = stones[i];
                const s2 = stones[j];
                const dx = s2.x - s1.x;
                const dy = s2.y - s1.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < s1.radius + s2.radius) {
                    // 간단한 충돌 해결 (실제로는 더 복잡한 물리 필요)
                    const angle = Math.atan2(dy, dx);
                    const sin = Math.sin(angle);
                    const cos = Math.cos(angle);
                    
                    const vx1 = s1.vx * cos + s1.vy * sin;
                    const vy1 = s1.vy * cos - s1.vx * sin;
                    const vx2 = s2.vx * cos + s2.vy * sin;
                    const vy2 = s2.vy * cos - s2.vx * sin;

                    [vx1, vx2] = [vx2, vx1]; // 속도 교환

                    s1.vx = vx1 * cos - vy1 * sin;
                    s1.vy = vy1 * cos + vx1 * sin;
                    s2.vx = vx2 * cos - vy2 * sin;
                    s2.vy = vy2 * cos + vx2 * sin;
                    
                    // 겹침 현상 해결
                    const overlap = s1.radius + s2.radius - dist;
                    s1.x -= overlap / 2 * cos;
                    s1.y -= overlap / 2 * sin;
                    s2.x += overlap / 2 * cos;
                    s2.y += overlap / 2 * sin;
                }
            }
        }
        
        // 3. 게임판 밖으로 나간 돌 처리
        room.gameState.stones = stones.filter(s => {
            const distFromCenter = Math.sqrt((s.x - CANVAS_SIZE/2)**2 + (s.y - CANVAS_SIZE/2)**2);
            return distFromCenter < CANVAS_SIZE / 2;
        });

        // 4. 모든 클라이언트에게 최신 상태 전송
        io.to(roomId).emit('gameStateUpdate', room.gameState.stones);

        // 5. 모든 돌이 멈췄는지 확인
        if (!isMoving) {
            clearInterval(room.simulationInterval);
            room.simulationInterval = null;

            // 6. 승패 판정
            const catStones = room.gameState.stones.filter(s => s.isCat).length;
            const dogStones = room.gameState.stones.filter(s => s.isCat === false).length;

            if (catStones === 0) {
                const winnerIndex = room.gameState.players.findIndex(p => !p.isCat);
                io.to(roomId).emit('gameOver', winnerIndex);
                delete gameRooms[roomId];
            } else if (dogStones === 0) {
                const winnerIndex = room.gameState.players.findIndex(p => p.isCat);
                io.to(roomId).emit('gameOver', winnerIndex);
                delete gameRooms[roomId];
            } else {
                // 7. 턴 변경
                room.gameState.turn = 1 - room.gameState.turn;
                io.to(roomId).emit('turnChange', room.gameState);
            }
        }
    }, 1000 / 60); // 60 FPS
}


// ========================================================
// 3. 소켓 이벤트 핸들러
// ========================================================

io.on('connection', (socket) => {
    console.log(`[연결] ${socket.id}`);

    // 로비 관련 이벤트
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
        if (player) {
            player.ready = !player.ready;
            io.to(roomId).emit('updateRoom', room);

            const allReady = room.players.length === 2 && room.players.every(p => p.ready);
            if (allReady) {
                startGame(roomId);
            }
        }
    });

    // 게임 플레이 관련 이벤트
    socket.on('shoot', ({ roomId, stoneId, force }) => {
        const room = gameRooms[roomId];
        if (!room) return;
        
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        // 자기 턴에만 쏠 수 있도록 검증
        if (room.gameState.turn === playerIndex) {
            const stone = room.gameState.stones.find(s => s.id === stoneId);
            if (stone) {
                stone.vx = force.x;
                stone.vy = force.y;
                runSimulation(roomId);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`[연결 끊김] ${socket.id}`);
        // 플레이어가 속해있던 방을 찾아 처리
        for (const roomId in gameRooms) {
            const room = gameRooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                // 상대방에게 플레이어가 나갔다고 알림 (승리 처리)
                const opponentIndex = 1 - playerIndex;
                if(room.players[opponentIndex]){
                    io.to(room.players[opponentIndex].id).emit('gameOver', opponentIndex);
                }
                // 방 삭제
                delete gameRooms[roomId];
                console.log(`[방 삭제] ${roomId} 방이 플레이어 퇴장으로 삭제되었습니다.`);
                break;
            }
        }
    });
});


// ========================================================
// 4. 서버 실행
// ========================================================
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT} 에서 완벽하게 실행 중입니다.`);
});