//server.js
const os = require('os');
const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIO = require('socket.io');
const mediasoup = require('mediasoup');
const config = require('./src/config');

const app = express();
app.use(express.static(__dirname + '/public'));

const httpsOptions = {
    key: fs.readFileSync(__dirname + '/certs/privkey.pem'),
    cert: fs.readFileSync(__dirname + '/certs/fullchain.pem'),
};
const httpsServer = https.createServer(httpsOptions, app);
const io = socketIO(httpsServer);

httpsServer.listen(config.port, () => {
    console.log(`Server is running on https://${config.domain}:${config.port}`);
});

// --- Mediasoup setup ---
let workers = [];
let nextWorkerIdx = 0;
const rooms = {}; // { [roomId]: { router, clients: Map<clientId, clientData> , groups: Map<groupId, groupData>} }

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

// --- Socket.IO logic ---
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    let clientId = null;
    let roomId = null;

    const respond = (event, data) => {
        socket.emit(event, data);
    };

    socket.on('join_room', async (data, callback) => {
        ({ roomId, clientId } = data);
        if (!roomId || !clientId) {
            return callback({ result: false, data: 'roomId and clientId are required' });
        }

        let room = rooms[roomId];
        if (room && room.clients.has(clientId)) {
            return callback({ result: false, data: `Client with ID ${clientId} already in room ${roomId}` });
        }

        if (!room) {
            const worker = getMediasoupWorker();
            const router = await worker.createRouter({ mediaCodecs: config.mediasoup.router.mediaCodecs });
            room = { router, clients: new Map(), groups: new Map(), nextGroupId: 1 };
            rooms[roomId] = room;
            console.log(`Room ${roomId} created.`);
        }

        const clientData = {
            socket,
            clientId,
            transports: new Map(),
            producers: new Map(),
            consumers: new Map(),
            groups: new Map(),
        };
        room.clients.set(clientId, clientData);
        socket.join(roomId);

        console.log(`Client ${clientId} joined room ${roomId}`);
        callback({ result: true, data: { rtpCapabilities: room.router.rtpCapabilities } });
    });

    socket.on('create_transport', async (data, callback) => {
        const room = rooms[roomId];
        if (!room) return callback({ result: false, data: 'Not in a room' });

        try {
            const transport = await room.router.createWebRtcTransport({
                ...config.webRtcTransport,
                listenIps: config.webRtcTransport.listenIps.map(ip => ({ ...ip, announcedIp: ip.announcedIp || config.domain })),
            });
            
            const clientData = room.clients.get(clientId);
            clientData.transports.set(transport.id, transport);

            callback({
                result: true,
                data: {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters,
                }
            });
        } catch (error) {
            console.error('Failed to create transport:', error);
            callback({ result: false, data: error.message });
        }
    });

    socket.on('connect_transport', async (data, callback) => {
        const { transportId, dtlsParameters } = data;
        const room = rooms[roomId];
        const clientData = room.clients.get(clientId);
        if (!room || !clientData) return callback({ result: false, data: 'Not in a room' });

        const transport = clientData.transports.get(transportId);
        if (!transport) return callback({ result: false, data: 'Transport not found' });

        try {
            await transport.connect({ dtlsParameters });
            callback({ result: true, data: null });
        } catch (error) {
            console.error('Failed to connect transport:', error);
            callback({ result: false, data: error.message });
        }
    });

    socket.on('produce', async (data, callback) => {
        const { transportId, kind, rtpParameters } = data;
        const room = rooms[roomId];
        const clientData = room.clients.get(clientId);
        if (!room || !clientData) return callback({ result: false, data: 'Not in a room' });

        const transport = clientData.transports.get(transportId);
        if (!transport) return callback({ result: false, data: 'Transport not found' });

        try {
            const producer = await transport.produce({ kind, rtpParameters });
            clientData.producers.set(producer.id, producer);
            
            producer.on('transportclose', () => {
                console.log(`Producer's transport closed: ${producer.id}`);
                clientData.producers.delete(producer.id);
            });

            callback({ result: true, data: { id: producer.id } });
        } catch (error) {
            console.error('Failed to produce:', error);
            callback({ result: false, data: error.message });
        }
    });

    socket.on('set_group', (data, callback) => {
        const { groupId, video_id, audio_id } = data;
        const room = rooms[roomId];
        const clientData = room.clients.get(clientId);

        if (!room || !clientData) {
            return callback({ result: false, data: 'Not in a room' });
        }

        // Validate IDs and set to "NULL" if invalid
        const final_video_id = clientData.producers.has(video_id) ? video_id : "NULL";
        const final_audio_id = clientData.producers.has(audio_id) ? audio_id : "NULL";

        // Case 1: Create a new group if groupId is 0 or not provided
        if (!groupId) {
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
            io.to(roomId).emit('update_groups', { groups: Array.from(room.groups.entries()) });
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
            io.to(roomId).emit('update_groups', { groups: Array.from(room.groups.entries()) });
            callback({ result: true, data: updatedGroupData });
        }
    });

    socket.on('get_groups', (data, callback) => {
        const room = rooms[roomId];
        if (!room) return callback({ result: false, data: 'Not in a room' });
        callback({ result: true, data: { groups: Array.from(room.groups.entries()) } });
    });

    socket.on('del_group', (data, callback) => {
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
        io.to(roomId).emit('update_groups', { groups: Array.from(room.groups.entries()) });

        callback({ result: true, data: { deletedGroupId: groupId } });
    });

    socket.on('consume', async (data, callback) => {
        const { producerId, transportId } = data;
        const room = rooms[roomId];
        const clientData = room.clients.get(clientId);
        if (!room || !clientData) return callback({ result: false, data: 'Not in a room' });

        const transport = clientData.transports.get(transportId);
        if (!transport) return callback({ result: false, data: 'Transport not found' });

        if (!room.router.canConsume({ producerId, rtpCapabilities: clientData.rtpCapabilities })) {
            return callback({ result: false, data: 'Cannot consume this producer' });
        }

        try {
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
            console.error('Failed to consume:', error);
            callback({ result: false, data: error.message });
        }
    });
    
    socket.on('store_rtp_capabilities', (data, callback) => {
        const room = rooms[roomId];
        const clientData = room.clients.get(clientId);
        if (clientData) {
            clientData.rtpCapabilities = data.rtpCapabilities;
        }
        callback({ result: true, data: null });
    });

    socket.on('resume_consumer', async (data, callback) => {
        const { consumerId } = data;
        const room = rooms[roomId];
        const clientData = room.clients.get(clientId);
        const consumer = clientData.consumers.get(consumerId);
        if(consumer) {
            await consumer.resume();
        }
        callback({ result: true, data: null });
    });


    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        if (!roomId || !clientId) return;

        const room = rooms[roomId];
        if (!room) return;

        const clientData = room.clients.get(clientId);
        if (!clientData) return;

        // Close all resources
        clientData.producers.forEach(p => p.close());
        clientData.consumers.forEach(c => c.close());
        clientData.transports.forEach(t => t.close());
        clientData.groups.forEach((_, groupId) => room.groups.delete(groupId));

        room.clients.delete(clientId);
        console.log(`Client ${clientId} left room ${roomId}`);

        io.to(roomId).emit('update_groups', { groups: Array.from(room.groups.entries()) });

        if (room.clients.size === 0) {
            console.log(`Room ${roomId} is empty, closing router.`);
            room.router.close();
            delete rooms[roomId];
        }
    });
});
