// ui-main.js — ES Module
import * as core from './core.js';
import { ui } from './ui-state.js';
import { dom } from './ui-utils.js';
import { initChat, clearChatUI , recv_chat_upate} from './ui-chat.js';
import { add_group, set_group, del_group } from './ui-groups.js';

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
            updateTransportStatus,
            recv_chat_upate
        ); // TODO(core): core.handleJoinRoom 구현 필요 (콜백 호출 포함)
        ui.status = 'joined';
        setButtonsForStatus();
        initChat(); // 채팅 기능 초기화
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

        clearChatUI(); // 채팅 UI 정리

        ui.status = 'idle';
        setButtonsForStatus();
    }
}

/** =========================
 *  (8-확장) update_group(groups)
 *  - 원격 변경 사항 반영(core 콜백 전용)
 *  - {group_id: { videoId, audioId, userId? } }
 *  ========================= */
export async function update_group(payload) {
    const { group_id, mode, data } = payload;

    switch (mode) {
        case 'create': {
            const { video_id, audio_id, clientId } = data;
            add_group(group_id, clientId, video_id, audio_id, 'remote');
            break;
        }
        case 'edit': {
            const { video_id, audio_id } = data;
            const g = ui.groups.get(group_id);
            if (g && (g.videoId !== video_id || g.audioId !== audio_id)) {
                set_group(group_id, video_id, audio_id);
            }
            break;
        }
        case 'delete': {
            if (ui.groups.has(group_id)) {
                await del_group(group_id);
            }
            break;
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