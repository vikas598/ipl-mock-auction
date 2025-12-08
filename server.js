const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const initialPlayers = require('./players');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const ROOMS = {}; 
const ROOM_TIMERS = {}; 

const STARTING_PURSE = 1200000000; 
const DEFAULT_TIMER_DURATION = 60; 
const BID_RESET_TIMER = 20;
const MAX_OVERSEAS = 8; 

// --- HELPER: FISHER-YATES SHUFFLE ---
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function createNewGameState(adminId, adminName) {
    let allPlayers = JSON.parse(JSON.stringify(initialPlayers));
    const marqueeSet = allPlayers.filter(p => p.marquee === true);
    const regularSet = allPlayers.filter(p => p.marquee !== true);
    shuffleArray(marqueeSet);
    shuffleArray(regularSet);
    const sortedList = [...marqueeSet, ...regularSet];

    return {
        code: null,
        status: 'LOBBY', 
        settings: { min_squad: 18, max_squad: 25, default_timer: DEFAULT_TIMER_DURATION },
        users: { 
            [adminId]: { id: adminId, name: adminName, is_admin: true, team_id: null, is_interested: true, connected: true } 
        },
        teams: {},
        players: sortedList,
        current_player_index: -1,
        current_bid: 0,
        current_top_bidder: null,
        current_top_bidder_team: null,
        timer_duration: DEFAULT_TIMER_DURATION,
        timer_seconds: 0,
        is_timer_running: false,
        chat_messages: [], 
        activity_log: [],
        destroyTimer: null // NEW: Timer for delayed room deletion
    };
}

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

function getNextMinBid(currentBid, basePrice) {
    if (currentBid === 0) return basePrice;
    if (currentBid < 10000000) return currentBid + 500000;
    if (currentBid < 100000000) return currentBid + 2000000;
    return currentBid + 5000000;
}

function resetInterest(room) {
    Object.keys(room.users).forEach(uid => { room.users[uid].is_interested = true; });
}

function addSystemLog(room, message) {
    const logEntry = { type: 'system', text: message, timestamp: new Date().toISOString() };
    room.activity_log.push(logEntry);
    if (room.activity_log.length > 50) room.activity_log.shift();
    io.to(room.code).emit('log_update', logEntry);
}

function finalizeAndMoveOn(roomCode) {
    const room = ROOMS[roomCode];
    if (!room || room.status === 'SOLD_PAUSE') return;

    clearInterval(ROOM_TIMERS[roomCode]);
    room.is_timer_running = false;
    room.timer_seconds = room.settings.default_timer;

    if (room.current_player_index >= 0 && room.current_player_index < room.players.length) {
        const player = room.players[room.current_player_index];
        const winnerSocketId = room.current_top_bidder;

        room.status = 'SOLD_PAUSE';

        let resultMsg = "";
        if (winnerSocketId && room.teams[winnerSocketId]) {
            const winnerTeam = room.teams[winnerSocketId];
            winnerTeam.purse -= room.current_bid;
            winnerTeam.players.push({ ...player, sold_price: room.current_bid });
            if (player.nationality === 'Overseas') winnerTeam.overseas_count++;
            
            player.status = 'SOLD';
            player.sold_price = room.current_bid;
            player.sold_to = winnerTeam.name;
            
            const soldAmt = room.current_bid >= 10000000 
                ? `${(room.current_bid/10000000).toFixed(2)} Cr` 
                : `${(room.current_bid/100000).toFixed(2)} L`;

            resultMsg = `SOLD to ${winnerTeam.name} for ₹${soldAmt}`;
            io.to(roomCode).emit('player_sold', { winner: winnerTeam.name, amount: room.current_bid });
        } else {
            player.status = 'UNSOLD';
            resultMsg = `UNSOLD`;
            io.to(roomCode).emit('player_sold', { winner: 'UNSOLD', amount: 0 });
        }
        
        addSystemLog(room, `${player.name}: ${resultMsg}`);
        io.to(roomCode).emit('state_update', room);

        setTimeout(() => {
            const r = ROOMS[roomCode];
            if (!r) return;

            r.status = 'AUCTION';
            r.current_player_index++;
            r.current_bid = 0;
            r.current_top_bidder = null;
            r.current_top_bidder_team = null;
            resetInterest(r);

            if (r.current_player_index < r.players.length) {
                io.to(roomCode).emit('new_player_nominated', r);
                startRoomTimer(roomCode);
            } else {
                io.to(roomCode).emit('state_update', r); 
            }
        }, 5000); 
    } else {
        room.current_player_index++;
        io.to(roomCode).emit('new_player_nominated', room);
        startRoomTimer(roomCode);
    }
}

