// server.js (SOSTITUIRE L'INTERO FILE)

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const app = express();
app.get('/', (req, res) => {
  res.send('Il server di Color Swipe Duel è attivo!');
});
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

const SALT_ROUNDS = 10;

// --- Setup del Database PostgreSQL ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

console.log('✅ Connesso al database PostgreSQL.');

// --- Logica di Gioco e Matchmaking ---
let matchmakingQueue = [];
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
    if (highestScore >= 1500) return 10;
    if (highestScore >= 1100) return 15;
    return 20;
}

function startNewRound(roomId, room) {
    console.log(`Avvio nuovo round per la stanza ${roomId}`);
    room.rematchReady = {};
    room.isFinished = false;
    const playerSocketIds = Object.keys(room.players);
    if (playerSocketIds.length < 2) return;
    const player1 = room.players[playerSocketIds[0]];
    const player2 = room.players[playerSocketIds[1]];
    // *** CORREZIONE: Usa rankScore (camelCase) come negli oggetti in memoria ***
    const roundDuration = getRoundDuration(player1.rankScore, player2.rankScore);
    const roundData = {
        targetColor: getRandomColor(),
        initialColors: {
            [playerSocketIds[0]]: getRandomColor(),
            [playerSocketIds[1]]: getRandomColor(),
        },
        players: Object.values(room.players),
        duration: roundDuration
    };
    io.to(roomId).emit('gameEvent', { event: 'roundStartData', payload: roundData });
}

function startGameForPair(socket1, data1, socket2, data2) {
    const roomId = `room-${socket1.id}-${socket2.id}`;
    socket1.join(roomId);
    socket2.join(roomId);
    gameRooms[roomId] = {
        players: {
            [socket1.id]: { ...data1, isReady: false },
            [socket2.id]: { ...data2, isReady: false }
        },
        rematchReady: {},
        isFinished: false
    };
    io.to(roomId).emit('gameReady', { roomId, players: Object.values(gameRooms[roomId].players) });
}

