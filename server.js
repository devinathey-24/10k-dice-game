const express = require('express');
const crypto = require('crypto');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.use(express.static('public'));

// --- THE MASTER GAME STATE ---
let gameState = {
    status: 'SETUP', 
    mode: null,
    playersData: [],
    currentPlayer: 0,
    diceValues: [1, 1, 1, 1, 1, 1],
    lockedDice: [false, false, false, false, false, false],
    heldDice: [false, false, false, false, false, false],
    turnScore: 0,
    currentRollScore: 0,
    hasRolledThisTurn: false,
    isLastTurn: false,
    playerWhoStartedLastTurn: -1,
    message: "Waiting to start..."
};

// --- SPAM PREVENTION LOCK ---
let isTransitioning = false; 

// Each human player can be controlled by only one connected device.
const socketAssignments = new Map(); 
const playerSockets = new Map();     

// Multiplayer lobby
const lobbyPlayers = new Map(); 
let lobbyHostSocketId = null;
const MAX_MULTIPLAYER_PLAYERS = 4;

function normalizeName(value) {
    const clean = String(value || '').trim().slice(0, 12);
    return (clean || 'PLAYER').toUpperCase();
}

function getLobbyPayload(forSocketId) {
    const playerCount = lobbyPlayers.size;
    const players = Array.from(lobbyPlayers.entries()).map(([socketId, player]) => ({
        name: player.name,
        isHost: socketId === lobbyHostSocketId,
        isYou: socketId === forSocketId
    }));

    return {
        playerCount,
        maxPlayers: MAX_MULTIPLAYER_PLAYERS,
        isHost: forSocketId === lobbyHostSocketId,
        canStart: forSocketId === lobbyHostSocketId && playerCount >= 2,
        players
    };
}

function broadcastLobby() {
    for (const [socketId] of lobbyPlayers) {
        const s = io.sockets.sockets.get(socketId);
        if (!s) continue;
        s.emit('lobby-update', getLobbyPayload(socketId));
    }
}

function removeFromLobby(socket) {
    const wasInLobby = lobbyPlayers.delete(socket.id);

    if (lobbyHostSocketId === socket.id) {
        lobbyHostSocketId = lobbyPlayers.keys().next().value || null;
    }

    socket.emit('lobby-left');
    broadcastLobby();
    return wasInLobby;
}

function clearLobby() {
    lobbyPlayers.clear();
    lobbyHostSocketId = null;
}

function resetToSetup() {
    clearLobby();
    socketAssignments.clear();
    playerSockets.clear();
    isTransitioning = false;

    gameState.status = 'SETUP';
    gameState.mode = null;
    gameState.playersData = [];
    gameState.currentPlayer = 0;
    gameState.diceValues = [1, 1, 1, 1, 1, 1];
    gameState.lockedDice = [false, false, false, false, false, false];
    gameState.heldDice = [false, false, false, false, false, false];
    gameState.turnScore = 0;
    gameState.currentRollScore = 0;
    gameState.hasRolledThisTurn = false;
    gameState.isLastTurn = false;
    gameState.playerWhoStartedLastTurn = -1;
    gameState.message = 'Waiting to start...';

    io.emit('assignment-reset');
    io.emit('sync-state', gameState);
}

// --- NEW ROLL-OFF LOGIC ---
function determineFirstPlayer(players) {
    let maxRoll = 0;
    let winners = [];
    let rollText = [];

    // Loop until there is only ONE winner (handles ties automatically by rerolling)
    while (winners.length !== 1) {
        maxRoll = 0;
        winners = [];
        rollText = [];
        
        for (let i = 0; i < players.length; i++) {
            let roll = crypto.randomInt(1, 7);
            rollText.push(`${players[i].name} (${roll})`);
            
            if (roll > maxRoll) {
                maxRoll = roll;
                winners = [i];
            } else if (roll === maxRoll) {
                winners.push(i);
            }
        }
    }
    
    return {
        winnerIndex: winners[0],
        message: `Roll-off: ${rollText.join(', ')}. ${players[winners[0]].name} starts!`
    };
}

function resetAndStartGame(players, mode) {
    socketAssignments.clear();
    playerSockets.clear();
    io.emit('assignment-reset');
    isTransitioning = false;

    // BAD LUCK PROTECTION: Initialize the streak tracker for all players
    players.forEach(p => p.consecutiveBusts = 0);

    const rollOff = determineFirstPlayer(players);

    gameState.mode = mode;
    gameState.playersData = players;
    gameState.status = 'PLAYING';
    gameState.currentPlayer = rollOff.winnerIndex;
    gameState.turnScore = 0;
    gameState.currentRollScore = 0;
    gameState.isLastTurn = false;
    gameState.playerWhoStartedLastTurn = -1;
    gameState.hasRolledThisTurn = false;
    gameState.diceValues = [1, 1, 1, 1, 1, 1];
    gameState.lockedDice.fill(false);
    gameState.heldDice.fill(false);
    gameState.message = rollOff.message;
}

function getAssignmentSnapshot() {
    return gameState.playersData.map((p, i) => ({
        playerIndex: i,
        playerName: p.name,
        type: p.type,
        claimed: playerSockets.has(i)
    }));
}

function broadcastAssignments() {
    io.emit('player-assignments', getAssignmentSnapshot());
}

function releasePlayer(socket, notifySocket = true) {
    const oldIndex = socketAssignments.get(socket.id);
    if (oldIndex === undefined) return;

    socketAssignments.delete(socket.id);
    if (playerSockets.get(oldIndex) === socket.id) {
        playerSockets.delete(oldIndex);
    }

    if (notifySocket) socket.emit('player-released');
    broadcastAssignments();
}

function claimPlayer(socket, playerIndex) {
    if (gameState.status !== 'PLAYING' && gameState.status !== 'GAME_OVER') {
        socket.emit('claim-denied', 'Start the game before choosing a player.');
        return false;
    }

    if (!Number.isInteger(playerIndex) || !gameState.playersData[playerIndex]) {
        socket.emit('claim-denied', 'That player does not exist.');
        return false;
    }

    if (gameState.playersData[playerIndex].type !== 'human') {
        socket.emit('claim-denied', 'CPU players are controlled by the server.');
        return false;
    }

    const ownerSocketId = playerSockets.get(playerIndex);
    if (ownerSocketId && ownerSocketId !== socket.id) {
        socket.emit('claim-denied', `${gameState.playersData[playerIndex].name} is already in use on another device.`);
        return false;
    }

    const oldIndex = socketAssignments.get(socket.id);
    if (oldIndex !== undefined && oldIndex !== playerIndex && playerSockets.get(oldIndex) === socket.id) {
        playerSockets.delete(oldIndex);
    }

    socketAssignments.set(socket.id, playerIndex);
    playerSockets.set(playerIndex, socket.id);
    socket.emit('player-assigned', {
        playerIndex,
        playerName: gameState.playersData[playerIndex].name
    });
    broadcastAssignments();
    return true;
}

function canControlCurrentPlayer(socket) {
    if (gameState.status !== 'PLAYING') return false;
    if (isTransitioning) return false; 
    
    const assignedIndex = socketAssignments.get(socket.id);
    return assignedIndex === gameState.currentPlayer &&
           gameState.playersData[gameState.currentPlayer]?.type === 'human';
}

function calculateScore(values) {
    if (values.length === 0) return 0;
    let score = 0;
    const counts = [0, 0, 0, 0, 0, 0];
    
    values.forEach(v => counts[v - 1]++);

    if (counts.every(c => c === 1)) return 1500; 

    for (let i = 0; i < 6; i++) {
        let count = counts[i];
        let faceValue = i + 1;

        if (count >= 3) {
            let base = (faceValue === 1) ? 1000 : faceValue * 100;
            let multiplier = 1;
            if (count === 4) multiplier = 2;
            if (count === 5) multiplier = 3;
            if (count === 6) multiplier = 4;
            score += base * multiplier;
        } 
        else if (faceValue === 1) {
            score += count * 100; 
        } 
        else if (faceValue === 5) {
            score += count * 50;
        }
    }
    return score;
}

// --- DYNAMIC MESSAGE LOGIC ---
function getWinningTarget() {
    return Math.max(...gameState.playersData.map(p => p.totalScore));
}

