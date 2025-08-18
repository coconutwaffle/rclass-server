// ui.js  — ES Module
// 요구사항 구현 + core.js 미구현 가능 지점은 // TODO(core) 로 주석 표시
import * as core from './core.js';

/** =========================
 *  내부 상태
 *  ========================= */
const ui = {
    status: 'idle', // idle | joining | joined | leaving
    roomId: 'NULL',
    userId: 'NULL',
    localgroups: [],
    groups: new Map(), // groupId -> GroupState
};

class GroupState {
    /**
     * @param {int} groupId
     * @param {'local'|'remote'} mode
     * @param {string} userIdFromCreator
     * @param {string} videoId producerId or consumerId or "NULL"
     * @param {string} audioId producerId or consumerId or "NULL"
     * @param {HTMLElement} card
     */
    constructor(groupId, mode, userIdFromCreator, videoId, audioId, card) {
        this.groupId = groupId;
        this.mode = mode;
        this.userIdFromCreator = userIdFromCreator;
        this.videoId = videoId;
        this.audioId = audioId;
        this.card = card;
        // per-kind media info kept by UI (stream, role, id, paused, synthetic)
        this.media = {
            video: { stream: null, role: 'none', id: 'NULL', paused: false, synthetic: false },
            audio: { stream: null, role: 'none', id: 'NULL', paused: false, synthetic: false },
        };
    }
}

/** =========================
 *  DOM 헬퍼
 *  ========================= */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
};

const dom = {
    roomId: () => $('#roomId'),
    userId: () => $('#userId'),
    joinBtn: () => $('#joinBtn'),
    leaveBtn: () => $('#leaveBtn'),
    addGroupBtn: () => $('#addGroupBtn'),
    sendTransport: () => $('#sendTransport'),
    recvTransport: () => $('#recvTransport'),
    groups: () => $('#groupsContainer'),
};

/** =========================
 *  블랙 프레임 스트림 생성 (video)
 *  ========================= */
function createBlackVideoStream(width = 640, height = 360) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, width, height);
    // 1fps 로 캡처 (정지 프레임)
    // 일부 브라우저는 0 fps 거부 → 1 권장
    const stream = canvas.captureStream(1);
    return stream;
}

/** =========================
 *  UI 상태 <-> DOM 바인딩
 *  ========================= */
function lockRoomInputs(locked) {
    dom.roomId().disabled = locked;
    dom.userId().disabled = locked;
}
function setButtonsForStatus() {
    switch (ui.status) {
        case 'idle':
            dom.joinBtn().disabled = false;
            dom.leaveBtn().disabled = true;
            lockRoomInputs(false);
            break;
        case 'joining':
            dom.joinBtn().disabled = true;
            dom.leaveBtn().disabled = false; // 사용자는 중도 취소 가능하도록 유지
            lockRoomInputs(true);
            break;
        case 'joined':
            dom.joinBtn().disabled = true;
            dom.leaveBtn().disabled = false;
            lockRoomInputs(true);
            break;
        case 'leaving':
            dom.joinBtn().disabled = true;
            dom.leaveBtn().disabled = true;
            lockRoomInputs(true);
            break;
    }
}

/** =========================
 *  장치 나열 (local 전용)
 *  ========================= */
async function listDevices() {
    // 첫 enumerate 이전에 장치 권한 부여 필요할 수 있음(브라우저 정책)
    try {
        await navigator.mediaDevices.getUserMedia({ audio: false, video: false }).catch(() => { });
    } catch { }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    const mics = devices.filter((d) => d.kind === 'audioinput');
    return { cams, mics };
}

/** =========================
 *  그룹 카드 생성
 *  ========================= */