function checkAutoSellCondition(room) {
    if (room.status === 'SOLD_PAUSE') return;
    const activeTeams = Object.values(room.users).filter(u => u.team_id !== null && u.connected); 
    if (activeTeams.length < 2) return; 

    const winnerId = room.current_top_bidder;
    const opponents = activeTeams.filter(u => u.id !== winnerId);
    const allOpponentsNotInterested = opponents.every(u => u.is_interested === false);

    if (allOpponentsNotInterested) {
        io.to(room.code).emit('error_msg', "All teams Not Interested. Auto-selling in 3s...");
        setTimeout(() => {
            const currentWinner = room.current_top_bidder;
            if(winnerId !== currentWinner) return; 
            const reCheckOpponents = Object.values(room.users)
                .filter(u => u.team_id !== null && u.id !== currentWinner && u.connected);
            if(reCheckOpponents.every(u => u.is_interested === false)) {
                finalizeAndMoveOn(room.code);
            }
        }, 3000);
    }
}

function startRoomTimer(roomCode) {
    if (ROOM_TIMERS[roomCode]) clearInterval(ROOM_TIMERS[roomCode]);
    const room = ROOMS[roomCode];
    room.is_timer_running = true;
    io.to(roomCode).emit('timer_update', room.timer_seconds);

    ROOM_TIMERS[roomCode] = setInterval(() => {
        if (room.timer_seconds > 0) {
            room.timer_seconds--;
            io.to(roomCode).emit('timer_update', room.timer_seconds);
        } else {
            finalizeAndMoveOn(roomCode);
        }
    }, 1000);
}

