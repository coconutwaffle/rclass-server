// ui-groups.js — ES Module
import * as core from './core.js';
import { ui, GroupState } from './ui-state.js';
import { el, listDevices, createBlackVideoStream, dom } from './ui-utils.js';

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

    btnDel.onclick = () => del_group_ui(groupId);
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

    btnDel.onclick = () => del_group_ui(groupId);

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

export function set_group(groupId, videoId, audioId) {
    const g = ui.groups.get(groupId);
    if (!g) return;

    g.videoId = (typeof videoId === 'string') ? videoId : 'NULL';
    g.audioId = (typeof audioId === 'string') ? audioId : 'NULL';
    updateMetaIds(g);
}

async function del_group_ui(gruopId){
    if (!ui.localgroups.includes(gruopId))
    {
        return;
    }
    await del_group(gruopId);
    ui.localgroups.remove(gruopId);
}
export async function del_group(groupId) {
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
                core.handleCloseProducing(prevId); // TODO(core)
            } else if (prevRole === 'consumer') {
                core.handleClose(prevId); // TODO(core)
            }
        } catch {
            // 이미 닫혔을 수 있음
        }
    }
}

export async function del_media(groupId, kind) {
    const g = ui.groups.get(groupId);
    if (!g) return;

    const slot = g.media[kind];
    const mediaEl = g.card.querySelector(kind === 'video' ? 'video' : 'audio');

    // core close (가능 시)
    if (slot && slot.id !== 'NULL') {
        try {
            if (slot.role === 'producer') {
                core.handleCloseProducing(slot.id); // TODO(core)
            } else if (slot.role === 'consumer') {
                core.handleClose(slot.id); // TODO(core)
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
            core.handleCloseProducing(id); // TODO(core)
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
            core.handleClose(slot.id); // TODO(core)
        } catch { }
    }
    await del_media(groupId, kind);
}
