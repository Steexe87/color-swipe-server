// server.js (SOSTITUIRE L'INTERO FILE)

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const app = express();
app.get('/', (req, res) => {
  res.send('Color Swipe Duel server is running!');
});
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

const SALT_ROUNDS = 10;

// --- PostgreSQL Database Setup ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// --- NUOVO: Creazione tabella per la classifica Time Attack ---
pool.query(`
    CREATE TABLE IF NOT EXISTS time_attack_scores (
        username TEXT PRIMARY KEY REFERENCES players(username) ON DELETE CASCADE,
        best_time_seconds INTEGER NOT NULL DEFAULT 0
    );
`).then(() => console.log('✅ "time_attack_scores" table checked/created.'))
  .catch(err => console.error('Error creating time_attack_scores table:', err));


console.log('✅ Connected to PostgreSQL database.');

// --- Game Logic and Matchmaking ---
let matchmakingQueues = {
    ranked: [],
    casual: []
};
const K_FACTOR = 32;
const gameRooms = {};
const privateRooms = {};

function calculateElo(playerRating, opponentRating, score) {
    const expectedScore = 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
    const newRating = playerRating + K_FACTOR * (score - expectedScore);
    return Math.round(newRating);
}

function getRandomColor() {
    return '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
}

function getRoundDuration(score1, score2) {
    const highestScore = Math.max(score1, score2);
    if (highestScore >= 1700) return 10; // Diamond
    if (highestScore >= 1500) return 12; // Platinum
    if (highestScore >= 1300) return 15; // Gold
    if (highestScore >= 1100) return 18; // Silver
    return 20; // Bronze
}


async function processGameResult(winnerUsername, loserUsername, roomId) {
    const room = gameRooms[roomId];
    if (!room || room.isFinished || room.gameMode !== 'ranked') {
        if (room && room.gameMode === 'casual') {
            console.log(`Casual match ${roomId} finished. No score change.`);
        }
        return;
    }
    room.isFinished = true;

    try {
        const playersRes = await pool.query('SELECT username, rankscore FROM players WHERE username IN ($1, $2)', [winnerUsername, loserUsername]);
        if (playersRes.rows.length < 2) {
            console.log("One or both players not found in DB for score update.");
            return;
        }

        const winner = playersRes.rows.find(r => r.username === winnerUsername);
        const loser = playersRes.rows.find(r => r.username === loserUsername);

        const newWinnerRating = calculateElo(winner.rankscore, loser.rankscore, 1);
        const newLoserRating = calculateElo(loser.rankscore, winner.rankscore, 0);

        await pool.query('UPDATE players SET rankscore = $1 WHERE username = $2', [newWinnerRating, winnerUsername]);
        await pool.query('UPDATE players SET rankscore = $1 WHERE username = $2', [newLoserRating, loserUsername]);
        
        const winnerSocketId = Object.keys(room.players).find(id => room.players[id].username === winnerUsername);
        const loserSocketId = Object.keys(room.players).find(id => room.players[id].username === loserUsername);

        if (winnerSocketId) io.to(winnerSocketId).emit('updateRankScore', { newRankScore: newWinnerRating });
        if (loserSocketId) io.to(loserSocketId).emit('updateRankScore', { newRankScore: newLoserRating });

        console.log(`Scores updated: ${winnerUsername} ${newWinnerRating}, ${loserUsername} ${newLoserRating}`);
    } catch (err) {
        console.error("Error updating scores (processGameResult):", err);
    }
}


function startNewRound(roomId, room) {
    console.log(`Starting new round for room ${roomId}`);
    if (room.state === 'PRE_GAME') {
        room.state = 'IN_PROGRESS';
        console.log(`Game ${roomId} officially started. State: IN_PROGRESS.`);
    }
    
    room.rematchReady = {};
    room.isFinished = false;
    const playerSocketIds = Object.keys(room.players);
    if (playerSocketIds.length < 2) return;
    const player1 = room.players[playerSocketIds[0]];
    const player2 = room.players[playerSocketIds[1]];
    const roundDuration = getRoundDuration(player1.rankScore, player2.rankScore);
    
    // *** MODIFICATO: Colore di partenza uguale per entrambi i giocatori ***
    const startColor = getRandomColor();
    const roundData = {
        targetColor: getRandomColor(),
        initialColors: {
            [playerSocketIds[0]]: startColor,
            [playerSocketIds[1]]: startColor,
        },
        players: Object.values(room.players),
        duration: roundDuration,
        opponentPowerups: { glitch: true, snap: true } 
    };
    io.to(roomId).emit('gameEvent', { roomId, event: 'roundStartData', payload: roundData });
}

