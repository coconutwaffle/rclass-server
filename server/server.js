//server.js
const os = require('os');
const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIO = require('socket.io');
const mediasoup = require('mediasoup');
const config = require('./config');
const chat_handler = require('./handlers/chat');
const stream_handler = require('./handlers/stream');
const group_handler = require('./handlers/group');
const lesson_handler = require('./handlers/lesson');

const app = express();
app.use(express.static(__dirname + '/../public'));

const httpsOptions = {
    key: fs.readFileSync(__dirname + '/../certs/privkey.pem'),
    cert: fs.readFileSync(__dirname + '/../certs/fullchain.pem'),
};
const httpsServer = https.createServer(httpsOptions, app);
const io = socketIO(httpsServer, { allowEIO3: true });

httpsServer.listen(config.port, () => {
    console.log(`Server is running on https://${config.domain}:${config.port}`);
});

// --- Mediasoup setup ---
let workers = [];
let nextWorkerIdx = 0;
const rooms = {};
const rooms_reserved = new Map();

async function runMediasoupWorkers() {
    const numWorkers = os.cpus().length;
    console.log(`Starting ${numWorkers} mediasoup workers...`);

    for (let i = 0; i < numWorkers; i++) {
        const worker = await mediasoup.createWorker({
            logLevel: config.mediasoup.logLevel,
            logTags: config.mediasoup.logTags,
            rtcMinPort: config.mediasoup.rtcMinPort,
            rtcMaxPort: config.mediasoup.rtcMaxPort,
        });

        worker.on('died', () => {
            console.error(`mediasoup worker ${worker.pid} has died`);
            setTimeout(() => process.exit(1), 2000);
        });
        workers.push(worker);
    }
}

function getMediasoupWorker() {
    const worker = workers[nextWorkerIdx];
    nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
    return worker;
}

runMediasoupWorkers();
/**
 * Room type 가이드.
 * @async
 * @param {string} creatorId - ID of the room creator
 * @returns {Promise<{
 *   router: import("mediasoup/lib/Router"),
 *   clients: Map<string, any>,
 *   groups: Map<number, any>,
 *   nextGroupId: number,
 *   chat_log: any[],
 *   last_seq: number,
 *   clients_log: Map<string, any>,
 *   clients_log_isComplete: Map<string, boolean>,
 *   creator: string,
 *   creator_client_id: string|null,
 *   lesson: {
 *     start_time: number|null,
 *     end_time: number|null,
 *     state: string
 *   }
 * }>}
 */
async function createRoom(creatorId) {
  const worker = getMediasoupWorker();
  const router = await worker.createRouter({ mediaCodecs: config.mediasoup.router.mediaCodecs });

  return { 
    router, 
    clients: new Map(), 
    groups: new Map(), 
    nextGroupId: 1, 
    chat_log: [], 
    last_seq: 0, 
    clients_log: new Map(), 
    clients_log_isComplete: new Map(), 
    creator: creatorId, 
    creator_client_id: null, 
    lesson: {start_time: null, end_time: null, state: 'Not started'} 
    };
}
/**
 * 클라이언트 데이터 생성 함수
 * @param {object} params
 * @param {object} params.socket - 소켓 객체
 * @param {string} params.clientId - 클라이언트 ID
 * @param {number} params.ts - 입장 타임스탬프
 * @returns {object} ClientData
 */
function createClientData({ socket, clientId, ts }) {
  return {
    socket,
    clientId,
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
    groups: new Map(),
    join_ts: ts,
  };
}

