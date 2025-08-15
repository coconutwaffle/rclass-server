import { io } from 'socket.io-client';
import { Device } from 'mediasoup-client';

const $ = (id) => document.getElementById(id);

const roomIdInput = $('roomId');
const userIdInput = $('userId');
const joinBtn = $('joinBtn');
const leaveBtn = $('leaveBtn');
const produceBtn = $('produceBtn');
const localVideo = $('localVideo');
const sendTransportStatus = $('sendTransportStatus');
const recvTransportStatus = $('recvTransportStatus');
const videoIdSpan = $('videoId');
const audioIdSpan = $('audioId');
const remoteVideosContainer = $('remote-videos');

let socket;
let device;
let sendTransport;
let recvTransport;
let localStream;
let videoProducer;
let audioProducer;
let consumers = new Map();

// --- Helper to generate random user ID ---
userIdInput.value = 'user-' + Math.random().toString(36).substr(2, 9);

// --- Socket Request Wrapper ---
function request(type, data = {}) {
    return new Promise((resolve, reject) => {
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

// --- UI Event Listeners ---
joinBtn.addEventListener('click', joinRoom);
leaveBtn.addEventListener('click', leaveRoom);
produceBtn.addEventListener('click', startProducing);

async function joinRoom() {
    const roomId = roomIdInput.value;
    const userId = userIdInput.value;
    if (!roomId || !userId) {
        return alert('Room ID and User ID are required');
    }

    socket = io({
        path: '/socket.io',
        transports: ['websocket'],
    });

    socket.on('connect', async () => {
        console.log('Socket connected');
        try {
            const { rtpCapabilities } = await request('join_room', { roomId, clientId: userId });
            
            device = new Device();
            await device.load({ routerRtpCapabilities: rtpCapabilities });

            await request('store_rtp_capabilities', { rtpCapabilities: device.rtpCapabilities });

            await createTransports();
            
            updateUiForJoin();
            await refreshGroupList();

        } catch (error) {
            console.error('Failed to join room:', error);
            alert('Failed to join room: ' + error);
            leaveRoom();
        }
    });

    socket.on('disconnect', () => {
        console.log('Socket disconnected');
        updateUiForLeave();
    });

    socket.on('update_groups', ({ groups }) => {
        console.log('Received group update:', groups);
        displayGroups(groups);
    });
}

function leaveRoom() {
    if (socket) {
        socket.disconnect();
    }
    if (sendTransport) sendTransport.close();
    if (recvTransport) recvTransport.close();
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    updateUiForLeave();
}

function updateUiForJoin() {
    joinBtn.disabled = true;
    leaveBtn.disabled = false;
    produceBtn.disabled = false;
    roomIdInput.disabled = true;
    userIdInput.disabled = true;
}

function updateUiForLeave() {
    joinBtn.disabled = false;
    leaveBtn.disabled = true;
    produceBtn.disabled = true;
    roomIdInput.disabled = false;
    userIdInput.disabled = false;
    localVideo.srcObject = null;
    remoteVideosContainer.innerHTML = '';
    sendTransportStatus.textContent = 'Inactive';
    recvTransportStatus.textContent = 'Inactive';
    videoIdSpan.textContent = 'N/A';
    audioIdSpan.textContent = 'N/A';
}

async function createTransports() {
    // Create send transport
    const sendTransportParams = await request('create_transport');
    sendTransport = device.createSendTransport(sendTransportParams);
    sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
            await request('connect_transport', { transportId: sendTransport.id, dtlsParameters });
            callback();
        } catch (error) {
            errback(error);
        }
    });
    sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
        try {
            const { id } = await request('produce', { transportId: sendTransport.id, kind, rtpParameters });
            callback({ id });
        } catch (error) {
            errback(error);
        }
    });
    sendTransport.on('connectionstatechange', state => {
        sendTransportStatus.textContent = state;
    });

    // Create receive transport
    const recvTransportParams = await request('create_transport');
    recvTransport = device.createRecvTransport(recvTransportParams);
    recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
            await request('connect_transport', { transportId: recvTransport.id, dtlsParameters });
            callback();
        } catch (error) {
            errback(error);
        }
    });
    recvTransport.on('connectionstatechange', state => {
        recvTransportStatus.textContent = state;
    });
}

async function startProducing() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;

        const videoTrack = localStream.getVideoTracks()[0];
        const audioTrack = localStream.getAudioTracks()[0];

        videoProducer = await sendTransport.produce({ track: videoTrack });
        audioProducer = await sendTransport.produce({ track: audioTrack });

        videoIdSpan.textContent = videoProducer.id;
        audioIdSpan.textContent = audioProducer.id;

        await request('set_group', { video_id: videoProducer.id, audio_id: audioProducer.id });
        produceBtn.disabled = true;

    } catch (error) {
        console.error('Failed to start producing:', error);
        alert('Error starting webcam: ' + error);
    }
}

async function refreshGroupList() {
    const { groups } = await request('get_groups');
    displayGroups(groups);
}

function displayGroups(groups) {
    remoteVideosContainer.innerHTML = '';
    for (const [groupId, groupInfo] of groups) {
        // Don't display our own video
        if (groupInfo.clientId === userIdInput.value) continue;

        const div = document.createElement('div');
        div.className = 'video-item';
        div.innerHTML = `
            <h3>Group ${groupId} (from ${groupInfo.clientId})</h3>
            <video id="video-${groupId}" autoplay playsinline></video>
            <audio id="audio-${groupId}" autoplay></audio>
            <button data-group-id="${groupId}" data-video-id="${groupInfo.video_id}" data-audio-id="${groupInfo.audio_id}">Consume</button>
        `;
        remoteVideosContainer.appendChild(div);
    }

    remoteVideosContainer.querySelectorAll('button').forEach(button => {
        button.addEventListener('click', async (e) => {
            const { groupId, videoId, audioId } = e.target.dataset;
            await consumeStream(videoId, 'video', groupId);
            await consumeStream(audioId, 'audio', groupId);
            e.target.disabled = true;
        });
    });
}

async function consumeStream(producerId, kind, groupId) {
    try {
        const { id, rtpParameters } = await request('consume', {
            transportId: recvTransport.id,
            producerId,
        });

        const consumer = await recvTransport.consume({
            id,
            producerId,
            kind,
            rtpParameters,
        });
        
        consumers.set(id, consumer);

        const stream = new MediaStream();
        stream.addTrack(consumer.track);

        const elementId = `${kind}-${groupId}`;
        const mediaElement = $(elementId);
        mediaElement.srcObject = stream;
        
        // Important: resume the consumer on the server to start receiving media
        await request('resume_consumer', { consumerId: id });

    } catch (error) {
        console.error(`Failed to consume ${kind}:`, error);
    }
}