function updateActiveMessage() {
    let p = gameState.playersData[gameState.currentPlayer];
    let potentialTotal = gameState.turnScore + gameState.currentRollScore;
    
    if (gameState.isLastTurn) {
        let target = getWinningTarget();
        let needed = (target + 1) - (p.totalScore + potentialTotal);
        if (needed > 0) {
            gameState.message = `Final Turn! You need ${needed} more to take the lead.`;
        } else {
            gameState.message = `You took the lead! Bank to finish!`;
        }
    } else {
        if (gameState.currentRollScore > 0) {
            if (!p.isOnBoard && potentialTotal < 1000) {
                gameState.message = `You need 1,000 to get on the board (Current: ${potentialTotal})`;
            } else {
                gameState.message = "Tap scoring dice to hold them.";
            }
        } else {
            gameState.message = !p.isOnBoard ? "You need 1,000 points to get on the board." : "Tap scoring dice to hold them.";
        }
    }
}

// --- CORE RULE EXECUTION ---
function executeRoll() {
    if (gameState.status !== 'PLAYING') return false;

    if (gameState.hasRolledThisTurn) {
        gameState.turnScore += gameState.currentRollScore;
        gameState.currentRollScore = 0;
        for (let i = 0; i < 6; i++) {
            if (gameState.heldDice[i]) {
                gameState.lockedDice[i] = true;
                gameState.heldDice[i] = false;
            }
        }
    }

    gameState.hasRolledThisTurn = true;

    if (gameState.lockedDice.every(locked => locked)) {
        gameState.lockedDice.fill(false);
        gameState.heldDice.fill(false);
    }

    let p = gameState.playersData[gameState.currentPlayer];
    let currentRollValues = [];
    let isBust = true;
    
    // BAD LUCK PROTECTION: Secret background rerolls if on a losing streak
    let maxAttempts = p.consecutiveBusts >= 2 ? 3 : 1; 
    let attempts = 0;

    while (isBust && attempts < maxAttempts) {
        currentRollValues = [];
        for (let i = 0; i < 6; i++) {
            if (!gameState.lockedDice[i]) {
                const val = crypto.randomInt(1, 7); 
                currentRollValues.push(val);
            }
        }
        
        if (calculateScore(currentRollValues) > 0) {
            isBust = false; 
        }
        attempts++;
    }

    let rollIndex = 0;
    for (let i = 0; i < 6; i++) {
        if (!gameState.lockedDice[i]) {
            gameState.diceValues[i] = currentRollValues[rollIndex];
            gameState.heldDice[i] = false;
            rollIndex++;
        }
    }

    let pName = p.name;

    if (isBust) {
        p.consecutiveBusts++; // Streak continues
        gameState.message = `${pName} BUSTED! Turn over.`;
        gameState.turnScore = 0;
        gameState.currentRollScore = 0;
        
        io.emit('dice-rolled', gameState);
        io.emit('bust', gameState.currentPlayer); 
        io.emit('sync-state', gameState);
        
        isTransitioning = true;
        setTimeout(() => { 
            isTransitioning = false;
            nextTurn(); 
        }, 2000);
        return false; 
    }

    updateActiveMessage();
    io.emit('dice-rolled', gameState);
    return true; 
}

function executeToggleHold(index) {
    if (gameState.lockedDice[index] || !gameState.hasRolledThisTurn) return;
    
    gameState.heldDice[index] = !gameState.heldDice[index];
    
    let newlyHeldValues = gameState.diceValues.filter((_, i) => gameState.heldDice[i] && !gameState.lockedDice[i]);
    gameState.currentRollScore = calculateScore(newlyHeldValues);
    
    updateActiveMessage();
    io.emit('sync-state', gameState);
}

