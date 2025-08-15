export const elements = {
    roomIdInput: document.getElementById('roomId'),
    userIdInput: document.getElementById('userId'),
    joinBtn: document.getElementById('joinBtn'),
    leaveBtn: document.getElementById('leaveBtn'),
    produceBtn: document.getElementById('produceBtn'),
    localVideo: document.getElementById('localVideo'),
    sendTransportStatus: document.getElementById('sendTransportStatus'),
    recvTransportStatus: document.getElementById('recvTransportStatus'),
    videoIdSpan: document.getElementById('videoId'),
    audioIdSpan: document.getElementById('audioId'),
    remoteVideosContainer: document.getElementById('remote-videos'),
};

export function setupInitialUI() {
    elements.userIdInput.value = 'user-' + Math.random().toString(36).substr(2, 9);
}

export function updateUiForJoin() {
    elements.joinBtn.disabled = true;
    elements.leaveBtn.disabled = false;
    elements.produceBtn.disabled = false;
    elements.roomIdInput.disabled = true;
    elements.userIdInput.disabled = true;
}

export function updateUiForLeave() {
    elements.joinBtn.disabled = false;
    elements.leaveBtn.disabled = true;
    elements.produceBtn.disabled = true;
    elements.roomIdInput.disabled = false;
    elements.userIdInput.disabled = false;
    elements.localVideo.srcObject = null;
    elements.remoteVideosContainer.innerHTML = '';
    updateTransportStatus('send', 'Inactive');
    updateTransportStatus('recv', 'Inactive');
    updateProducerIds(null, null);
}

export function updateTransportStatus(type, state) {
    const element = type === 'send' ? elements.sendTransportStatus : elements.recvTransportStatus;
    if (element) {
        element.textContent = state;
    }
}

export function updateProducerIds(videoId, audioId) {
    elements.videoIdSpan.textContent = videoId || 'N/A';
    elements.audioIdSpan.textContent = audioId || 'N/A';
}

export function setLocalStream(stream) {
    elements.localVideo.srcObject = stream;
}

export function disableProduceButton() {
    elements.produceBtn.disabled = true;
}

export function renderGroups(groups, currentUserId, onConsume) {
    elements.remoteVideosContainer.innerHTML = '';
    for (const [groupId, groupInfo] of groups) {
        if (groupInfo.clientId === currentUserId) continue;

        const div = document.createElement('div');
        div.className = 'video-item';
        div.innerHTML = `
            <h3>Group ${groupId} (from ${groupInfo.clientId})</h3>
            <video id="video-${groupId}" autoplay playsinline></video>
            <audio id="audio-${groupId}" autoplay></audio>
            <button data-group-id="${groupId}" data-video-id="${groupInfo.video_id}" data-audio-id="${groupInfo.audio_id}">Consume</button>
        `;
        elements.remoteVideosContainer.appendChild(div);
    }

    elements.remoteVideosContainer.querySelectorAll('button').forEach(button => {
        button.addEventListener('click', (e) => {
            const { groupId, videoId, audioId } = e.target.dataset;
            onConsume(videoId, 'video', groupId);
            onConsume(audioId, 'audio', groupId);
            e.target.disabled = true;
        });
    });
}

export function getMediaElement(kind, groupId) {
    return document.getElementById(`${kind}-${groupId}`);
}
