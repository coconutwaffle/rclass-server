//server.js
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import https from 'https';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import mediasoup from 'mediasoup';

import config from './config.js';
import chat_handler from './handlers/chat.js';
import stream_handler from './handlers/stream.js';
import group_handler from './handlers/group.js';

import { mergeFullLogWithLessonTime, checkAttendance, lesson_handler } from './handlers/lesson.js';
import { archiveRoomToDB, store_room, add_attendees, room_handler } from './handlers/room.js';
import { ClassInfo, isClassActive, class_handler, getActiveClass, ClassInfoById } from './handlers/class.js';
import { create_account, LogIn, isLoggedIn, getLogOnId, guestLogin, getAccountByUUID } from './handlers/account.js';
import {attendance_handler} from './handlers/attendance.js';
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
app.use(express.static(__dirname + '/../public'));

const httpsOptions = {
    key: fs.readFileSync(__dirname + '/../certs/privkey.pem'),
    cert: fs.readFileSync(__dirname + '/../certs/fullchain.pem'),
};
const httpsServer = https.createServer(httpsOptions, app);
const io = new SocketIOServer(httpsServer, { allowEIO3: true });

httpsServer.listen(config.port, () => {
    console.log(`Server is running on https://${config.domain}:${config.port}`);
});

// --- Mediasoup setup ---
let workers = [];
let nextWorkerIdx = 0;
const rooms = {};

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
async function createRoom(creatorId, roomId, st_time, end_time, class_id, creator_uuid) {
    const worker = getMediasoupWorker();
    const router = await worker.createRouter({ mediaCodecs: config.mediasoup.router.mediaCodecs });
    let lesson_reserved = { st_time, end_time };

    if (st_time && !end_time) {
        lesson_reserved = {
        st_time,
        end_time: st_time + 60 * 60 * 1000 // 기본 1시간
        };
    }
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
        creator_uuid,
        creator_client_id: null, 
        lesson: {start_time: null, end_time: null, state: 'Not started'},
        lesson_reserved,
        notified: false,
        attendancePolicy: {
            min_part: 0.7,
            max_noappear: 5 * 60 * 1000,
            start_late: 5 * 60 * 1000,
            ealry_exit: 10 * 60* 1000
        },
        merged_log: null,
        attendance_result: null,
        class_id,
        roomId,
        session_no: Date.now(),
        db_room_id: null,
        clientIdToUUID: new Map(),
        UUIDToClientId: new Map(),
        UUIDToName: new Map(),
    };
}
async function can_destory_room(io, socket, room, context)
{
    let destory_flag = false;
    if (room.clients.size === 0) {
        if(room.lesson.state === 'Ended')
        {
            destory_flag = true;
        } else if(room.lesson.state === 'Started'){
            room.lesson.state === 'Ended'
            room.lesson.end_time = Date.now();
            const full_log = {};
            room.clients_log.forEach((clientLogMap, cid) => {
                if(cid !== room.creator_client_id)
                    full_log[cid] = Object.fromEntries(clientLogMap);
            });
            room.merged_log = mergeFullLogWithLessonTime(
                full_log,
                room.lesson.start_time,
                room.lesson.end_time
            );
            await checkAttendance(io, socket, room, context);
            if(!room.attendance_result)
            {
                console.log(`[can_destroy_room] bug: room.attendance_result`);
            }
            destory_flag = true
        } else if(room.lesson.state === 'Not started')
        {
            if(room.lesson_reserved.end_time)
            {
                if((Date.now() > room.lesson_reserved.end_time))
                {
                    destory_flag = true;
                }
            } else {
                destory_flag = true;
            }
        } else {
            console.log(`[can_destroy_room] bug room.lesson.state :${room.lesson.state}`);
            destory_flag = true
        }
    }
    return destory_flag;
}
/**
 * 클라이언트 데이터 생성 함수
 * @param {object} params
 * @param {object} params.socket - 소켓 객체
 * @param {string} params.clientId - 클라이언트 ID
 * @param {number} params.ts - 입장 타임스탬프
 * @returns {object} ClientData
 */
function createClientData({ socket, context, ts }) {
  return {
    socket,
    context,
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
    groups: new Map(),
    log_start: ts,
  };
}

