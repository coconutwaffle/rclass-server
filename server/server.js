//server.js
const os = require('os');
const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIO = require('socket.io');
const mediasoup = require('mediasoup');
const config = require('./config');
const crypto = require("crypto");
const { json } = require('stream/consumers');
const e = require('express');
const { join } = require('path');
const { log } = require('console');

const app = express();
app.use(express.static(__dirname + '/public'));

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
const rooms = {}; // { [roomId]: { router, clients: Map<clientId, clientData> , groups: Map<groupId, groupData>}, chat_log: [] }
const rooms_reserved = new Map();
function nextSeq(room) { return ++room.last_seq; }

// 유틸: 이진탐색(lowerBound/upperBound) — seq 오름차순 가정
function lowerBoundBySeq(arr, targetSeq) {
  let lo = 0, hi = arr.length; // 첫 >= target
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].seq >= targetSeq) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
function upperBoundBySeq(arr, targetSeq) {
  let lo = 0, hi = arr.length; // 첫 > target
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].seq > targetSeq) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

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

    let clientId = null;
    let roomId = null;
    let logon_id = null;
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
            logon_id = id;
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
            if(!logon_id)
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
            rooms_reserved.set(roomId_, {'creator':logon_id});
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
    socket.on('lesson_start', (data, callback) => {
        try {
            if(!logon_id)
            {
                return callback({result: false, data:'log on required'});
            }
            const room = rooms[roomId];
            if (!room) return callback({ result: false, data: 'Not in a room' });
            if(room.creator !== logon_id)
            {
                callback({result:false, data:'Not creator'});
            }
            if(room.lesson.state !== 'Not started')
            {
                return callback({result:false, data:'Already started'})
            }
            room.lesson.state = 'Started';
            room.lesson.start_time = Date.now();
            console.log(`lesson_start room: ${roomId}`)
            const res = {start_ts:room.lesson.start_time};
            socket.to(roomId).emit('lesson_started',  res)
            callback({result:true, data: res});
        } catch (e) {
            console.error(`[ERROR] in 'lesson_start' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    })
    socket.on('lesson_end', (data, callback) => {
        try {
            if(!logon_id)
            {
                return callback({result: false, data:'log on required'});
            }
            const room = rooms[roomId];
            if (!room) return callback({ result: false, data: 'Not in a room' });
            if(room.creator !== logon_id)
            {
                return callback({result:false, data:'Not creator'});
            }
            if(room.lesson.state === 'Not started')
            {
                return callback({result:false, data:'Not started'});
            }
            if(room.lesson.state === 'Ended')
            {
                return callback({result:false, data:'Already ended'});
            }
            room.lesson.state = 'Ended';
            room.lesson.end_time = Date.now();
            console.log(`lesson_end room: ${roomId}`);
            res = {start_ts:room.lesson.start_time, end_ts: room.lesson.end_time};
            socket.to(roomId).emit('lesson_ended', res);
            callback({result:true, data:res});
        } catch (e) {
            console.error(`[ERROR] in 'lesson_end' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    })
    socket.on('lesson_state', (data, callback) => {
        try {
            const room = rooms[roomId];
            if (!room) return callback({ result: false, data: 'Not in a room' });
            callback({result:true, data:{state: room.lesson.state}});
        } catch(e) {
            console.error(`[ERROR] in 'lesson_state' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    })
    socket.on('log_backup', (data, callback) => {
        try {
            if (!roomId || !clientId) {
                return callback({ result: false, data: 'roomId and clientId are required'});
            }
            ({log_} = data);
            if(!log_)
            {
                callback({result:false, data:'log is required'});
            }
            const ts = room.clients.get(clientId).join_ts;
            room.clients_log.get(clientId).set(ts, {end_ts: Date.now(), log:log_});
            callback({result:true, data:{join_ts:ts}});
            
        } catch(e) {
            console.error(`[ERROR] in 'log_backup' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    });
    socket.on('log_complete', (data, callback) => {
        try {
            if (!roomId || !clientId) {
                return callback({ result: false, data: 'roomId and clientId are required' });
            }
            let room = rooms[roomId];
            log_ = data['log'];
            if(!log_)
            {
                return callback({result:false, data:'log is required'});
            }
            console.log(JSON.stringify(log_));
            const ts = room.clients.get(clientId).join_ts;
            const perClientLog = room.clients_log.get(clientId);
            perClientLog.set(ts, { end_ts: Date.now(), log: log_ });

            room.clients_log_isComplete.set(clientId, true);
            
            let not_complete_list = [] 
            room.clients_log_isComplete.forEach((value, key) => {
                if(!value && key !== room.creator_client_id)
                {
                    console.log(`log_complete not complete ${key}`);
                    not_complete_list.push(key);
                }
            });
            
            
            if(not_complete_list.length  === 0)
            {
                console.log(`log_compelte all done`);
                const full_log = {};
                room.clients_log.forEach((clientLogMap, cid) => {
                    full_log[cid] = Object.fromEntries(clientLogMap);
                });
                const res = {
                    full_log, 
                    lesson_start : room.lesson.start_time, 
                    lesson_end: room.lesson.end_time
                };
                socket.to(roomId).emit('log_all_complete', res);
            }
            else
            {
                console.log(`log competle not all done`);
                console.log(JSON.stringify(not_complete_list));
            }
            kkk = {full_log: Object.fromEntries(perClientLog) };
            console.log(`ack log_complete to ${clientId}`); 
            callback({result: true, data: kkk});
            
        } catch(e) {
            console.error("log_complete error:", e);
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
            const clientData = createClientData({ socket, clientId, ts });
            room.clients.set(clientId, clientData);
            room.clients_log.set(clientId, new Map());
            room.clients_log.get(clientId).set(ts, {end_ts: null, log: {}})
            room.clients_log_isComplete.set(clientId, false);
            socket.join(roomId);
            if(room.creator === logon_id || room.creator === clientId)
            {
                room.creator_client_id = clientId;
            }
            console.log(`room.creator: ${room.creator}, logon_id: ${logon_id}, clientId: ${clientId}`);
            console.log(`Client ${clientId} joined room ${roomId} creator: ${(room.creator === logon_id)}`);
            callback({ result: true, data: { rtpCapabilities: room.router.rtpCapabilities , creator: (room.creator === logon_id)} });
            
            if(room.lesson.state === 'Started')
            {
                console.log(`lesson_start to joined: ${roomId} ${clientId}`);
                const res = {start_ts:room.lesson.start_time};
                socket.emit('lesson_started',  res);
            }


        } catch (err) {
            console.error(`[ERROR] in 'join_room' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    });

    socket.on('create_transport', async (data, callback) => {
        try {
            const room = rooms[roomId];
            if (!room) return callback({ result: false, data: 'Not in a room' });

            const transport = await room.router.createWebRtcTransport({
                ...config.webRtcTransport,
                listenIps: config.webRtcTransport.listenIps.map(ip => ({ ...ip, announcedIp: ip.announcedIp || config.domain })),
                enableSctp: true,
                enableUdp: true,
                enableTcp: true,
            });

            const clientData = room.clients.get(clientId);
            clientData.transports.set(transport.id, transport);
            const res_k = {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
                sctpParameters: transport.sctpParameters,
            }
            callback({
                result: true,
                data: res_k
            });
        } catch (error) {
            console.error(`[ERROR] in 'create_transport' handler:`, error);
            if (error instanceof Error) {
                console.error(error.stack);
            }
            callback({ result: false, data: error.message });
        }
    });

    socket.on('connect_transport', async (data, callback) => {
        try {
            const { transportId, dtlsParameters } = data;
            const room = rooms[roomId];
            const clientData = room.clients.get(clientId);
            if (!room || !clientData) return callback({ result: false, data: 'Not in a room' });

            const transport = clientData.transports.get(transportId);
            if (!transport) return callback({ result: false, data: 'Transport not found' });
            console.log(`[conntect_transport] roomId: ${roomId} clientId: ${clientId}`);
            await transport.connect({ dtlsParameters });
            callback({ result: true, data: null });
        } catch (error) {
            console.error(`[ERROR] in 'connect_transport' handler:`, error);
            if (error instanceof Error) {
                console.error(error.stack);
            }
            callback({ result: false, data: error.message });
        }
    });

    socket.on('produce', async (data, callback) => {
        try {
            const { transportId, kind, rtpParameters } = data;
            const room = rooms[roomId];
            const clientData = room.clients.get(clientId);
            if (!room || !clientData) return callback({ result: false, data: 'Not in a room' });

            const transport = clientData.transports.get(transportId);
            if (!transport) return callback({ result: false, data: 'Transport not found' });

            const producer = await transport.produce({ kind, rtpParameters });
            clientData.producers.set(producer.id, producer);

            producer.on('transportclose', () => {
                console.log(`Producer's transport closed: ${producer.id}`);
                clientData.producers.delete(producer.id);
            });

            callback({ result: true, data: { id: producer.id } });
        } catch (error) {
            console.error(`[ERROR] in 'produce' handler:`, error);
            if (error instanceof Error) {
                console.error(error.stack);
            }
            callback({ result: false, data: error.message });
        }
    });

    socket.on('set_group', (data, callback) => {
        try {
            const { groupId, video_id, audio_id } = data;
            const room = rooms[roomId];
            const clientData = room.clients.get(clientId);

            if (!room || !clientData) {
                return callback({ result: false, data: 'Not in a room' });
            }
            console.log(`groupId: ${groupId}, video_id: ${video_id}, audio_id: ${audio_id}`);
            // Validate IDs and set to "NULL" if invalid
            const final_video_id = clientData.producers.has(video_id) ? video_id : "NULL";
            const final_audio_id = clientData.producers.has(audio_id) ? audio_id : "NULL";

            // Case 1: Create a new group if groupId is 0 or not provided
            if (groupId == 0 || !groupId) {
                const newGroupId = room.nextGroupId++;
                const groupData = {
                    groupId: newGroupId,
                    video_id: final_video_id,
                    audio_id: final_audio_id,
                    clientId
                };

                room.groups.set(newGroupId, groupData);
                clientData.groups.set(newGroupId, groupData);

                console.log(`Group ${newGroupId} CREATED for client ${clientId}:`, groupData);
                socket.to(roomId).emit('update_group_one', { group_id: newGroupId, mode: 'create', data: groupData });
                callback({ result: true, data: groupData });
            }
            // Case 2: Edit an existing group
            else {
                const groupToEdit = room.groups.get(groupId);

                if (!groupToEdit) {
                    return callback({ result: false, data: `Group with ID ${groupId} not found.` });
                }
                if (groupToEdit.clientId !== clientId) {
                    return callback({ result: false, data: 'Not authorized to edit this group.' });
                }

                const updatedGroupData = {
                    ...groupToEdit,
                    video_id: final_video_id,
                    audio_id: final_audio_id
                };

                room.groups.set(groupId, updatedGroupData);
                clientData.groups.set(groupId, updatedGroupData); // Also update the client's own map

                console.log(`Group ${groupId} EDITED by client ${clientId}:`, updatedGroupData);
                socket.to(roomId).emit('update_group_one', { group_id: groupId, mode: 'edit', data: updatedGroupData });
                callback({ result: true, data: updatedGroupData });
            }
        } catch (err) {
            console.error(`[ERROR] in 'set_group' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    });
    socket.on('get_groups', (data, callback) => {
        try {
            const room = rooms[roomId];
            const clientData = room.clients.get(clientId);
            data = { groups: Array.from(room.groups.entries()) };
            callback({ result: true, data });
        } catch (err) {
            console.error(`[ERROR] in 'get_groups' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    })
    socket.on('del_group', (data, callback) => {
        try {
            const { groupId } = data;
            const room = rooms[roomId];
            const clientData = room.clients.get(clientId);

            if (!room || !clientData) {
                return callback({ result: false, data: 'Not in a room' });
            }

            const groupToDelete = room.groups.get(groupId);

            if (!groupToDelete) {
                return callback({ result: false, data: `Group with ID ${groupId} not found.` });
            }

            if (groupToDelete.clientId !== clientId) {
                return callback({ result: false, data: 'Not authorized to delete this group.' });
            }

            // Delete the group from the room and the client's list
            room.groups.delete(groupId);
            clientData.groups.delete(groupId);

            console.log(`Group ${groupId} DELETED by client ${clientId}`);

            // Notify everyone in the room
            socket.to(roomId).emit('update_group_one', { group_id: groupId, mode: 'delete', data: groupToDelete });

            callback({ result: true, data: { deletedGroupId: groupId } });
        } catch (err) {
            console.error(`[ERROR] in 'del_group' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    });

    socket.on('consume', async (data, callback) => {
        try {
            const { producerId, transportId } = data;
            const room = rooms[roomId];
            const clientData = room.clients.get(clientId);
            if (!room || !clientData) return callback({ result: false, data: 'Not in a room' });

            const transport = clientData.transports.get(transportId);
            if (!transport) return callback({ result: false, data: 'Transport not found' });

            if (!room.router.canConsume({ producerId, rtpCapabilities: clientData.rtpCapabilities })) {
                return callback({ result: false, data: 'Cannot consume this producer' });
            }

            const consumer = await transport.consume({
                producerId,
                rtpCapabilities: clientData.rtpCapabilities,
                paused: true,
            });
            clientData.consumers.set(consumer.id, consumer);

            consumer.on('transportclose', () => {
                clientData.consumers.delete(consumer.id);
            });
            consumer.on('producerclose', () => {
                clientData.consumers.delete(consumer.id);
            });

            callback({
                result: true,
                data: {
                    id: consumer.id,
                    producerId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                }
            });
        } catch (error) {
            console.error(`[ERROR] in 'consume' handler:`, error);
            if (error instanceof Error) {
                console.error(error.stack);
            }
            callback({ result: false, data: error.message });
        }
    });

    socket.on('store_rtp_capabilities', (data, callback) => {
        try {
            const room = rooms[roomId];
            const clientData = room.clients.get(clientId);
            if (clientData) {
                clientData.rtpCapabilities = data.rtpCapabilities;
            }
            callback({ result: true, data: null });
        } catch (err) {
            console.error(`[ERROR] in 'store_rtp_capabilities' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    });

    socket.on('resume_consumer', async (data, callback) => {
        try {
            const { consumerId } = data;
            const room = rooms[roomId];
            const clientData = room.clients.get(clientId);
            const consumer = clientData.consumers.get(consumerId);
            if (consumer) {
                await consumer.resume();
            }
            callback({ result: true, data: null });
        } catch (err) {
            console.error(`[ERROR] in 'resume_consumer' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    });

    socket.on("chat_send", async (data, callback) => {
        try {
            const room = rooms[roomId];
            if (!room) return callback?.({ result: false, data: "Not in a room" });

            const msgText = String(data?.msg ?? "");
            if (!msgText) return callback?.({ result: false, data: "empty message" });
            if (msgText.length > 4096) return callback?.({ result: false, data: "message_too_long" });

            const mode = data?.mode === "SECRET" ? "SECRET" : "ALL";
            const sendTo = Array.isArray(data?.send_to) ? data.send_to : [];

            const ts = Date.now();
            const seq = nextSeq(room);
            const msgId = `${roomId}-${seq}`;

            let recipients = [];
            const chat = {
                seq,
                msgId,
                ts,
                msg: msgText,
                mode,
                send_to: recipients,
                from: clientId,
            };
            if (mode !== "ALL") {
                const validTargets = new Set([clientId]);
                for (const cid of sendTo) {
                    if (room.clients.has(cid)) validTargets.add(cid);
                }

                if (validTargets.size === 1) {
                    return callback?.({ result: false, data: "no valid recipients" });
                }

                // recipients = 자기 자신 + 유효한 대상 전체
                recipients = [...validTargets];
                chat.send_to = recipients;
            }

            room.chat_log.push(chat);
            if (mode === "ALL") {
                console.log(`[${roomId}][${msgId}] ${clientId} to ALL: ${msgText}`);
                io.to(roomId).emit("chat_message", chat);
            }
            else {
                for (const cid of recipients) {
                    const entry = room.clients.get(cid);
                    console.log(`[${roomId}][${msgId}] ${clientId} to ${cid} (SECRET): ${msgText}`);
                    entry?.socket?.emit("chat_message", chat);
                }
            }
            callback?.({ result: true, data: { msgId, ts } });
        } catch (err) {
            console.error(`[ERROR] in 'chat_send' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback?.({ result: false, data: err.message });
        }
    });


    // 히스토리 요청
    socket.on("chat_history", async (data, callback) => {
        try {
            const room = rooms[roomId];
            if (!room) return callback?.({ result: false, data: "not_in_room" });

            // 0) 권한 필터 통과 메시지 배열(이미 seq 오름차순이라고 가정)
            const visible = room.chat_log.filter(m =>
                m.mode === "ALL" ||
                (m.mode === "SECRET" && (m.from === clientId || (Array.isArray(m.send_to) && m.send_to.includes(clientId))))
            );

            const DEFAULT_WINDOW = 50;
            const MAX_WINDOW = 200;

            // 1) 입력 정규화
            let startSeq = Number.isFinite(data?.start_seq) ? Number(data.start_seq) : undefined;
            let endSeq = Number.isFinite(data?.end_seq) ? Number(data.end_seq) : undefined;

            // visible이 비면 즉시 반환
            if (visible.length === 0) {
                return callback?.({ result: true, data: { messages: [], before_messages_number: 0, after_messages_number: 0 } });
            }

            const minSeq = visible[0].seq;
            const maxSeq = visible[visible.length - 1].seq;

            // 2) 기본 구간 보정
            if (startSeq == null && endSeq == null) {
                // 최신 꼬리 DEFAULT_WINDOW
                endSeq = maxSeq;
                startSeq = Math.max(minSeq, endSeq - (DEFAULT_WINDOW - 1));
            } else if (startSeq == null) {
                // end만 있음 → 뒤쪽 고정, 앞쪽으로 윈도 생성
                endSeq = Math.min(Math.max(endSeq, minSeq), maxSeq);
                startSeq = Math.max(minSeq, endSeq - (MAX_WINDOW - 1));
            } else if (endSeq == null) {
                // start만 있음 → 앞쪽 고정, 뒤로 윈도 생성
                startSeq = Math.min(Math.max(startSeq, minSeq), maxSeq);
                endSeq = Math.min(maxSeq, startSeq + (MAX_WINDOW - 1));
            } else {
                // 둘 다 있음 → 범위 정렬
                if (startSeq > endSeq) [startSeq, endSeq] = [endSeq, startSeq];
                // 서버 보호: 너무 큰 창이면 MAX_WINDOW로 클램프(뒤쪽 기준으로 맞추기)
                if (endSeq - startSeq + 1 > MAX_WINDOW) {
                    startSeq = endSeq - (MAX_WINDOW - 1);
                }
                // 경계 클램프
                startSeq = Math.max(minSeq, startSeq);
                endSeq = Math.min(maxSeq, endSeq);
            }

            // 3) 이진탐색으로 인덱스 범위 구하기 (포함형 [startSeq, endSeq])
            const left = lowerBoundBySeq(visible, startSeq);      // 첫 seq>=startSeq
            const right = upperBoundBySeq(visible, endSeq);        // 첫 seq> endSeq (배타)
            const messages = visible.slice(left, right);

            // 4) 남은 개수 계산 (권한 필터 이후 기준)
            const before_messages_number = left;                         // 구간 앞에 있는 개수
            const after_messages_number = visible.length - right;       // 구간 뒤에 있는 개수

            callback?.({
                result: true,
                data: {
                    messages,
                    before_messages_number,
                    after_messages_number
                }
            });
        } catch (err) {
            console.error(`[ERROR] in 'chat_history' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback?.({ result: false, data: err.message });
        }
    });

    socket.on('get_online_users', (data, callback) => {
        try {
            const room = rooms[roomId];
            const clientData = room.clients.get(clientId);
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
            if (!roomId || !clientId) return;

            const room = rooms[roomId];
            if (!room) return;

            const clientData = room.clients.get(clientId);
            if (!clientData) return;

            room.clients_log_isComplete.set(clientId, true);
            // Close all resources
            clientData.producers.forEach(p => p.close());
            clientData.consumers.forEach(c => c.close());
            clientData.transports.forEach(t => t.close());
            clientData.groups.forEach((groupData, groupId) => {
                room.groups.delete(groupId);
                socket.to(roomId).emit('update_group_one', { group_id: groupId, mode: 'delete', data: groupData });
            });

            room.clients.delete(clientId);
            console.log(`Client ${clientId} left room ${roomId}`);

            if ((room.clients.size === 0) && (room.lesson.state !== 'Not started')) {
                console.log(`Room ${roomId} is empty, closing router.`);
                room.router.close();
                //TODO
                // room.chat_log, clients_log, room.lesson.start_time, room.lesson.end_time  을 backup
                delete rooms[roomId];
            }
        } catch (err) {
            console.error(`[ERROR] in 'disconnect' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
        }
    });
});