function buildLocalGroupCard(groupId, userId, initialVideoId, initialAudioId) {
    const card = el('div', 'panel group-card');
    card.dataset.groupId = groupId;
    card.dataset.mode = 'local';

    const mediaBox = el('div', 'media-box');
    const vid = document.createElement('video');
    vid.autoplay = true;
    vid.playsInline = true;
    const aud = document.createElement('audio');
    aud.autoplay = true;
    mediaBox.append(vid, aud);

    const ctl = el('div', 'col');

    const title = el('div');
    title.innerHTML = `<h3>Group <span class="kbd">${groupId}</span> <span class="pill ok">local</span> by <span class="kbd">${userId}</span></h3>`;

    // selectors
    const rowSel = el('div', 'row');
    const camSel = el('select');
    const micSel = el('select');
    camSel.dataset.role = 'video';
    micSel.dataset.role = 'audio';
    camSel.title = 'select camera';
    micSel.title = 'select mic';
    rowSel.append(camSel, micSel);

    // buttons
    const rowV = el('div', 'toolbar');
    const btnStartV = el('button'); btnStartV.textContent = 'Start Produce (Video)';
    const btnCloseV = el('button'); btnCloseV.textContent = 'Close Produce (Video)';
    const btnPauseV = el('button'); btnPauseV.textContent = 'Pause Video';
    const btnResumeV = el('button'); btnResumeV.textContent = 'Resume Video';
    const btnHideV = el('button'); btnHideV.textContent = 'Hide/Show Video';
    rowV.append(btnStartV, btnCloseV, btnPauseV, btnResumeV, btnHideV);

    const rowA = el('div', 'toolbar');
    const btnStartA = el('button'); btnStartA.textContent = 'Start Produce (Audio)';
    const btnCloseA = el('button'); btnCloseA.textContent = 'Close Produce (Audio)';
    const btnPauseA = el('button'); btnPauseA.textContent = 'Mute';
    const btnResumeA = el('button'); btnResumeA.textContent = 'Unmute';
    rowA.append(btnStartA, btnCloseA, btnPauseA, btnResumeA);

    const meta = el('div', 'meta');
    meta.innerHTML = `
    <div>Video ID: <span class="videoId kbd">${initialVideoId}</span></div>
    <div>Audio ID: <span class="audioId kbd">${initialAudioId}</span></div>
  `;

    const bottom = el('div', 'row');
    const btnDel = el('button'); btnDel.textContent = 'Delete Group'; btnDel.classList.add('danger');
    bottom.append(btnDel);

    ctl.append(title, rowSel, rowV, rowA, meta, bottom);
    card.append(mediaBox, ctl);

    // 장치 채우기
    listDevices().then(({ cams, mics }) => {
        camSel.innerHTML = cams.map((d) => `<option value="${d.deviceId}">${d.label || 'camera'}</option>`).join('');
        micSel.innerHTML = mics.map((d) => `<option value="${d.deviceId}">${d.label || 'mic'}</option>`).join('');
    });

    // 이벤트 바인딩
    btnStartV.onclick = () => startLocalProduce(groupId, 'video', camSel.value, vid);
    btnCloseV.onclick = () => closeLocalProduce(groupId, 'video');
    btnPauseV.onclick = () => pauseMedia(groupId, 'video', true);
    btnResumeV.onclick = () => pauseMedia(groupId, 'video', false);
    btnHideV.onclick = () => { vid.classList.toggle('hidden'); };

    btnStartA.onclick = () => startLocalProduce(groupId, 'audio', micSel.value, aud);
    btnCloseA.onclick = () => closeLocalProduce(groupId, 'audio');
    btnPauseA.onclick = () => pauseMedia(groupId, 'audio', true);
    btnResumeA.onclick = () => pauseMedia(groupId, 'audio', false);

    btnDel.onclick = () => del_group(groupId);
    return card;
}

function buildRemoteGroupCard(groupId, userId, initialVideoId, initialAudioId) {
    const card = el('div', 'panel group-card');
    card.dataset.groupId = groupId;
    card.dataset.mode = 'remote';

    const mediaBox = el('div', 'media-box');
    const vid = document.createElement('video');
    vid.autoplay = true;
    vid.playsInline = true;
    const aud = document.createElement('audio');
    aud.autoplay = true;
    mediaBox.append(vid, aud);

    const ctl = el('div', 'col');
    const title = el('div');
    title.innerHTML = `<h3>Group <span class="kbd">${groupId}</span> <span class="pill">remote</span> by <span class="kbd">${userId}</span></h3>`;

    const rowV = el('div', 'toolbar');
    const btnStartCv = el('button'); btnStartCv.textContent = 'Start Consume (Video)';
    const btnCloseCv = el('button'); btnCloseCv.textContent = 'Close Consume (Video)';
    const btnPauseV = el('button'); btnPauseV.textContent = 'Pause Video';
    const btnResumeV = el('button'); btnResumeV.textContent = 'Resume Video';
    rowV.append(btnStartCv, btnCloseCv, btnPauseV, btnResumeV);

    const rowA = el('div', 'toolbar');
    const btnStartCa = el('button'); btnStartCa.textContent = 'Start Consume (Audio)';
    const btnCloseCa = el('button'); btnCloseCa.textContent = 'Close Consume (Audio)';
    const btnMute = el('button'); btnMute.textContent = 'Mute';
    const btnUnmute = el('button'); btnUnmute.textContent = 'Unmute';
    rowA.append(btnStartCa, btnCloseCa, btnMute, btnUnmute);

    const meta = el('div', 'meta');
    meta.innerHTML = `
    <div>Video ID: <span class="videoId kbd">${initialVideoId}</span></div>
    <div>Audio ID: <span class="audioId kbd">${initialAudioId}</span></div>
  `;

    const bottom = el('div', 'row');
    const btnDel = el('button'); btnDel.textContent = 'Delete Group'; btnDel.classList.add('danger');
    bottom.append(btnDel);

    ctl.append(title, rowV, rowA, meta, bottom);
    card.append(mediaBox, ctl);

    // 이벤트 바인딩
    btnStartCv.onclick = () => startRemoteConsume(groupId, 'video', vid);
    btnCloseCv.onclick = () => closeRemoteConsume(groupId, 'video');

    btnStartCa.onclick = () => startRemoteConsume(groupId, 'audio', aud);
    btnCloseCa.onclick = () => closeRemoteConsume(groupId, 'audio');

    btnPauseV.onclick = () => pauseMedia(groupId, 'video', true);
    btnResumeV.onclick = () => pauseMedia(groupId, 'video', false);
    btnMute.onclick = () => pauseMedia(groupId, 'audio', true);
    btnUnmute.onclick = () => pauseMedia(groupId, 'audio', false);

    btnDel.onclick = () => del_group(groupId);

    return card;
}

/** =========================
 *  유틸: UI 내 meta 텍스트 갱신
 *  ========================= */
function updateMetaIds(group) {
    const vidSpan = group.card.querySelector('.videoId');
    const audSpan = group.card.querySelector('.audioId');
    if (vidSpan) vidSpan.textContent = group.videoId;
    if (audSpan) audSpan.textContent = group.audioId;
}

/** =========================
 *  (1) get_UIstatus(key)
 *  ========================= */
export function get_UIstatus(key) {
    switch (key) {
        case 'roomId': return ui.roomId;
        case 'userId': return ui.userId;
        case 'isJoined': return ui.status === 'joined';
        case 'status': return ui.status;
        default:
            throw new Error(`Unknown key: ${key}`);
    }
}

/** =========================
 *  (2) join_room()
 *  ========================= */
export async function join_room() {
    if (ui.status !== 'idle') {
        // idle이 아닌 경우 입력 잠금 유지, join 비활성화
        setButtonsForStatus();
        return;
    }

    ui.roomId = dom.roomId().value || 'NULL';
    ui.userId = dom.userId().value || 'NULL';

    ui.status = 'joining';
    setButtonsForStatus();

    try {
        await core.handleJoinRoom(
            ui.roomId,
            ui.userId,
            update_group,        // 서버/코어 콜백: 원격 변경 반영
            leave_room,          // 서버 끊김 시 콜백 (즉시 실패에는 해당 없음)
            updateTransportStatus
        ); // TODO(core): core.handleJoinRoom 구현 필요 (콜백 호출 포함)
        ui.status = 'joined';
        setButtonsForStatus();
    } catch (e) {
        ui.status = 'idle';
        setButtonsForStatus();
        alert(e);
    }
}

/** =========================
 *  (3) leave_room()
 *  ========================= */
export async function leave_room() {
    if (ui.status === 'idle') return;
    ui.status = 'leaving';
    setButtonsForStatus();

    try {
        await core.handleLeaveRoom(); // TODO(core)
    } finally {
        // 그룹 비움 및 UI 초기화
        for (const gid of [...ui.groups.keys()]) {
            await del_group(gid);
        }

        dom.sendTransport().textContent = 'idle';
        dom.recvTransport().textContent = 'idle';

        ui.status = 'idle';
        setButtonsForStatus();
    }
}

/** =========================
 *  (4) add_group(groupId, userId, videoId, audioId, mode)
 *  - groupId == 0 금지
 *  ========================= */