function findMatch() {
    for (let i = 0; i < matchmakingQueue.length; i++) {
        for (let j = i + 1; j < matchmakingQueue.length; j++) {
            const player1 = matchmakingQueue[i];
            const player2 = matchmakingQueue[j];
            // *** CORREZIONE: Usa rankScore (camelCase) come nei dati inviati dal client ***
            if (Math.abs(player1.data.rankScore - player2.data.rankScore) <= 200) {
                console.log(`🤝 Match casuale trovato tra ${player1.data.username} e ${player2.data.username}`);
                matchmakingQueue.splice(j, 1);
                matchmakingQueue.splice(i, 1);
                startGameForPair(player1.socket, player1.data, player2.socket, player2.data);
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

// --- Gestione Connessioni Socket ---
io.on('connection', (socket) => {
    console.log(`✅ Un utente si è connesso: ${socket.id}`);

    socket.on('rejoinWithUsername', async ({ username }) => {
        if (!username) return;
        socket.username = username;
        try {
            const res = await pool.query('SELECT username, rankscore FROM players WHERE username = $1', [username]);
            if (res.rows.length === 0) return socket.emit('forceLogin');
            const row = res.rows[0];
            console.log(`Utente ${username} ri-autenticato.`);
            // Mappa 'rankscore' (db) a 'rankScore' (client)
            socket.emit('loginSuccess', { username: row.username, rankScore: row.rankscore });
        } catch (err) {
            console.error("Errore rejoin:", err);
            socket.emit('forceLogin');
        }
    });

    socket.on('register', async ({ username, password }) => {
        if (!username || username.length < 3 || !password || password.length < 4) {
            return socket.emit('registerError', 'Username o password non validi.');
        }
        try {
            const existingUser = await pool.query('SELECT username FROM players WHERE username = $1', [username]);
            if (existingUser.rows.length > 0) return socket.emit('registerError', 'Username già in uso.');
            
            const hash = await bcrypt.hash(password, SALT_ROUNDS);
            const startScore = 1000;
            await pool.query('INSERT INTO players(username, password, rankscore) VALUES($1, $2, $3)', [username, hash, startScore]);
            
            console.log(`Nuovo giocatore registrato: ${username}`);
            socket.emit('registerSuccess', { username, rankScore: startScore });
        } catch (err) {
            console.error("Errore registrazione:", err);
            socket.emit('registerError', 'Errore del server.');
        }
    });
    
    socket.on('login', async ({ username, password }) => {
        if (!username || !password) return socket.emit('loginError', 'Username o password mancanti.');
        socket.username = username;
        try {
            const res = await pool.query('SELECT * FROM players WHERE username = $1', [username]);
            if (res.rows.length === 0) return socket.emit('loginError', 'Utente non trovato.');
            
            const user = res.rows[0];
            const match = await bcrypt.compare(password, user.password);

            if (match) {
                console.log(`Utente ${username} autenticato.`);
                // Mappa 'rankscore' (db) a 'rankScore' (client)
                socket.emit('loginSuccess', { username: user.username, rankScore: user.rankscore });
            } else {
                console.log(`Tentativo di login fallito per ${username}.`);
                socket.emit('loginError', 'Password errata.');
            }
        } catch (err) {
            console.error("Errore login:", err);
            socket.emit('loginError', 'Errore del server.');
        }
    });

    socket.on('findMatch', (playerData) => {
        matchmakingQueue.push({ socket, data: playerData });
        findMatch();
    });

    socket.on('cancelFindMatch', () => {
        matchmakingQueue = matchmakingQueue.filter(p => p.socket.id !== socket.id);
    });

    socket.on('createPrivateRoom', (playerData) => {
        const code = generateRoomCode();
        privateRooms[code] = { creatorSocket: socket, creatorData: playerData };
        console.log(`Stanza privata creata da ${playerData.username} con codice ${code}`);
        socket.emit('privateRoomCreated', { code });
    });

    socket.on('joinPrivateRoom', ({ code, playerData }) => {
        const roomToJoin = privateRooms[code];
        if (!roomToJoin) return socket.emit('joinRoomError', 'Stanza non trovata o scaduta.');
        console.log(`${playerData.username} si unisce alla stanza ${code}`);
        const { creatorSocket, creatorData } = roomToJoin;
        startGameForPair(creatorSocket, creatorData, socket, playerData);
        delete privateRooms[code];
    });

    socket.on('cancelPrivateRoom', () => {
        const code = Object.keys(privateRooms).find(c => privateRooms[c].creatorSocket.id === socket.id);
        if (code) delete privateRooms[code];
    });

    socket.on('gameOver', async ({ winnerUsername, loserUsername, roomId }) => {
        const room = gameRooms[roomId];
        if (!room || room.isFinished) return;
        room.isFinished = true;

        try {
            const playersRes = await pool.query('SELECT username, rankscore FROM players WHERE username IN ($1, $2)', [winnerUsername, loserUsername]);
            if (playersRes.rows.length < 2) return;

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

            console.log(`Punteggi aggiornati: ${winnerUsername} ${newWinnerRating}, ${loserUsername} ${newLoserRating}`);
        } catch (err) {
            console.error("Errore gameOver:", err);
        }
    });
    
    socket.on('getLeaderboard', async ({ username }) => {
        try {
            const top20Query = 'SELECT username, rankscore, RANK() OVER (ORDER BY rankscore DESC) as rank FROM players ORDER BY rankscore DESC LIMIT 20';
            const topRes = await pool.query(top20Query);
            const topRows = topRes.rows;

            const isUserInTop20 = topRows.some(p => p.username === username);
            // Mappa 'rankscore' (db) a 'rankScore' (client)
            let finalData = topRows.map(p => ({...p, rankScore: p.rankscore, isCurrentUser: p.username === username}));

            if (!isUserInTop20) {
                const userRankQuery = 'WITH Ranks AS (SELECT username, rankscore, RANK() OVER (ORDER BY rankscore DESC) as rank FROM players) SELECT * FROM Ranks WHERE username = $1';
                const userRes = await pool.query(userRankQuery, [username]);
                if (userRes.rows.length > 0) {
                    const userRow = userRes.rows[0];
                    // Mappa 'rankscore' (db) a 'rankScore' (client)
                    finalData.push({...userRow, rankScore: userRow.rankscore, isCurrentUser: true});
                }
            }
            socket.emit('leaderboardData', finalData);
        } catch (err) {
            console.error("Errore getLeaderboard:", err);
        }
    });

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
        
        if (!room.isFinished && opponentSocketId) {
            const abandoningPlayer = room.players[abandoningSocketId];
            const winningPlayer = room.players[opponentSocketId];
            console.log(`${abandoningPlayer.username} ha abbandonato. ${winningPlayer.username} vince.`);
            // Simula un "gameOver" per aggiornare i punteggi
            await socket.emit('gameOver', {
                winnerUsername: winningPlayer.username,
                loserUsername: abandoningPlayer.username,
                roomId
            });
        }
        
        if (opponentSocketId && io.sockets.sockets.has(opponentSocketId)) {
            io.to(opponentSocketId).emit(room.isFinished ? 'opponentLeftRematch' : 'opponentDisconnected');
        }
        
        delete gameRooms[roomId];
        console.log(`Stanza ${roomId} eliminata.`);
    }

    socket.on('leavePostGameLobby', ({ roomId }) => handleMatchAbandonment(roomId, socket.id));
    socket.on('leaveGame', ({ roomId }) => handleMatchAbandonment(roomId, socket.id));

    socket.on('gameEvent', (data) => {
        const { roomId, event } = data;
        const room = gameRooms[roomId];
        if (!room) return;

        if (event === 'playerReady') {
            room.players[socket.id].isReady = true;
            const allReady = Object.values(room.players).every(p => p.isReady);
            if (allReady) {
                Object.values(room.players).forEach(p => p.isReady = false);
                startNewRound(roomId, room);
            } else {
                socket.to(roomId).emit('gameEvent', { event: 'playerReady' });
            }
        } else {
            socket.to(roomId).emit('gameEvent', data);
        }
    });

    socket.on('disconnect', () => {
        console.log(`❌ Utente disconnesso: ${socket.id}`);
        matchmakingQueue = matchmakingQueue.filter(p => p.socket.id !== socket.id);
        const privateRoomCode = Object.keys(privateRooms).find(c => privateRooms[c].creatorSocket.id === socket.id);
        if (privateRoomCode) delete privateRooms[privateRoomCode];
        
        const roomId = Object.keys(gameRooms).find(r => gameRooms[r].players[socket.id]);
        if (roomId) handleMatchAbandonment(roomId, socket.id);
    });
});

server.listen(PORT, () => {
  console.log(`🚀 Server in ascolto sulla porta ${PORT}`);
});