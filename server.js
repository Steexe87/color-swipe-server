// server.js (SOSTITUIRE L'INTERO FILE)

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const app = express();
app.get('/', (req, res) => {
  res.send('Il server di Color Swipe Duel è attivo!');
});
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

const SALT_ROUNDS = 10;

// --- Setup del Database ---
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) {
        console.error("Errore connessione database:", err.message);
    }
    console.log('✅ Connesso al database SQLite.');
});

db.run(`CREATE TABLE IF NOT EXISTS players (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    rankScore INTEGER NOT NULL
)`);


// --- Logica di Gioco e Matchmaking ---
let matchmakingQueue = [];
const K_FACTOR = 32;
const gameRooms = {};
const privateRooms = {}; // *** NUOVO: Oggetto per le stanze private in attesa

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
    if (highestScore >= 1500) return 10; // Platino e Diamante
    if (highestScore >= 1100) return 15; // Oro e Argento
    return 20; // Bronzo
}

function startNewRound(roomId, room) {
    console.log(`Avvio nuovo round per la stanza ${roomId}`);
    room.rematchReady = {};
    room.isFinished = false;

    const playerSocketIds = Object.keys(room.players);
    if (playerSocketIds.length < 2) return; // Sicurezza
    const player1 = room.players[playerSocketIds[0]];
    const player2 = room.players[playerSocketIds[1]];

    const roundDuration = getRoundDuration(player1.rankScore, player2.rankScore);
    console.log(`Durata round per ${player1.username} vs ${player2.username}: ${roundDuration}s`);

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

function findMatch() {
    for (let i = 0; i < matchmakingQueue.length; i++) {
        for (let j = i + 1; j < matchmakingQueue.length; j++) {
            const player1 = matchmakingQueue[i];
            const player2 = matchmakingQueue[j];

            // Criterio di matchmaking basato sul punteggio
            if (Math.abs(player1.data.rankScore - player2.data.rankScore) <= 200) {
                console.log(`🤝 Match casuale trovato tra ${player1.data.username} e ${player2.data.username}`);
                
                // Rimuovi i giocatori dalla coda
                matchmakingQueue.splice(j, 1);
                matchmakingQueue.splice(i, 1);

                // Avvia la partita
                startGameForPair(player1.socket, player1.data, player2.socket, player2.data);
                return;
            }
        }
    }
}

// *** INIZIO BLOCCO NUOVO/MODIFICATO: Funzioni per stanze private e avvio partita ***
function generateRoomCode() {
    let code;
    const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789';
    do {
        code = '';
        for (let i = 0; i < 5; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    } while (privateRooms[code]); // Garantisce che il codice sia unico
    return code;
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

    io.to(roomId).emit('gameReady', { 
        roomId: roomId, 
        players: Object.values(gameRooms[roomId].players)
    });
}
// *** FINE BLOCCO NUOVO/MODIFICATO ***


// --- Gestione Connessioni Socket ---
io.on('connection', (socket) => {
    console.log(`✅ Un utente si è connesso: ${socket.id}`);

    socket.on('rejoinWithUsername', ({ username }) => {
        if (!username) return;
        socket.username = username;
        db.get(`SELECT * FROM players WHERE username = ?`, [username], (err, row) => {
            if (err || !row) {
                socket.emit('forceLogin');
                return;
            }
            console.log(`Utente ${username} ri-autenticato.`);
            const playerData = { username: row.username, rankScore: row.rankScore };
            socket.emit('loginSuccess', playerData);
        });
    });

    socket.on('register', ({ username, password }) => {
        if (!username || username.length < 3 || !password || password.length < 4) {
            return socket.emit('registerError', 'Username o password non validi.');
        }
        db.get(`SELECT * FROM players WHERE username = ?`, [username], (err, row) => {
            if (err) return console.error(err.message);
            if (row) return socket.emit('registerError', 'Username già in uso.');
            bcrypt.hash(password, SALT_ROUNDS, (err, hash) => {
                if (err) return console.error(err.message);
                const startScore = 1000;
                db.run(`INSERT INTO players(username, password, rankScore) VALUES(?, ?, ?)`, [username, hash, startScore], (err) => {
                    if (err) return console.error(err.message);
                    console.log(`Nuovo giocatore registrato: ${username}`);
                    socket.emit('registerSuccess', { username: username, rankScore: startScore });
                });
            });
        });
    });
    
    socket.on('login', ({ username, password }) => {
        if (!username || !password) return socket.emit('loginError', 'Username o password mancanti.');
        socket.username = username;
        db.get(`SELECT * FROM players WHERE username = ?`, [username], (err, row) => {
            if (err) return console.error(err.message);
            if (!row) return socket.emit('loginError', 'Utente non trovato.');
            bcrypt.compare(password, row.password, (err, result) => {
                if (result) {
                    console.log(`Utente ${username} autenticato.`);
                    const playerData = { username: row.username, rankScore: row.rankScore };
                    socket.emit('loginSuccess', playerData);
                } else {
                    console.log(`Tentativo di login fallito per ${username}.`);
                    socket.emit('loginError', 'Password errata.');
                }
            });
        });
    });

    socket.on('findMatch', (playerData) => {
        console.log(`${playerData.username} sta cercando una partita casuale...`);
        matchmakingQueue = matchmakingQueue.filter(p => p.data.username !== playerData.username);
        matchmakingQueue.push({ socket: socket, data: playerData });
        findMatch();
    });

    socket.on('cancelFindMatch', () => {
        matchmakingQueue = matchmakingQueue.filter(p => p.socket.id !== socket.id);
        if (socket.username) console.log(`Ricerca casuale annullata per ${socket.username}`);
    });
    
    // *** INIZIO BLOCCO NUOVO: Gestori per stanze private ***
    socket.on('createPrivateRoom', (playerData) => {
        const code = generateRoomCode();
        privateRooms[code] = {
            creatorSocket: socket,
            creatorData: playerData
        };
        console.log(`Stanza privata creata da ${playerData.username} con codice ${code}`);
        socket.emit('privateRoomCreated', { code });
    });

    socket.on('joinPrivateRoom', ({ code, playerData }) => {
        const roomToJoin = privateRooms[code];
        if (!roomToJoin) {
            return socket.emit('joinRoomError', 'Stanza non trovata o scaduta.');
        }

        console.log(`${playerData.username} si unisce alla stanza ${code}`);
        const { creatorSocket, creatorData } = roomToJoin;
        
        // Avvia la partita per la coppia
        startGameForPair(creatorSocket, creatorData, socket, playerData);
        
        // Rimuovi la stanza dalla lista d'attesa
        delete privateRooms[code];
    });

    socket.on('cancelPrivateRoom', () => {
        const roomCodeToDelete = Object.keys(privateRooms).find(
            code => privateRooms[code].creatorSocket.id === socket.id
        );
        if (roomCodeToDelete) {
            delete privateRooms[roomCodeToDelete];
            console.log(`Stanza privata ${roomCodeToDelete} annullata da ${socket.username}`);
        }
    });
    // *** FINE BLOCCO NUOVO ***

    socket.on('gameOver', ({ winnerUsername, loserUsername, roomId }) => {
        const room = gameRooms[roomId];
        if (!room) return;
        room.isFinished = true;

        db.all(`SELECT * FROM players WHERE username IN (?, ?)`, [winnerUsername, loserUsername], (err, rows) => {
            if (err || rows.length < 2) return;

            const winner = rows.find(r => r.username === winnerUsername);
            const loser = rows.find(r => r.username === loserUsername);
            
            const winnerSocketId = Object.keys(room.players).find(id => room.players[id].username === winnerUsername);
            const loserSocketId = Object.keys(room.players).find(id => room.players[id].username === loserUsername);

            const newWinnerRating = calculateElo(winner.rankScore, loser.rankScore, 1);
            const newLoserRating = calculateElo(loser.rankScore, winner.rankScore, 0);

            db.run(`UPDATE players SET rankScore = ? WHERE username = ?`, [newWinnerRating, winnerUsername]);
            db.run(`UPDATE players SET rankScore = ? WHERE username = ?`, [newLoserRating, loserUsername]);

            if(winnerSocketId) {
                room.players[winnerSocketId].rankScore = newWinnerRating;
                io.to(winnerSocketId).emit('updateRankScore', { newRankScore: newWinnerRating });
            }
            if(loserSocketId) {
                room.players[loserSocketId].rankScore = newLoserRating;
                io.to(loserSocketId).emit('updateRankScore', { newRankScore: newLoserRating });
            }

            console.log(`Punteggi aggiornati: ${winnerUsername} ${newWinnerRating}, ${loserUsername} ${newLoserRating}`);
        });
    });
    
    socket.on('getLeaderboard', ({ username }) => {
        const top20Query = `SELECT username, rankScore, RANK() OVER (ORDER BY rankScore DESC) as rank FROM players ORDER BY rankScore DESC LIMIT 20`;
        
        db.all(top20Query, [], (err, topRows) => {
            if (err) return;
            const isUserInTop20 = topRows.some(p => p.username === username);
            if (isUserInTop20) {
                 const finalData = topRows.map(p => ({...p, isCurrentUser: p.username === username}));
                 socket.emit('leaderboardData', finalData);
            } else {
                const userRankQuery = `WITH Ranks AS (SELECT username, rankScore, RANK() OVER (ORDER BY rankScore DESC) as rank FROM players) SELECT * FROM Ranks WHERE username = ?`;
                db.get(userRankQuery, [username], (err, userRow) => {
                    if (err || !userRow) {
                        socket.emit('leaderboardData', topRows);
                        return;
                    }
                    const finalData = [...topRows, {...userRow, isCurrentUser: true}];
                    socket.emit('leaderboardData', finalData);
                });
            }
        });
    });

    socket.on('requestRematch', ({ roomId }) => {
        const room = gameRooms[roomId];
        if (!room) return;

        room.rematchReady[socket.id] = true;
        console.log(`Giocatore ${socket.username} è pronto per la rivincita.`);

        const playerIds = Object.keys(room.players);
        const opponentId = playerIds.find(id => id !== socket.id);

        if (opponentId && room.rematchReady[opponentId]) {
            console.log("Entrambi pronti! Inizio la rivincita.");
            startNewRound(roomId, room);
        }
    });
    
    function handleMatchAbandonment(roomId, abandoningSocketId) {
        const room = gameRooms[roomId];
        if (!room) return;

        const opponentSocketId = Object.keys(room.players).find(id => id !== abandoningSocketId);
        
        if (!room.isFinished && opponentSocketId) {
            const abandoningPlayer = room.players[abandoningSocketId];
            const winningPlayer = room.players[opponentSocketId];

            console.log(`${abandoningPlayer.username} ha abbandonato. ${winningPlayer.username} vince.`);

            db.all(`SELECT * FROM players WHERE username IN (?, ?)`, [abandoningPlayer.username, winningPlayer.username], (err, rows) => {
                if (err || rows.length < 2) {
                    delete gameRooms[roomId];
                    return;
                };
                const winnerDB = rows.find(r => r.username === winningPlayer.username);
                const loserDB = rows.find(r => r.username === abandoningPlayer.username);

                const newWinnerRating = calculateElo(winnerDB.rankScore, loserDB.rankScore, 1);
                const newLoserRating = calculateElo(loserDB.rankScore, winnerDB.rankScore, 0);

                db.run(`UPDATE players SET rankScore = ? WHERE username = ?`, [newWinnerRating, winningPlayer.username]);
                db.run(`UPDATE players SET rankScore = ? WHERE username = ?`, [newLoserRating, abandoningPlayer.username]);

                if (io.sockets.sockets.has(opponentSocketId)) {
                    io.to(opponentSocketId).emit('updateRankScore', { newRankScore: newWinnerRating });
                }
                if (io.sockets.sockets.has(abandoningSocketId)) {
                    io.to(abandoningSocketId).emit('updateRankScore', { newRankScore: newLoserRating });
                }
                console.log(`Punteggi aggiornati per abbandono: ${winningPlayer.username} ${newWinnerRating}, ${abandoningPlayer.username} ${newLoserRating}`);
            });
        }
        
        if (opponentSocketId && io.sockets.sockets.has(opponentSocketId)) {
            const event = room.isFinished ? 'opponentLeftRematch' : 'opponentDisconnected';
            io.to(opponentSocketId).emit(event);
        }
        
        delete gameRooms[roomId];
        console.log(`Stanza ${roomId} eliminata.`);
    }

    socket.on('leavePostGameLobby', ({ roomId }) => {
        handleMatchAbandonment(roomId, socket.id);
    });
    
    socket.on('leaveGame', ({ roomId }) => {
        handleMatchAbandonment(roomId, socket.id);
    });

    socket.on('gameEvent', (data) => {
        const { roomId, event } = data;
        const room = gameRooms[roomId];
        if (!room) return;

        switch(event) {
            case 'playerReady':
                room.players[socket.id].isReady = true;
                const allPlayersReady = Object.values(room.players).every(p => p.isReady);
                if (allPlayersReady) {
                    Object.values(room.players).forEach(p => p.isReady = false);
                    startNewRound(roomId, room);
                } else {
                    socket.to(roomId).emit('gameEvent', { event: 'playerReady' });
                }
                break;
            default:
                socket.to(roomId).emit('gameEvent', data);
                break;
        }
    });

    socket.on('disconnect', () => {
        const disconnectedSocketId = socket.id;
        console.log(`❌ Utente disconnesso: ${disconnectedSocketId}`);
        // Rimuovi dalla coda di matchmaking casuale
        matchmakingQueue = matchmakingQueue.filter(player => player.socket.id !== disconnectedSocketId);
        
        // *** INIZIO BLOCCO MODIFICATO: Pulisci anche le stanze private ***
        const privateRoomCode = Object.keys(privateRooms).find(
            code => privateRooms[code].creatorSocket.id === disconnectedSocketId
        );
        if (privateRoomCode) {
            delete privateRooms[privateRoomCode];
            console.log(`Stanza privata ${privateRoomCode} eliminata a causa della disconnessione del creatore.`);
        }
        // *** FINE BLOCCO MODIFICATO ***
        
        // Gestisci l'abbandono di una partita in corso
        let roomIdFound = null;
        for (const roomId in gameRooms) {
            if (gameRooms[roomId].players[disconnectedSocketId]) {
                roomIdFound = roomId;
                break;
            }
        }
        if (roomIdFound) {
            handleMatchAbandonment(roomIdFound, disconnectedSocketId);
        }
    });
});

server.listen(PORT, () => {
  console.log(`🚀 Server in ascolto sulla porta ${PORT}`);
});