function startGameForPair(socket1, data1, socket2, data2, gameMode) {
    const roomId = `room-${socket1.id}-${socket2.id}`;
    socket1.join(roomId);
    socket2.join(roomId);
    gameRooms[roomId] = {
        players: {
            [socket1.id]: { ...data1, isReady: false },
            [socket2.id]: { ...data2, isReady: false }
        },
        rematchReady: {},
        isFinished: false,
        state: 'PRE_GAME',
        gameMode: gameMode 
    };
    io.to(roomId).emit('gameReady', { roomId, players: Object.values(gameRooms[roomId].players) });
}

function findMatch(gameMode) {
    const queue = matchmakingQueues[gameMode];
    if (queue.length < 2) return;

    for (let i = 0; i < queue.length; i++) {
        for (let j = i + 1; j < queue.length; j++) {
            const player1 = queue[i];
            const player2 = queue[j];
            
            const canMatch = gameMode === 'casual' || Math.abs(player1.data.rankScore - player2.data.rankScore) <= 200;

            if (canMatch) {
                console.log(`🤝 ${gameMode} match found between ${player1.data.username} and ${player2.data.username}`);
                
                const matchedPlayers = [player1, player2];
                matchmakingQueues[gameMode] = queue.filter(p => !matchedPlayers.includes(p));

                startGameForPair(player1.socket, player1.data, player2.socket, player2.data, gameMode);
                
                return; 
            }
        }
    }
}

