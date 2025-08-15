import { io } from 'socket.io-client';

let socket;

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
            console.log('Socket connected');
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

export function disconnect() {
    if (socket) {
        socket.disconnect();
        socket = null;
    }
}

export const storeRtpCapabilities = (data) => request('store_rtp_capabilities', data);
export const createTransport = () => request('create_transport');
export const connectTransport = (data) => request('connect_transport', data);
export const produce = (data) => request('produce', data);
export const setGroup = (data) => request('set_group', data);
export const getGroups = () => request('get_groups');
export const consume = (data) => request('consume', data);
export const resumeConsumer = (data) => request('resume_consumer', data);