function executeBank() {
    // BAD LUCK PROTECTION: Reset the streak tracker because they scored
    gameState.playersData[gameState.currentPlayer].consecutiveBusts = 0;

    gameState.turnScore += gameState.currentRollScore;
    gameState.playersData[gameState.currentPlayer].totalScore += gameState.turnScore;
    gameState.playersData[gameState.currentPlayer].isOnBoard = true; 
    
    let pName = gameState.playersData[gameState.currentPlayer].name;

    if (gameState.playersData[gameState.currentPlayer].totalScore >= 10000 && !gameState.isLastTurn) {
        gameState.isLastTurn = true;
        gameState.playerWhoStartedLastTurn = gameState.currentPlayer;
        gameState.message = `${pName} crossed 10,000! Final round begins!`;
    } else {
        gameState.message = `${pName} banked!`;
    }

    io.emit('banked', { playerIndex: gameState.currentPlayer, score: gameState.turnScore });
    io.emit('sync-state', gameState);

    isTransitioning = true;
    setTimeout(() => {
        gameState.turnScore = 0;
        gameState.currentRollScore = 0;
        isTransitioning = false;
        nextTurn();
    }, 2000);
}

function nextTurn() {
    if (gameState.status !== 'PLAYING') return;

    gameState.heldDice.fill(false);
    gameState.lockedDice.fill(false);
    gameState.hasRolledThisTurn = false;
    gameState.turnScore = 0;
    gameState.currentRollScore = 0;

    gameState.currentPlayer = (gameState.currentPlayer + 1) % gameState.playersData.length;

    if (gameState.isLastTurn && gameState.currentPlayer === gameState.playerWhoStartedLastTurn) {
        declareWinner();
        return;
    }

    let p = gameState.playersData[gameState.currentPlayer];
    
    if (gameState.isLastTurn) {
        let target = getWinningTarget();
        let needed = (target + 1) - p.totalScore;
        gameState.message = `Final Turn! You need ${needed} to take the lead. Roll the dice!`;
    } else {
        gameState.message = !p.isOnBoard ? `${p.name}'s turn! Get 1,000 to get on the board.` : `${p.name}'s turn! Roll the dice.`;
    }

    io.emit('new-turn');
    io.emit('sync-state', gameState);

    triggerCpuTurn();
}

function declareWinner() {
    let winningScore = -1;
    let winnerIndex = -1;
    let isTie = false;

    gameState.playersData.forEach((p, i) => {
        if (p.totalScore > winningScore) {
            winningScore = p.totalScore;
            winnerIndex = i;
            isTie = false;
        } else if (p.totalScore === winningScore) {
            isTie = true;
        }
    });

    if (isTie) {
        gameState.message = "🤝 IT'S A TIE! 🤝";
    } else {
        gameState.message = `🏆 ${gameState.playersData[winnerIndex].name} WINS! 🏆`;
    }
    gameState.status = 'GAME_OVER';
    io.emit('game-over');
    io.emit('sync-state', gameState);
}

// --- SERVER-SIDE CPU AI ---
function triggerCpuTurn() {
    let p = gameState.playersData[gameState.currentPlayer];
    if (p.type !== 'cpu' || gameState.status !== 'PLAYING') return;

    setTimeout(() => {
        if (gameState.playersData[gameState.currentPlayer].type !== 'cpu') return;
        
        let safe = executeRoll();
        if (!safe) return; 
        
        setTimeout(() => {
            if (gameState.status !== 'PLAYING' || gameState.playersData[gameState.currentPlayer].type !== 'cpu') return;
            
            holdCpuDice();
            
            setTimeout(() => {
                if (gameState.status !== 'PLAYING' || gameState.playersData[gameState.currentPlayer].type !== 'cpu') return;
                
                if (cpuShouldBank()) {
                    executeBank();
                } else {
                    triggerCpuTurn(); 
                }
            }, 1300);
        }, 1300);
    }, 1500);
}

function holdCpuDice() {
    let counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6; i++) {
        if (!gameState.lockedDice[i]) counts[gameState.diceValues[i] - 1]++;
    }

    let isStraight = counts.every(c => c === 1);

    for (let i = 0; i < 6; i++) {
        if (!gameState.lockedDice[i] && !gameState.heldDice[i]) {
            let val = gameState.diceValues[i];
            if (isStraight) {
                executeToggleHold(i);
            } else if (val === 1 || val === 5 || counts[val - 1] >= 3) {
                executeToggleHold(i);
            }
        }
    }
}

function cpuShouldBank() {
    let totalPotential = gameState.turnScore + gameState.currentRollScore;
    let remainingDice = 6 - (gameState.heldDice.filter(Boolean).length + gameState.lockedDice.filter(Boolean).length);
    let isHotDice = false;

    if (remainingDice === 0) {
        remainingDice = 6; 
        isHotDice = true;
    }
    
    let maxOpponentScore = 0;
    gameState.playersData.forEach((p, i) => {
        if (i !== gameState.currentPlayer && p.totalScore > maxOpponentScore) {
            maxOpponentScore = p.totalScore;
        }
    });

    if (!gameState.playersData[gameState.currentPlayer].isOnBoard) {
        if (isHotDice) return false; 
        if (totalPotential >= 1000) return true; 
        return false; 
    }

    if (gameState.isLastTurn) {
        if (gameState.playersData[gameState.currentPlayer].totalScore + totalPotential > maxOpponentScore) return true; 
        else return false; 
    }

    if (gameState.playersData[gameState.currentPlayer].totalScore + totalPotential >= 10000) return true;
    if (isHotDice) return false; 
    if (remainingDice === 1) return true;
    if (remainingDice <= 2 && totalPotential >= 250) return true;
    if (remainingDice <= 3 && totalPotential >= 450) return true;
    if (remainingDice <= 4 && totalPotential >= 1000) return true; 
    if (totalPotential >= 1500) return true;

    return false;
}

function leaveActiveMultiplayerGame(socket, disconnected = false) {
    if (gameState.mode !== 'multiplayer' ||
        !['PLAYING', 'GAME_OVER', 'ABANDONED'].includes(gameState.status)) {
        if (!disconnected) socket.emit('left-game');
        return false;
    }

    const playerIndex = socketAssignments.get(socket.id);

    if (playerIndex === undefined) {
        if (!disconnected) socket.emit('left-game');
        return false;
    }

    const playerName = gameState.playersData[playerIndex]?.name || 'A PLAYER';
    const wasPlaying = gameState.status === 'PLAYING';

    releasePlayer(socket, false);

    if (wasPlaying) {
        gameState.status = 'ABANDONED';
        gameState.message = `${playerName} left the game.`;
        gameState.turnScore = 0;
        gameState.currentRollScore = 0;
        gameState.hasRolledThisTurn = false;
        gameState.heldDice.fill(false);
        gameState.lockedDice.fill(false);
    }

    if (!disconnected) socket.emit('left-game');

    if (playerSockets.size === 0) {
        resetToSetup();
    } else if (wasPlaying) {
        socket.broadcast.emit('sync-state', gameState);
    }

    return true;
}