export function add_group(groupId, userId, videoId, audioId, mode) {
    ui.groups.set(groupId, null);
    if (mode === 'local')
    {
        ui.localgroups.push(groupId);
    }
    const card = (mode === 'local')
        ? buildLocalGroupCard(groupId, userId, videoId, audioId)
        : buildRemoteGroupCard(groupId, userId, videoId, audioId);

    dom.groups().appendChild(card);

    const g = new GroupState(groupId, mode, userId, videoId, audioId, card);
    // 초기 비디오를 블랙으로 채워 보기 일관성 유지
    const black = createBlackVideoStream();
    const vEl = card.querySelector('video');
    if (vEl) {
        vEl.srcObject = black;
        g.media.video = { stream: black, role: 'synthetic', id: 'NULL', paused: false, synthetic: true };
    }
    const aEl = card.querySelector('audio');
    if (aEl) {
        aEl.srcObject = null; // 오디오는 기본 없음
        g.media.audio = { stream: null, role: 'none', id: 'NULL', paused: false, synthetic: false };
    }

    ui.groups.set(groupId, g);
}

/** =========================
 *  (5) set_group(groupId, videoId, audioId)
 *  - DOM 텍스트/상태만 갱신 (실제 미디어 교체는 update_group에서)
 *  ========================= */
export function set_group(groupId, videoId, audioId) {
    const g = ui.groups.get(groupId);
    if (!g) return;

    g.videoId = (typeof videoId === 'string') ? videoId : 'NULL';
    g.audioId = (typeof audioId === 'string') ? audioId : 'NULL';
    updateMetaIds(g);
}

/** =========================
 *  (6) del_group(groupId)
 *  - DOM 삭제, track stop, producer/consumer 정리
 *  ========================= */
export async function del_group(groupId) {
    if (!ui.localgroups.includes(groupId))
    {
        return;
    }
    const g = ui.groups.get(groupId);
    if (!g) return;
    // 미디어/프로듀서/컨슈머 정리
    await del_media(groupId, 'video');
    await del_media(groupId, 'audio');

    // core 그룹 정리
    try {
        await core.del_group(groupId); // TODO(core)
    } catch (e) {
        // 그룹이 이미 서버측에서 사라졌을 수 있음 → 무시 가능
        // console.warn(e);
    }

    // DOM 제거
    g.card.remove();
    ui.groups.delete(groupId);
}

/** =========================
 *  (7) set_media(groupId, kind, stream)
 *  - 기존 srcObject 있으면 교체 후 기존 트랙 stop + producer/consumer close
 *  ========================= */
export async function set_media(groupId, kind, stream) {
    const g = ui.groups.get(groupId);
    if (!g) return;
    const mediaEl = g.card.querySelector(kind === 'video' ? 'video' : 'audio');

    // 기존 정리
    const slot = g.media[kind];
    const prevStream = slot.stream;
    const prevRole = slot.role;
    const prevId = slot.id;

    // 새로운 스트림 할당
    mediaEl.srcObject = stream;

    // 상태 갱신
    g.media[kind] = {
        stream,
        role: (g.mode === 'local' ? 'producer' : 'consumer'), // remote 소비 기본 가정
        id: (kind === 'video' ? g.videoId : g.audioId),
        paused: false,
        synthetic: false,
    };

    // 이전 정리 (stop + core close)
    if (prevStream) {
        try {
            prevStream.getTracks().forEach(t => t.stop());
        } catch { }
    }
    if (prevId !== 'NULL') {
        try {
            if (prevRole === 'producer') {
                await core.handleCloseProducing(prevId); // TODO(core)
            } else if (prevRole === 'consumer') {
                await core.handleClose(prevId); // TODO(core)
            }
        } catch {
            // 이미 닫혔을 수 있음
        }
    }
}

/** =========================
 *  (8) del_media(groupId, kind)
 *  - srcObject=null, 비디오는 블랙 프레임
 *  ========================= */