// --- Socket.IO logic ---
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    const context = {
        clientId : null,
        roomId: null,
        logon_id: null,
        log_start: null,
        account_uuid: null,
        account_type: null,
        name: null,

    }
    lesson_handler(io, socket, rooms, context);
    group_handler(io, socket, rooms, context);
    stream_handler(io, socket, rooms, context, config);
    chat_handler(io, socket, rooms, context);
    class_handler(io, socket, rooms, context);
    room_handler(io, socket, rooms, context);
    attendance_handler(io, socket, rooms, context);
    socket.on('create_account', async (data, callback) => {
        try {
            const { id, name, pwd} = data;
            if (!id || !name || !pwd) {
                return callback({ result: false, data: 'id, name and pwd are required' });
            }
            const res = await create_account(id, name, pwd);
            callback({ result: true, data: res });
        } 
        catch (err) {
            console.error(`[ERROR] in 'create_account' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    })
    socket.on('login', async (data, callback) => {
        try {
            const { id, pwd} = data;
            if (!id || !pwd) {
                return callback({ result: false, data: 'id and pwd are required' });
            }
            if(await LogIn(id, pwd, context))
            {
                callback({ result: true, data: `${id} logged in` });
            } else
            {
                if(id === pwd) //TODO: remove this in production
                {
                    await create_account(id, 'test_account id: ' + id, pwd);
                    console.log(`Test account created`);
                    if(await LogIn(id, pwd, context))
                    {
                        return callback({ result: true, data: `${id} logged in` });
                    }
                }
                callback({ result: false, data: `id, pwd incorrect` });
            }
        } 
        catch (err) {
            console.error(`[ERROR] in 'login' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    })
    socket.on('join_room', async (data, callback) => {
        try {
            const { roomId, clientId } = data;
            if (!roomId || !clientId) {
                return callback({ result: false, data: 'roomId and clientId are required' });
            }
            if(!isLoggedIn(context))
            {
                await guestLogin(clientId, context);
            }
            context.name = clientId;
            let room = rooms[roomId];

            if (!room) {
                if(await isClassActive(roomId))
                {
                    console.log(`Class ${roomId} is reserved, checking reservation...`);
                    const class_id = await getActiveClass(roomId);
                    if(!class_id)
                    {
                        console.log(`Class ${roomId} is not active.`);
                        return callback({ result: false, data: `Class ${roomId} is not active.` });
                    }
                    const reserved_room = await ClassInfoById(class_id);
                    if(!reserved_room)
                    {
                        console.log(`Class ${roomId} info not found.`);
                        return callback({ result: false, data: `Class ${roomId} info not found.` });
                    }
                    if (reserved_room.tooEarly) {
                        if (reserved_room.creator !== context.account_uuid) {
                        // 일반 유저 → 입장 불가
                        console.warn(`[TOO EARLY REJECT] User ${context.account_uuid} tried to join class ${roomId} before start time.`);
                        return callback({ result: false, data: `Too early to join the class ${roomId}` });
                        } else {
                        // 선생님 → 입장은 허용, 하지만 로그를 남김
                        console.warn(`[FORCED ROOM CREATION] Teacher ${context.name} (${context.account_uuid}) is entering early.`);
                        console.warn(`Class ID: ${class_id}, Room ID: ${roomId}, Time: ${new Date().toISOString()}`);
                        }
                    }
                    const account = await getAccountByUUID(reserved_room.creator);
                    console.log(`Class ${roomId} is active, creator: ${JSON.stringify(account)}`);
                    console.log(`Creating a new room by ${reserved_room.lesson_start}, ${reserved_room.lesson_end}, ${reserved_room.class_id}`);
                    room = await createRoom(account.account_id, roomId, reserved_room.lesson_start, reserved_room.lesson_end, reserved_room.class_id, reserved_room.creator);
                } else{
                    console.log(`Creating a new room ${roomId} by ${clientId}`);
                    const lesson_start = data['lesson_start'];
                    const lesson_end = data['lesson_end'];
                    room = await createRoom(clientId, roomId, lesson_start, lesson_end, null, context.account_uuid);
                }
                await store_room(room, context);
                rooms[roomId] = room;
                console.log(`Room ${roomId} created.`);
            }

            if (room.clients.has(context.account_uuid)) {
                return callback({ result: false, data: `Client with name ${clientId} already in room ${roomId}` });
            }

            const ts = Date.now();
            context.clientId = clientId;
            context.roomId = roomId;
            const clientData = createClientData({ socket, context, ts });
            room.clients.set(context.account_uuid, clientData);
            if(!room.clients_log.has(context.account_uuid))
                room.clients_log.set(context.account_uuid, new Map());
            room.clients_log_isComplete.set(context.account_uuid, false);
            socket.join(roomId);
            if(room.creator === clientId)
            {
                room.creator_client_id = clientId;
            }
            if(isLoggedIn(context))
                console.log(`room.creator: ${room.creator}, logon_id: ${getLogOnId(context)}, clientId: ${clientId}`);
            else
                console.log(`room.creator: ${room.creator}`);
            console.log(`Client ${clientId} joined room ${roomId} creator: ${room.creator} me:${context.logon_id}`);
            callback({ result: true, data: { rtpCapabilities: room.router.rtpCapabilities , creator: (room.creator === context.logon_id)} });
            
            if(room.lesson.state === 'Started')
            {
                console.log(`lesson_start to joined: ${roomId} ${clientId}`);
                context.log_start = Date.now();
                const res = {start_ts:context.log_start};
                socket.emit('lesson_started',  res);
            }
            if (context.account_uuid) {
                add_attendees(room.db_room_id, context.account_uuid);
                room.clientIdToUUID.set(clientId, context.account_uuid);
                room.UUIDToClientId.set(context.account_uuid, clientId);
                room.UUIDToName.set(context.account_uuid, context.name);
            } else{
                throw new Error(`context.account_uuid is null`);
            }
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
            const clientData = room.clients.get(context.account_uuid);
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
    socket.on('disconnect', async () => {
        try {
            console.log(`Client disconnected: ${socket.id}`);
            if (!context.roomId || !context.clientId) return;

            const room = rooms[context.roomId];
            if (!room) return;

            const clientData = room.clients.get(context.account_uuid);
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

            room.clients.delete(context.account_uuid);
            console.log(`Client ${context.clientId} left room ${context.roomId}`);
            for (const key of room.clients.keys()) {
                console.log(`Client ${key} is stiil in room ${context.roomId}`);
            }

            const destory_flag = await can_destory_room(io, socket, room, context);
            if(destory_flag)
            {
                console.log(`Room ${context.roomId} is empty, closing router.`);
                room.router.close();
                await archiveRoomToDB(room);
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