// --- NETWORK LISTENER ---
io.on('connection', (socket) => {
    console.log('A screen connected to the table!');

    socket.emit('sync-state', gameState);
    socket.emit('player-assignments', getAssignmentSnapshot());

    socket.on('join-multiplayer', (data = {}) => {
        if (gameState.status !== 'SETUP') {
            socket.emit('lobby-error', 'A game is already in progress.');
            return;
        }

        if (!lobbyPlayers.has(socket.id) && lobbyPlayers.size >= MAX_MULTIPLAYER_PLAYERS) {
            socket.emit('lobby-error', 'This multiplayer game is full.');
            return;
        }

        const name = normalizeName(data.name);
        lobbyPlayers.set(socket.id, { name, joinedAt: Date.now() });
        if (!lobbyHostSocketId) lobbyHostSocketId = socket.id;

        socket.emit('lobby-joined', getLobbyPayload(socket.id));
        broadcastLobby();
    });

    socket.on('leave-multiplayer', () => {
        removeFromLobby(socket);
    });

    socket.on('start-local-game', (data = {}) => {
        if (gameState.status !== 'SETUP') return;

        clearLobby();
        const cpuCount = Math.max(1, Math.min(3, Number(data.cpuCount) || 1));
        const players = [{
            name: normalizeName(data.name),
            type: 'human',
            totalScore: 0,
            isOnBoard: false,
            consecutiveBusts: 0 
        }];

        for (let i = 1; i <= cpuCount; i++) {
            players.push({
                name: `CPU ${i}`,
                type: 'cpu',
                totalScore: 0,
                isOnBoard: false,
                consecutiveBusts: 0 
            });
        }

        resetAndStartGame(players, 'local');
        claimPlayer(socket, 0);
        io.emit('sync-state', gameState);
        broadcastAssignments();
        triggerCpuTurn();
    });

    socket.on('start-multiplayer-game', () => {
        if (gameState.status !== 'SETUP') return;
        if (socket.id !== lobbyHostSocketId) {
            socket.emit('lobby-error', 'Only the host can start the game.');
            return;
        }
        if (lobbyPlayers.size < 2) {
            socket.emit('lobby-error', 'At least 2 players are needed.');
            return;
        }

        const entries = Array.from(lobbyPlayers.entries());
        const players = entries.map(([, p]) => ({
            name: p.name,
            type: 'human',
            totalScore: 0,
            isOnBoard: false,
            consecutiveBusts: 0 
        }));

        resetAndStartGame(players, 'multiplayer');

        entries.forEach(([socketId], playerIndex) => {
            const playerSocket = io.sockets.sockets.get(socketId);
            if (!playerSocket) return;
            socketAssignments.set(socketId, playerIndex);
            playerSockets.set(playerIndex, socketId);
            playerSocket.emit('player-assigned', {
                playerIndex,
                playerName: players[playerIndex].name
            });
        });

        clearLobby();
        io.emit('sync-state', gameState);
        broadcastAssignments();
    });

    socket.on('leave-game', () => {
        if (gameState.mode === 'local') {
            socket.emit('left-game');
            resetToSetup();
        } else {
            leaveActiveMultiplayerGame(socket, false);
        }
    });

    socket.on('roll-dice', () => {
        if (!canControlCurrentPlayer(socket)) {
            socket.emit('action-denied', 'It is not your turn.');
            return;
        }
        executeRoll();
    });

    socket.on('toggle-hold', (index) => {
        if (!canControlCurrentPlayer(socket)) {
            socket.emit('action-denied', 'It is not your turn.');
            return;
        }
        executeToggleHold(Number(index));
    });

    socket.on('bank-score', () => {
        if (!canControlCurrentPlayer(socket)) {
            socket.emit('action-denied', 'It is not your turn.');
            return;
        }
        executeBank();
    });

    socket.on('bank-all', () => {
        if (!canControlCurrentPlayer(socket)) {
            socket.emit('action-denied', 'It is not your turn.');
            return;
        }

        // Fire the CPU logic to automatically hold all remaining point-yielding dice
        holdCpuDice();

        let p = gameState.playersData[gameState.currentPlayer];
        let potentialTotal = gameState.turnScore + gameState.currentRollScore;

        // Make sure there are actually points to bank
        if (gameState.currentRollScore === 0) {
            socket.emit('action-denied', 'No scoring dice available to bank!');
            return;
        }

        // Make sure they meet the 1000 point requirement if they aren't on the board
        if (!p.isOnBoard && potentialTotal < 1000) {
            socket.emit('action-denied', `You need 1,000 points to get on the board. You only have ${potentialTotal}.`);
            return;
        }

        executeBank();
    });

    socket.on('play-again', () => {
        if (gameState.status !== 'GAME_OVER') return;

        gameState.playersData.forEach(p => {
            p.totalScore = 0;
            p.isOnBoard = false;
            p.consecutiveBusts = 0;
        });

        const rollOff = determineFirstPlayer(gameState.playersData);

        gameState.status = 'PLAYING';
        gameState.currentPlayer = rollOff.winnerIndex;
        gameState.turnScore = 0;
        gameState.currentRollScore = 0;
        gameState.isLastTurn = false;
        gameState.playerWhoStartedLastTurn = -1;
        gameState.hasRolledThisTurn = false;
        gameState.diceValues = [1, 1, 1, 1, 1, 1];
        gameState.lockedDice.fill(false);
        gameState.heldDice.fill(false);
        gameState.message = rollOff.message;
        isTransitioning = false;

        io.emit('game-restarted');
        io.emit('sync-state', gameState);
        triggerCpuTurn(); 
    });

    socket.on('disconnect', () => {
        if (gameState.status === 'SETUP') {
            removeFromLobby(socket);
        } else if (gameState.mode === 'multiplayer' && socketAssignments.has(socket.id)) {
            leaveActiveMultiplayerGame(socket, true);
        } else {
            releasePlayer(socket, false);
        }
        console.log('A screen disconnected from the table.');
    });
});

// Render provides its own port via process.env.PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});