export async function del_media(groupId, kind) {
    const g = ui.groups.get(groupId);
    if (!g) return;

    const slot = g.media[kind];
    const mediaEl = g.card.querySelector(kind === 'video' ? 'video' : 'audio');

    // core close (가능 시)
    if (slot && slot.id !== 'NULL') {
        try {
            if (slot.role === 'producer') {
                await core.handleCloseProducing(slot.id); // TODO(core)
            } else if (slot.role === 'consumer') {
                await core.handleClose(slot.id); // TODO(core)
            }
        } catch { }
    }

    // tracks stop
    if (slot && slot.stream) {
        try { slot.stream.getTracks().forEach(t => t.stop()); } catch { }
    }

    // detach
    mediaEl.srcObject = null;

    // video는 블랙 프레임 처리
    if (kind === 'video') {
        const black = createBlackVideoStream();
        mediaEl.srcObject = black;
        g.media.video = { stream: black, role: 'synthetic', id: 'NULL', paused: false, synthetic: true };
    } else {
        g.media.audio = { stream: null, role: 'none', id: 'NULL', paused: false, synthetic: false };
    }
}

/** =========================
 *  (8-확장) update_group(groups)
 *  - 원격 변경 사항 반영(core 콜백 전용)
 *  - {group_id: { videoId, audioId, userId? } }
 *  ========================= */
export async function update_group(groupsWrapper) {
    // 서버에서 오는 payload: { groups: [[gid, payload], [gid, payload], ...] }
    const arr = groupsWrapper.groups;

    // 1) 신규/변경 반영
    for (const [gid, payload] of arr) {
        const nextVideoId = (payload.video_id ?? 'NULL');
        const nextAudioId = (payload.audio_id ?? 'NULL');
        const ownerUserId = (payload.creater ?? 'remoteUser');

        if (!ui.groups.has(gid)) {
            // 신규 그룹 추가 (remote 로 간주)
            add_group(gid, ownerUserId, nextVideoId, nextAudioId, 'remote');
        } else {
            const g = ui.groups.get(gid);
            if (g.videoId !== nextVideoId || g.audioId !== nextAudioId) {
                set_group(gid, nextVideoId, nextAudioId);
            }
        }
    }

    // 2) 삭제 감지 (기존에 있는데 서버 배열에 없는 경우)
    const serverGroupIds = new Set(arr.map(([gid]) => gid));

    for (const gid of ui.groups.keys()) {
        if (!serverGroupIds.has(gid)) {
            await del_group(gid);
        }
    }
}

/** =========================
 *  (9) updateTransportStatus(direction, state)
 *  ========================= */
export function updateTransportStatus(direction, stateStr) {
    if (direction === 'send') {
        dom.sendTransport().textContent = stateStr;
    } else if (direction === 'recv') {
        dom.recvTransport().textContent = stateStr;
    }
}

/** =========================
 *  Local Produce 제어
 *  ========================= */
async function startLocalProduce(groupId, kind, deviceId, mediaEl) {
    const g = ui.groups.get(groupId);
    if (!g || g.mode !== 'local') return;

    try {
        // 1) getUserMedia
        const constraints =
            kind === 'video'
                ? { video: { deviceId: deviceId ? { exact: deviceId } : undefined }, audio: false }
                : { audio: { deviceId: deviceId ? { exact: deviceId } : undefined }, video: false };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const track =
            kind === 'video' ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];

        // 2) core.startProducing(track) → producerId
        const producerId = await core.handleStartProducing(track); // TODO(core)

        // 3) UI에 stream 바인딩 (기존 정리는 set_media 내부에서 처리)
        await set_media(groupId, kind, stream);
        // role/id 덮어쓰기 (local producer)
        g.media[kind].role = 'producer';
        g.media[kind].id = producerId;

        // 4) groupId 상태/서버에 반영
        if (kind === 'video') {
            g.videoId = producerId;
        } else {
            g.audioId = producerId;
        }
        updateMetaIds(g);

        // 서버 통지
        const newV = g.videoId ?? 'NULL';
        const newA = g.audioId ?? 'NULL';
        await core.setGroup(groupId, newV, newA); // TODO(core)
    } catch (e) {
        alert(`Start produce failed (${kind}): ${e}`);
    }
}

async function closeLocalProduce(groupId, kind) {
    const g = ui.groups.get(groupId);
    if (!g || g.mode !== 'local') return;

    const slot = g.media[kind];
    const id = slot.id;

    if (id !== 'NULL') {
        try {
            await core.handleCloseProducing(id); // TODO(core)
        } catch (e) {
            // 이미 닫혔을 수 있음
        }
    }

    // media 제거 + black frame(비디오)
    await del_media(groupId, kind);

    // groupId 상태 반영 및 서버 반영
    if (kind === 'video') g.videoId = 'NULL';
    else g.audioId = 'NULL';
    updateMetaIds(g);
    await core.setGroup(groupId, g.videoId, g.audioId); // TODO(core)
}

function pauseMedia(groupId, kind, paused) {
    const g = ui.groups.get(groupId);
    if (!g) return;
    const slot = g.media[kind];
    if (!slot || !slot.stream) return;

    slot.paused = paused;
    slot.stream.getTracks().forEach((t) => {
        // pause/resume 는 enabled 토글로 처리(실제 송수신 정지는 아님)
        t.enabled = !paused;
    });
}

/** =========================
 *  Remote Consume 제어 (버튼)
 *  ========================= */
async function startRemoteConsume(groupId, kind, mediaEl) {
    const g = ui.groups.get(groupId);
    if (!g || g.mode !== 'remote') return;

    const idFromServer = (kind === 'video') ? g.videoId : g.audioId;
    if (idFromServer === 'NULL') {
        alert(`No ${kind} producer to consume.`);
        return;
    }

    try {
        const res = await core.handleConsumeStream(idFromServer, kind, groupId); // TODO(core)
        const stream = (res && res.stream) ? res.stream : res;
        await set_media(groupId, kind, stream);

        // consumerId 채워주기 (반환 시)
        if (res && res.consumerId && typeof res.consumerId === 'string') {
            g.media[kind].id = res.consumerId;
            g.media[kind].role = 'consumer';
        } else {
            // TODO(core): consumerId 제공 필요 (정리 정확도 향상)
        }
    } catch (e) {
        alert(`Start consume failed (${kind}): ${e}`);
    }
}

async function closeRemoteConsume(groupId, kind) {
    const g = ui.groups.get(groupId);
    if (!g || g.mode !== 'remote') return;

    const slot = g.media[kind];
    if (slot.id !== 'NULL') {
        try {
            await core.handleClose(slot.id); // TODO(core)
        } catch { }
    }
    await del_media(groupId, kind);
}

/** =========================
 *  초기 바인딩
 *  ========================= */
function bindGlobalUI() {
    dom.joinBtn().addEventListener('click', join_room);
    dom.leaveBtn().addEventListener('click', leave_room);

    dom.addGroupBtn().addEventListener('click', async () => {
        try {
            // 그룹 생성
            const newGroupId = await core.setGroup(0, 'NULL', 'NULL'); // 0 → 생성 규약, "NULL" 허용  // TODO(core)
            add_group(newGroupId, ui.userId, 'NULL', 'NULL', 'local');
        } catch (e) {
            alert(`add group failed: ${e}`);
        }
    });
}

window.addEventListener('DOMContentLoaded', () => {
    setButtonsForStatus();
    bindGlobalUI();
});

/* =========================================================
   정리/메모 (core.js에 필요한 포인트)
   ---------------------------------------------------------
   - handleJoinRoom(roomId, userId, update_groupCb, leave_roomCb, updateTransportStatusCb)
     * 성공 시 resolve(), 실패 시 reject(message)
     * 서버 이벤트를 update_groupCb로 내려줄 것 (payload: { [gid]: { videoId, audioId, userId? } })
     * 연결 종료 감지 시 leave_roomCb 호출
     * 트랜스포트 상태 변경 시 updateTransportStatusCb(direction, state) 호출

   - handleLeaveRoom(): 방 퇴장, 소켓/자원 정리 보장

   - handleStartProducing(track): resolve(producerId)

   - handleCloseProducing(producerId): resolve(producerId)

   - handleConsumeStream(producerId, kind, groupId):
       현재 스펙에선 resolve(stream)만 기술됨.
       → UI에서 consumer close/교체를 정확히 처리하려면 consumerId 필요.
       제안: resolve({ stream, consumerId })
       (UI는 consumerId 존재 시 close 시도, 없으면 tracks stop만 수행)

   - handleClose(id): producerId 또는 consumerId를 받아 적절히 close

   - setGroup(groupId, videoId, audioId):
       groupId == "0" 이면 생성 → resolve(신규 groupId)
       그 외 수정 → resolve(groupId)

   - del_group(groupId): resolve(groupId)
   ========================================================= */
