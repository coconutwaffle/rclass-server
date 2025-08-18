//control.js
import { io } from 'socket.io-client';
import { Device } from 'mediasoup-client';

let sendTransport;
let recvTransport;
let device;
let socket;
let consumers;

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

export function connectToServer(roomId, userId, onDisconnect, onUpdateGroups) {
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
}

export async function join_room(roomId, userId, handleSocketDisconnect, handleGroupUpdate) {
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

export async function createTransports() {
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
export async function get_producer(track_toprocude) {
    return sendTransport.produce({ track: track_toprocude });
}

export async function get_consumer(producerId, kind) {
    const { id, rtpParameters } = await consume( producerId, recvTransport.id);

    const consumer = await recvTransport.consume({ id, producerId, kind, rtpParameters });
    return consumer;
}

export const storeRtpCapabilities = (data) => request('store_rtp_capabilities', data);
export const createTransport = () => request('create_transport');
export const connectTransport = (data) => request('connect_transport', data);
export const produce = (data) => request('produce', data);
export const setGroup = (gid, vid, aid) => request('set_group', {
        groupId: gid,
        video_id: vid,
        audio_id: aid
    });
export const getGroups = () => request('get_groups');
export const consume = (pid, tid) => request('consume', { 
    producerId: pid, 
    transportId: tid });
export const resumeConsumer = (cid) => request('resume_consumer', {consumerId:cid});
export const del_group = (gid) => request('del_group', {groupId:gid});