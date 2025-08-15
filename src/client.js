import { Device } from 'mediasoup-client';
import * as socket from './socket.js';
import * as ui from './ui.js';

let device;
let sendTransport;
let recvTransport;
let localStream;
let videoProducer;
let audioProducer;
let consumers = new Map();

// --- Initialize UI ---
ui.setupInitialUI();

// --- UI Event Listeners ---
ui.elements.joinBtn.addEventListener('click', handleJoinRoom);
ui.elements.leaveBtn.addEventListener('click', handleLeaveRoom);
ui.elements.produceBtn.addEventListener('click', handleStartProducing);

// --- Core Functions ---
async function handleJoinRoom() {
    const roomId = ui.elements.roomIdInput.value;
    const userId = ui.elements.userIdInput.value;
    if (!roomId || !userId) {
        return alert('Room ID and User ID are required');
    }

    try {
        const { rtpCapabilities } = await socket.connectToServer(
            roomId,
            userId,
            handleSocketDisconnect,
            handleGroupUpdate
        );

        device = new Device();
        await device.load({ routerRtpCapabilities: rtpCapabilities });

        await socket.storeRtpCapabilities({ rtpCapabilities: device.rtpCapabilities });

        await createTransports();

        ui.updateUiForJoin();
        await refreshGroupList();

    } catch (error) {
        console.error('Failed to join room:', error);
        alert('Failed to join room: ' + error);
        handleLeaveRoom();
    }
}

function handleLeaveRoom() {
    socket.disconnect();
    if (sendTransport) sendTransport.close();
    if (recvTransport) recvTransport.close();
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    ui.updateUiForLeave();
}

async function createTransports() {
    // Send Transport
    const sendParams = await socket.createTransport();
    sendTransport = device.createSendTransport(sendParams);
    sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
            await socket.connectTransport({ transportId: sendTransport.id, dtlsParameters });
            callback();
        } catch (error) {
            errback(error);
        }
    });
    sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
        try {
            const { id } = await socket.produce({ transportId: sendTransport.id, kind, rtpParameters });
            callback({ id });
        } catch (error) {
            errback(error);
        }
    });
    sendTransport.on('connectionstatechange', state => ui.updateTransportStatus('send', state));

    // Receive Transport
    const recvParams = await socket.createTransport();
    recvTransport = device.createRecvTransport(recvParams);
    recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
            await socket.connectTransport({ transportId: recvTransport.id, dtlsParameters });
            callback();
        } catch (error) {
            errback(error);
        }
    });
    recvTransport.on('connectionstatechange', state => ui.updateTransportStatus('recv', state));
}

async function handleStartProducing() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        ui.setLocalStream(localStream);

        const videoTrack = localStream.getVideoTracks()[0];
        const audioTrack = localStream.getAudioTracks()[0];

        videoProducer = await sendTransport.produce({ track: videoTrack });
        audioProducer = await sendTransport.produce({ track: audioTrack });

        ui.updateProducerIds(videoProducer.id, audioProducer.id);
        ui.disableProduceButton();

        // Create a new group by sending groupId = 0 (or null)
        const newGroup = await socket.setGroup({ 
            groupId: 0, 
            video_id: videoProducer.id, 
            audio_id: audioProducer.id 
        });
        console.log('New group created:', newGroup);

    } catch (error) {
        console.error('Failed to start producing:', error);
        alert('Error starting webcam: ' + error);
    }
}

async function refreshGroupList() {
    const { groups } = await socket.getGroups();
    ui.renderGroups(groups, ui.elements.userIdInput.value, handleConsumeStream, handleEditGroup);
}

async function handleConsumeStream(producerId, kind, groupId) {
    try {
        const { id, rtpParameters } = await socket.consume({
            transportId: recvTransport.id,
            producerId,
        });

        const consumer = await recvTransport.consume({ id, producerId, kind, rtpParameters });
        consumers.set(id, consumer);

        const stream = new MediaStream([consumer.track]);
        const mediaElement = ui.getMediaElement(kind, groupId);
        mediaElement.srcObject = stream;

        await socket.resumeConsumer({ consumerId: id });

    } catch (error) {
        console.error(`Failed to consume ${kind}:`, error);
    }
}

// --- Socket Event Handlers ---
function handleSocketDisconnect() {
    console.log('Socket disconnected');
    ui.updateUiForLeave();
}

function handleGroupUpdate({ groups }) {
    console.log('Received group update:', groups);
    ui.renderGroups(groups, ui.elements.userIdInput.value, handleConsumeStream, handleEditGroup);
}

async function handleEditGroup(groupId) {
    if (!videoProducer || !audioProducer) {
        return alert('You must be producing video and audio to update a group.');
    }
    try {
        const updatedGroup = await socket.setGroup({
            groupId, // The actual groupId to edit
            video_id: videoProducer.id,
            audio_id: audioProducer.id,
        });
        console.log(`Successfully edited group ${groupId}:`, updatedGroup);
    } catch (error) {
        console.error('Failed to edit group:', error);
        alert('Failed to edit group: ' + error);
    }
}
