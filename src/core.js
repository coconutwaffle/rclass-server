//core.js

// --- From control.js ---
import { io } from 'socket.io-client';
import { Device } from 'mediasoup-client';

let sendTransport;
let recvTransport;
let device;
let socket;
let local_groups = [];
// Promise-based request wrapper
function request(type, data = {}) {
    return new Promise((resolve, reject) => {
        if (!socket) return reject('No socket connection.');
        socket.emit(type, data, (response) => {
            if (response.result) {
                resolve(response.data);
            } else {
                console.error('Request failed:', type, response.data);
                reject(response.data);
            }
        });
    });
}

function connectToServer(roomId, userId, onDisconnect, onUpdateGroups) {
    socket = io({
        path: '/socket.io',
        transports: ['websocket'],
    });

    return new Promise((resolve, reject) => {
        socket.on('connect', async () => {
            try {
                const data = await request('join_room', { roomId, clientId: userId });
                socket.on('disconnect', onDisconnect);
                socket.on('update_groups', onUpdateGroups);
                resolve(data);
            } catch (error) {
                reject(error);
            }
        });

        socket.on('connect_error', (error) => {
            reject(error);
        });
    });
}

export function leave_room() {
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    if (sendTransport) sendTransport.close();
    if (recvTransport) recvTransport.close();
    while(local_groups.length > 0)
    {
        id = local_groups.pop();
        try{
            del_group(id);
        }
        catch(err){}
    }
}

async function join_room_internal(roomId, userId, handleSocketDisconnect, handleGroupUpdate) {
    const { rtpCapabilities } = await connectToServer(
        roomId,
        userId,
        handleSocketDisconnect,
        handleGroupUpdate
    );

    device = new Device();
    await device.load({ routerRtpCapabilities: rtpCapabilities });

    await storeRtpCapabilities({ rtpCapabilities: device.rtpCapabilities });

    return createTransports();
}

async function createTransports() {
    // Send Transport
    const sendParams = await createTransport();
    sendTransport = device.createSendTransport(sendParams);
    sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
            await connectTransport({ transportId: sendTransport.id, dtlsParameters });
            callback();
        } catch (error) {
            errback(error);
        }
    });
    sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
        try {
            const { id } = await produce({ transportId: sendTransport.id, kind, rtpParameters });
            callback({ id });
        } catch (error) {
            errback(error);
        }
    });

    // Receive Transport
    const recvParams = await createTransport();
    recvTransport = device.createRecvTransport(recvParams);
    recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
            await connectTransport({ transportId: recvTransport.id, dtlsParameters });
            callback();
        } catch (error) {
            errback(error);
        }
    });

    return { 'send': sendTransport, 'recv': recvTransport };
}
async function get_producer(track_toprocude) {
    return sendTransport.produce({ track: track_toprocude });
}

async function get_consumer(producerId, kind) {
    const { id, rtpParameters } = await consume( producerId, recvTransport.id);

    const consumer = await recvTransport.consume({ id, producerId, kind, rtpParameters });
    return consumer;
}

const storeRtpCapabilities = (data) => request('store_rtp_capabilities', data);
const createTransport = () => request('create_transport');
const connectTransport = (data) => request('connect_transport', data);
const produce = (data) => request('produce', data);
const consume = (pid, tid) => request('consume', { 
    producerId: pid, 
    transportId: tid });
const resumeConsumer = (cid) => request('resume_consumer', {consumerId:cid});

export async function chat_send(msg, mode, send_to)
{
    try {
        res = await request('chat_send', {msg, mode, send_to});
        return res
    } catch(err)
    {
        consol.trace(`[chat_send] err: ${err}`)
        throw err;
    }
}
export async function chat_history()
{
    try{
        res = await request('chat_history');
        return res;
    } catch(err)
    {
        consol.trace(`[chat_history] err: ${err}`)
        throw err;
    }
}
// --- Original core.js ---

let transports;
let producers = {};
let consumers = {};

// --- Core Functions ---
export async function handleJoinRoom(roomId, userId, update_group, leave_room_callback, updateTransportStatus) {
    if (!roomId || !userId) {
        throw new Error('Room ID and User ID are required')
    }
    transports = await join_room_internal(roomId, userId, () => {
        handleLeaveRoom();
        leave_room_callback();
    }, update_group);
    transports.send.on('connectionstatechange', state => updateTransportStatus('send', state));
    transports.recv.on('connectionstatechange', state => updateTransportStatus('recv', state));
    update_group(await getGroups());
    return;
}

export function handleLeaveRoom() {
    Object.entries(producers).forEach(([id, producer]) => {
        producer.close();
    });
    Object.entries(consumers).forEach(([id, consumer]) => {
        consumer.close();
    });
    leave_room();
}


export async function handleStartProducing(track) {
    const producer = await get_producer(track);
    producers[producer.id] = producer;
    return producer.id;
}
export async function handleCloseProducing(producerId) {
    producers[producerId].close();
    delete producers[producerId];
    return producerId;
}

export async function handleConsumeStream(producerId, kind, groupId) {
    const consumer = await get_consumer(producerId, kind);
    const stream = new MediaStream([consumer.track]);
    await resumeConsumer(consumer.id);
    return stream;
}
export async function handleClose(Id) {
    if (Id in producers) {
        producers[Id].close();
        delete producers[Id];
    }
    if (Id in consumers) {
        consumers[Id].close();
        delete consumers[Id];
    }
}
export async function setGroup(groupId, videoId, AudioId) {
    const data = await request('set_group', {
        groupId: groupId,
        video_id: videoId,
        audio_id: AudioId
    });
    if(groupId === 0)
        {
            local_groups.push(groupId);
        } 
    return data.groupId;
}
export async function del_group(groupId) {
    const data = await request('del_group', {groupId:groupId});
    return data.deletedGroupId;
}

export async function getGroups() {
    return await request('get_groups');
}
