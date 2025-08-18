//core.js
import * as ctr from './control.js';

let transports;
let producers = {};
let consumers = {};

// --- Core Functions ---
export async function handleJoinRoom(roomId, userId, update_group, leave_room, updateTransportStatus) {
    if (!roomId || !userId) {
        throw new Error('Room ID and User ID are required')
    }
    transports = await ctr.join_room(roomId, userId, () => {
        handleLeaveRoom();
        leave_room();
    }, update_group);
    transports.send.on('connectionstatechange', state => updateTransportStatus('send', state));
    transports.recv.on('connectionstatechange', state => updateTransportStatus('recv', state));
    update_group(await ctr.getGroups());
    return;
}

export function handleLeaveRoom() {
    Object.entries(producers).forEach(([id, producer]) => {
        producer.close();
    });
    Object.entries(consumers).forEach(([id, consumer]) => {
        consumer.close();
    });
    ctr.leave_room();
}


export async function handleStartProducing(track) {
    const producer = await ctr.get_producer(track);
    producers[producer.id] = producer;
    return producer.id;
}
export async function handleCloseProducing(producerId) {
    producers[producerId].close();
    delete producers[producerId];
    return producerId;
}

export async function handleConsumeStream(producerId, kind, groupId) {
    const consumer = await ctr.get_consumer(producerId, kind);
    const stream = new MediaStream([consumer.track]);
    await ctr.resumeConsumer(consumer.id);
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
    const data = await ctr.setGroup(groupId, videoId, AudioId);
    return data.groupId;
}
export async function del_group(groupId) {
    const data = await ctr.del_group(groupId);
    return data.deletedGroupId;
}