// --- Socket.IO logic ---
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    const context = {
        clientId : null,
        roomId: null,
        logon_id: null,
    }
    lesson_handler(io, socket, rooms, context);
    group_handler(io, socket, rooms, context);
    stream_handler(io, socket, rooms, context, config);
    chat_handler(io, socket, rooms, context);
    socket.on('login', (data, callback) => {
        try {
            ({ id, pwd} = data);
            if (!id || !pwd) {
                return callback({ result: false, data: 'id and pwd are required' });
            }
            if(id !== pwd)
            {
                //TODO DB
                //지금은 id === pwd 가정
            }
            context.logon_id = id;
            callback({ result: true, data: `${id} logged in` });
        } 
        catch (err) {
            console.error(`[ERROR] in 'login' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    })
    socket.on('create_room', async (data, callback) => {
        try {
            //TODO DB
            if(!context.logon_id)
            {
                return callback({result: false, data:'log on required'});
            }
            roomId_ = data['roomId']
            if(!roomId_)
            {
                return callback({result: false, data:'roomId is required'});
            }
            if(rooms.hasOwnProperty(roomId_) || rooms_reserved.has(roomId_))
            {
                return callback({result: false, data:"room already exists"});
            }
            rooms_reserved.set(roomId_, {'creator':context.logon_id});
            console.log(`Room ${roomId_} created/reserved.`);
            callback({ result: true, data: { rtpCapabilities: router.rtpCapabilities } });
            
        } catch(e)
        {
            console.error(`[ERROR] in 'create_room' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    })

    socket.on('join_room', async (data, callback) => {
        try {
            ({ roomId, clientId } = data);
            if (!roomId || !clientId) {
                return callback({ result: false, data: 'roomId and clientId are required' });
            }

            let room = rooms[roomId];

            if (!room) {
                if(rooms_reserved.has(roomId))
                {
                    //TODO DB extend
                    room = await createRoom(rooms_reserved.get(roomId)['creator']);
                    rooms_reserved.delete(roomId);
                } else{
                    room = await createRoom(clientId);
                }
                rooms[roomId] = room;
                console.log(`Room ${roomId} created.`);
            }

            if (room.clients.has(clientId)) {
                return callback({ result: false, data: `Client with ID ${clientId} already in room ${roomId}` });
            }

            const ts = Date.now();
            const clientData = createClientData({ socket,clientId, ts });
            room.clients.set(clientId, clientData);
            room.clients_log.set(clientId, new Map());
            room.clients_log.get(clientId).set(ts, {end_ts: ts, log: {}})
            room.clients_log_isComplete.set(context.clientId, false);
            socket.join(roomId);
            if(room.creator === context.logon_id || room.creator === clientId)
            {
                room.creator_client_id = clientId;
            }
            console.log(`room.creator: ${room.creator}, logon_id: ${context.logon_id}, clientId: ${clientId}`);
            console.log(`Client ${clientId} joined room ${roomId} creator: ${(room.creator === context.logon_id)}`);
            callback({ result: true, data: { rtpCapabilities: room.router.rtpCapabilities , creator: (room.creator === context.logon_id)} });
            
            if(room.lesson.state === 'Started')
            {
                console.log(`lesson_start to joined: ${roomId} ${clientId}`);
                const res = {start_ts:room.lesson.start_time};
                socket.emit('lesson_started',  res);
            }
            context.clientId = clientId;
            context.roomId = roomId;

        } catch (err) {
            console.error(`[ERROR] in 'join_room' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    });

    socket.on('get_online_users', (data, callback) => {
        try {
            const room = rooms[context.roomId];
            const clientData = room.clients.get(context.clientId);
            if (!room || !clientData) return callback({ result: false, data: 'Not in a room' });
            callback({ result: true, data: Array.from(room.clients.keys()) })
        } catch (err) {
            console.error(`[ERROR] in 'get_online_users' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    });
    socket.on('disconnect', () => {
        try {
            console.log(`Client disconnected: ${socket.id}`);
            if (!context.roomId || !context.clientId) return;

            const room = rooms[context.roomId];
            if (!room) return;

            const clientData = room.clients.get(context.clientId);
            if (!clientData) return;

            room.clients_log_isComplete.set(context.clientId, true);
            // Close all resources
            clientData.producers.forEach(p => p.close());
            clientData.consumers.forEach(c => c.close());
            clientData.transports.forEach(t => t.close());
            clientData.groups.forEach((groupData, groupId) => {
                room.groups.delete(groupId);
                socket.to(context.roomId).emit('update_group_one', { group_id: groupId, mode: 'delete', data: groupData });
            });

            room.clients.delete(context.clientId);
            console.log(`Client ${context.clientId} left room ${context.roomId}`);

            if ((room.clients.size === 0) && (room.lesson.state !== 'Not started')) {
                console.log(`Room ${context.roomId} is empty, closing router.`);
                room.router.close();
                //TODO
                // room.chat_log, clients_log, room.lesson.start_time, room.lesson.end_time  을 backup
                delete rooms[context.roomId];
            }
        } catch (err) {
            console.error(`[ERROR] in 'disconnect' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
        }
    });
});
