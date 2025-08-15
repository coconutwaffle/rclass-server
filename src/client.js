import * as ctr from './control.js';
import * as ui from './ui.js';

let localStream;
let videoProducer;
let audioProducer;
let transports;

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
        transports = await ctr.join_room(roomId, userId, handleSocketDisconnect, handleGroupUpdate);
        transports.send.on('connectionstatechange', state => ui.updateTransportStatus('send', state));
        transports.recv.on('connectionstatechange', state => ui.updateTransportStatus('recv', state));
        ui.updateUiForJoin();
        await refreshGroupList();

    } catch (error) {
        console.error('Failed to join room:', error);
        alert('Failed to join room: ' + error);
        handleLeaveRoom();
    }
}


function handleLeaveRoom() {
    ctr.leave_room();
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    ui.updateUiForLeave();
}


async function handleStartProducing() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        ui.setLocalStream(localStream);

        const videoTrack = localStream.getVideoTracks()[0];
        const audioTrack = localStream.getAudioTracks()[0];

        videoProducer = await ctr.get_producer(videoTrack);
        audioProducer = await ctr.get_producer(audioTrack);

        ui.updateProducerIds(videoProducer.id, audioProducer.id);
        ui.disableProduceButton();

        // Create a new group by sending groupId = 0 (or null)
        const newGroup = await ctr.setGroup({ 
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
    const { groups } = await ctr.getGroups();
    ui.renderGroups(groups, ui.elements.userIdInput.value, handleConsumeStream, handleEditGroup);
}

async function handleConsumeStream(producerId, kind, groupId) {
    try {
        const consumer = await ctr.get_consumer(producerId, kind);
        const stream = new MediaStream([consumer.track]);
        const mediaElement = ui.getMediaElement(kind, groupId);
        mediaElement.srcObject = stream;

        await ctr.resumeConsumer({ consumerId: consumer.id });
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
        const updatedGroup = await ctr.setGroup({
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