function generateRoomCode() {
    let code;
    const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789';
    do {
        code = '';
        for (let i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    } while (privateRooms[code]);
    return code;
}

// --- Socket Connection Handling ---
io.on('connection', (socket) => {
    console.log(`✅ A user connected: ${socket.id}`);

    socket.on('rejoinWithUsername', async ({ username }) => {
        if (!username) return;
        socket.username = username;
        try {
            const res = await pool.query('SELECT username, rankscore FROM players WHERE username = $1', [username]);
            if (res.rows.length === 0) return socket.emit('forceLogin');
            const row = res.rows[0];
            console.log(`User ${username} re-authenticated.`);
            socket.emit('loginSuccess', { username: row.username, rankScore: row.rankscore });
        } catch (err) {
            console.error("Rejoin error:", err);
            socket.emit('forceLogin');
        }
    });

    socket.on('register', async ({ username, password }) => {
        if (!username || username.length < 3 || username.length > 10 || !password || password.length < 4) {
            return socket.emit('registerError', 'Invalid username or password.');
        }
        try {
            const existingUser = await pool.query('SELECT username FROM players WHERE username = $1', [username]);
            if (existingUser.rows.length > 0) return socket.emit('registerError', 'Username already taken.');
            
            const hash = await bcrypt.hash(password, SALT_ROUNDS);
            const startScore = 1000;
            await pool.query('INSERT INTO players(username, password, rankscore) VALUES($1, $2, $3)', [username, hash, startScore]);
            
            console.log(`New player registered: ${username}`);
            socket.emit('registerSuccess', { username, rankScore: startScore });
        } catch (err) {
            console.error("Registration error:", err);
            socket.emit('registerError', 'Server error.');
        }
    });
    
    socket.on('login', async ({ username, password }) => {
        if (!username || !password) return socket.emit('loginError', 'Missing username or password.');
        socket.username = username;
        try {
            const res = await pool.query('SELECT * FROM players WHERE username = $1', [username]);
            if (res.rows.length === 0) return socket.emit('loginError', 'User not found.');
            
            const user = res.rows[0];
            const match = await bcrypt.compare(password, user.password);

            if (match) {
                console.log(`User ${username} authenticated.`);
                socket.emit('loginSuccess', { username: user.username, rankScore: user.rankscore });
            } else {
                console.log(`Failed login attempt for ${username}.`);
                socket.emit('loginError', 'Incorrect password.');
            }
        } catch (err) {
            console.error("Login error:", err);
            socket.emit('loginError', 'Server error.');
        }
    });

    socket.on('findMatch', ({ playerData, gameMode }) => {
        if (!matchmakingQueues[gameMode]) return;
        matchmakingQueues[gameMode].push({ socket, data: playerData });
        findMatch(gameMode);
    });

    socket.on('cancelFindMatch', () => {
        matchmakingQueues.ranked = matchmakingQueues.ranked.filter(p => p.socket.id !== socket.id);
        matchmakingQueues.casual = matchmakingQueues.casual.filter(p => p.socket.id !== socket.id);
    });
    
    socket.on('createPrivateRoom', ({ playerData, gameMode }) => {
        const code = generateRoomCode();
        privateRooms[code] = { creatorSocket: socket, creatorData: playerData, gameMode: gameMode };
        console.log(`${playerData.username} created a private ${gameMode} room with code ${code}`);
        socket.emit('privateRoomCreated', { code });
    });

    socket.on('joinPrivateRoom', ({ code, playerData }) => {
        const roomToJoin = privateRooms[code];
        if (!roomToJoin) return socket.emit('joinRoomError', 'Room not found or expired.');
        console.log(`${playerData.username} is joining room ${code}`);
        const { creatorSocket, creatorData, gameMode } = roomToJoin;
        startGameForPair(creatorSocket, creatorData, socket, playerData, gameMode);
        delete privateRooms[code];
    });

    socket.on('cancelPrivateRoom', () => {
        const code = Object.keys(privateRooms).find(c => privateRooms[c].creatorSocket.id === socket.id);
        if (code) delete privateRooms[code];
    });
    
    socket.on('useBonus', ({ roomId, bonusType }) => {
        socket.to(roomId).emit('opponentUsedBonus', { bonusType });
    });

    socket.on('gameOver', ({ winnerUsername, loserUsername, roomId }) => {
        processGameResult(winnerUsername, loserUsername, roomId);
    });
    
    socket.on('getLeaderboard', async ({ username }) => {
        try {
            const top20Query = `
                SELECT 
                    p.username, 
                    p.rankscore, 
                    RANK() OVER (ORDER BY p.rankscore DESC) as rank 
                FROM players p ORDER BY p.rankscore DESC LIMIT 20`;
            const topRes = await pool.query(top20Query);
            const topRows = topRes.rows;

            const isUserInTop20 = topRows.some(p => p.username === username);
            let finalData = topRows.map(p => ({...p, rankScore: p.rankscore, isCurrentUser: p.username === username}));

            if (!isUserInTop20 && username) {
                const userRankQuery = `
                    WITH Ranks AS (SELECT username, rankscore, RANK() OVER (ORDER BY rankscore DESC) as rank FROM players) 
                    SELECT * FROM Ranks WHERE username = $1`;
                const userRes = await pool.query(userRankQuery, [username]);
                if (userRes.rows.length > 0) {
                    const userRow = userRes.rows[0];
                    finalData.push({...userRow, rankScore: userRow.rankscore, isCurrentUser: true});
                }
            }
            socket.emit('leaderboardData', finalData);
        } catch (err) {
            console.error("getLeaderboard error:", err);
        }
    });

    // *** INIZIO BLOCCO NUOVO: Gestori per la Time Attack Leaderboard ***
    socket.on('submitTimeAttackScore', async ({ username, time }) => {
        if (!username || typeof time !== 'number') return;
        try {
            const res = await pool.query('SELECT best_time_seconds FROM time_attack_scores WHERE username = $1', [username]);
            if (res.rows.length > 0) {
                if (time > res.rows[0].best_time_seconds) {
                    await pool.query('UPDATE time_attack_scores SET best_time_seconds = $1 WHERE username = $2', [time, username]);
                    console.log(`New best time for ${username}: ${time}s`);
                }
            } else {
                await pool.query('INSERT INTO time_attack_scores (username, best_time_seconds) VALUES ($1, $2)', [username, time]);
                console.log(`First time attack score for ${username}: ${time}s`);
            }
        } catch (err) {
            // Gestisce il caso in cui un utente registrato non sia ancora in 'players' (improbabile)
            if (err.code === '23503') { // Foreign key violation
                 console.log(`Attempted to submit score for non-existent player: ${username}`);
            } else {
                console.error('Error submitting time attack score:', err);
            }
        }
    });

    socket.on('getTimeAttackLeaderboard', async ({ username }) => {
        try {
            const top20Query = `
                SELECT 
                    t.username, 
                    t.best_time_seconds, 
                    p.rankscore,
                    RANK() OVER (ORDER BY t.best_time_seconds DESC) as rank 
                FROM time_attack_scores t
                JOIN players p ON t.username = p.username
                ORDER BY t.best_time_seconds DESC 
                LIMIT 20`;
            const topRes = await pool.query(top20Query);
            const topRows = topRes.rows;

            const isUserInTop20 = topRows.some(p => p.username === username);
            let finalData = topRows.map(p => ({...p, isCurrentUser: p.username === username}));

            if (!isUserInTop20 && username) {
                const userRankQuery = `
                    WITH Ranks AS (
                        SELECT t.username, t.best_time_seconds, p.rankscore, RANK() OVER (ORDER BY t.best_time_seconds DESC) as rank 
                        FROM time_attack_scores t
                        JOIN players p ON t.username = p.username
                    ) 
                    SELECT * FROM Ranks WHERE username = $1`;
                const userRes = await pool.query(userRankQuery, [username]);
                if (userRes.rows.length > 0) {
                    finalData.push({...userRes.rows[0], isCurrentUser: true});
                }
            }
            socket.emit('timeAttackLeaderboardData', finalData);
        } catch (err) {
            console.error("getTimeAttackLeaderboard error:", err);
        }
    });
    // *** FINE BLOCCO NUOVO ***

    socket.on('requestRematch', ({ roomId }) => {
        const room = gameRooms[roomId];
        if (!room) return;
        room.rematchReady[socket.id] = true;
        const opponentId = Object.keys(room.players).find(id => id !== socket.id);
        if (opponentId && room.rematchReady[opponentId]) startNewRound(roomId, room);
    });
    
    const handleMatchAbandonment = async (roomId, abandoningSocketId) => {
        const room = gameRooms[roomId];
        if (!room) return;

        const opponentSocketId = Object.keys(room.players).find(id => id !== abandoningSocketId);
        
        if (room.state === 'PRE_GAME') {
            console.log(`Abandonment in ${roomId} before start. Game cancelled, no penalty.`);
            if (opponentSocketId && io.sockets.sockets.has(opponentSocketId)) {
                io.to(opponentSocketId).emit('opponentDisconnected'); 
            }
        } else {
            if (opponentSocketId && !room.isFinished) {
                const abandoningPlayer = room.players[abandoningSocketId];
                const winningPlayer = room.players[opponentSocketId];
                console.log(`${abandoningPlayer.username} left. ${winningPlayer.username} wins by forfeit.`);
                await processGameResult(winningPlayer.username, abandoningPlayer.username, roomId);
                
                if (io.sockets.sockets.has(opponentSocketId)) {
                    io.to(opponentSocketId).emit('opponentDisconnected');
                }
            }
        }
        
        delete gameRooms[roomId];
        console.log(`Room ${roomId} deleted.`);
    }

    socket.on('leavePostGameLobby', ({ roomId }) => {
        if (gameRooms[roomId]) {
            const opponentSocketId = Object.keys(gameRooms[roomId].players).find(id => id !== socket.id);
            if (opponentSocketId && io.sockets.sockets.has(opponentSocketId)) {
                io.to(opponentSocketId).emit('opponentLeftRematch');
            }
            delete gameRooms[roomId];
        }
    });

    socket.on('leaveGame', ({ roomId }) => handleMatchAbandonment(roomId, socket.id));

    socket.on('gameEvent', (data) => {
        const { roomId, event } = data;
        const room = gameRooms[roomId];
        if (!room) return;

        if (event === 'playerReady') {
            if (room.players[socket.id]) {
                room.players[socket.id].isReady = true;
            }
            socket.to(roomId).emit('gameEvent', { roomId, event: 'playerReady' });

            const allReady = Object.values(room.players).every(p => p.isReady);
            if (allReady) {
                Object.values(room.players).forEach(p => p.isReady = false);
                startNewRound(roomId, room);
            }
        } else {
            socket.to(roomId).emit('gameEvent', data);
        }
    });

    socket.on('disconnect', () => {
        console.log(`❌ User disconnected: ${socket.id}`);
        matchmakingQueues.ranked = matchmakingQueues.ranked.filter(p => p.socket.id !== socket.id);
        matchmakingQueues.casual = matchmakingQueues.casual.filter(p => p.socket.id !== socket.id);
        const privateRoomCode = Object.keys(privateRooms).find(c => privateRooms[c].creatorSocket.id === socket.id);
        if (privateRoomCode) delete privateRooms[privateRoomCode];
        
        const roomId = Object.keys(gameRooms).find(r => gameRooms[r] && gameRooms[r].players[socket.id]);
        if (roomId) handleMatchAbandonment(roomId, socket.id);
    });
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});