io.on('connection', (socket) => {
    
    socket.on('create_room', (userName) => {
        const code = generateRoomCode();
        ROOMS[code] = createNewGameState(socket.id, userName);
        ROOMS[code].code = code;
        socket.join(code);
        socket.roomCode = code;
        socket.emit('room_joined', { code, is_admin: true, state: ROOMS[code] });
    });

    socket.on('join_room', ({ code, userName }) => {
        const roomCode = code.toUpperCase();
        const room = ROOMS[roomCode];
        if (!room) return socket.emit('error_msg', "Invalid Room Code");

        // CANCEL DESTRUCTION IF SOMEONE JOINS
        if (room.destroyTimer) {
            console.log(`Re-activation! Deletion cancelled for ${roomCode}`);
            clearTimeout(room.destroyTimer);
            room.destroyTimer = null;
        }
        
        const existingUserKey = Object.keys(room.users).find(key => room.users[key].name.toLowerCase() === userName.toLowerCase());
        if (existingUserKey) {
            const oldUserData = room.users[existingUserKey];
            room.users[socket.id] = { ...oldUserData, id: socket.id, connected: true };
            if (oldUserData.team_id) {
                const team = Object.values(room.teams).find(t => t.id === existingUserKey);
                if (team) { delete room.teams[existingUserKey]; team.id = socket.id; room.teams[socket.id] = team; }
            }
            if (room.current_top_bidder === existingUserKey) room.current_top_bidder = socket.id;
            delete room.users[existingUserKey];
        } else {
            if (room.status !== 'LOBBY') return socket.emit('error_msg', "Auction started! Cannot join as new player.");
            room.users[socket.id] = { id: socket.id, name: userName, is_admin: false, team_id: null, is_interested: true, connected: true };
        }

        socket.join(roomCode);
        socket.roomCode = roomCode;
        io.to(roomCode).emit('state_update', room);
        socket.emit('room_joined', { code: roomCode, is_admin: room.users[socket.id].is_admin, state: room });
    });

    socket.on('claim_team', (teamId) => {
        const room = ROOMS[socket.roomCode];
        if (!room) return;
        const existingOwner = Object.values(room.users).find(u => u.team_id === teamId);
        if(existingOwner && existingOwner.id !== socket.id) return socket.emit('error_msg', "Team already taken!");
        
        room.users[socket.id].team_id = teamId;
        room.teams[socket.id] = { 
            id: socket.id, 
            name: teamId, 
            owner_name: room.users[socket.id].name, 
            purse: STARTING_PURSE, 
            players: [], 
            overseas_count: 0 
        };
        io.to(room.code).emit('state_update', room);
    });

    socket.on('send_chat_message', (text) => {
        const room = ROOMS[socket.roomCode];
        const user = room?.users[socket.id];
        if (!room || !user) return;

        const msg = { 
            id: Date.now(), 
            user: user.name, 
            team: user.team_id || 'Spec', 
            text: text, 
            time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) 
        };
        room.chat_messages.push(msg);
        if(room.chat_messages.length > 50) room.chat_messages.shift();
        io.to(room.code).emit('chat_update', msg);
    });

    socket.on('admin_update_settings', (newSettings) => {
        const room = ROOMS[socket.roomCode];
        if (!room || !room.users[socket.id]?.is_admin) return;
        room.settings = { ...room.settings, ...newSettings };
        room.timer_duration = newSettings.default_timer; 
        io.to(room.code).emit('state_update', room);
    });
    socket.on('admin_start_game', () => {
        const room = ROOMS[socket.roomCode];
        if (room && room.users[socket.id]?.is_admin) {
            room.status = 'AUCTION';
            io.to(room.code).emit('state_update', room);
        }
    });
    socket.on('admin_start_timer', () => {
        const room = ROOMS[socket.roomCode];
        if (room?.users[socket.id]?.is_admin) startRoomTimer(room.code);
    });
    socket.on('admin_stop_timer', () => {
        const room = ROOMS[socket.roomCode];
        if (room?.users[socket.id]?.is_admin) {
            clearInterval(ROOM_TIMERS[room.code]);
            room.is_timer_running = false;
            io.to(room.code).emit('state_update', room);
        }
    });
    socket.on('admin_move_on', () => finalizeAndMoveOn(socket.roomCode));
    socket.on('admin_kick_user', (targetUserId) => {
        const room = ROOMS[socket.roomCode];
        if (!room || !room.users[socket.id]?.is_admin || targetUserId === socket.id) return;
        io.to(targetUserId).emit('kicked_from_room');
        if (room.teams[targetUserId]) delete room.teams[targetUserId];
        if (room.users[targetUserId]) delete room.users[targetUserId];
        const targetSocket = io.sockets.sockets.get(targetUserId);
        if (targetSocket) targetSocket.leave(socket.roomCode);
        io.to(socket.roomCode).emit('state_update', room);
    });
    socket.on('admin_transfer_role', (targetUserId) => {
        const room = ROOMS[socket.roomCode];
        if (!room || !room.users[socket.id]?.is_admin) return;
        if (!room.users[targetUserId]) return;
        room.users[socket.id].is_admin = false;
        room.users[targetUserId].is_admin = true;
        io.to(room.code).emit('state_update', room);
    });
    socket.on('toggle_interest', (isInterested) => {
        const room = ROOMS[socket.roomCode];
        if (!room) return;
        if (room.users[socket.id]) room.users[socket.id].is_interested = isInterested;
        checkAutoSellCondition(room);
    });
    socket.on('place_bid', () => {
        const room = ROOMS[socket.roomCode];
        if (!room) return;
        if (room.status === 'SOLD_PAUSE') return socket.emit('error_msg', "Round Ended. Wait for next player.");

        const team = room.teams[socket.id];
        const player = room.players[room.current_player_index];

        if (!team || !player) return;
        if (room.current_top_bidder === socket.id) return socket.emit('error_msg', "You hold the highest bid!");

        const nextBid = getNextMinBid(room.current_bid, player.base_price);
        if (team.purse < nextBid) return socket.emit('error_msg', "Insufficient Funds");
        if (team.players.length >= room.settings.max_squad) return socket.emit('error_msg', `Squad Limit Reached (${room.settings.max_squad})`);
        if (player.nationality === 'Overseas' && team.overseas_count >= MAX_OVERSEAS) return socket.emit('error_msg', `Overseas Limit Reached (${MAX_OVERSEAS})`);

        room.current_bid = nextBid;
        room.current_top_bidder = socket.id;
        room.current_top_bidder_team = team.name;
        room.timer_seconds = BID_RESET_TIMER; 
        resetInterest(room);

        const amountStr = nextBid >= 10000000 ? `₹${(nextBid/10000000).toFixed(2)} Cr` : `₹${(nextBid/100000).toFixed(2)} L`;
        addSystemLog(room, `${team.name} bid ${amountStr}`);

        io.to(room.code).emit('bid_update', { amount: nextBid, bidder_name: team.name });
        io.to(room.code).emit('timer_update', room.timer_seconds); 
    });

    socket.on('disconnect', () => {
        const roomCode = socket.roomCode;
        if (!roomCode || !ROOMS[roomCode]) return;
        const room = ROOMS[roomCode];
        const user = room.users[socket.id];
        if (!user) return;

        user.connected = false;

        // Auto-Promote Admin if they left
        if (user.is_admin) {
            const remainingUsers = Object.values(room.users).filter(u => u.connected);
            if (remainingUsers.length > 0) {
                remainingUsers[0].is_admin = true;
                io.to(roomCode).emit('error_msg', `Admin left. ${remainingUsers[0].name} is now Admin.`);
            } else {
                // If NO ONE is left, start the "Self Destruct" timer (2 Minutes)
                console.log(`Room ${roomCode} empty. Deleting in 2 mins...`);
                room.destroyTimer = setTimeout(() => {
                    delete ROOMS[roomCode];
                    if (ROOM_TIMERS[roomCode]) clearInterval(ROOM_TIMERS[roomCode]);
                }, 120000); // 120 Seconds grace period
                return;
            }
        }
        io.to(roomCode).emit('state_update', room);
    });
});

const PORT = 3000;
server.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });