// ui-utils.js — ES Module

/** =========================
 *  DOM 헬퍼
 *  ========================= */
export const $ = (sel) => document.querySelector(sel);
export const el = (tag, cls) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
};

export const dom = {
    roomId: () => $('#roomId'),
    userId: () => $('#userId'),
    joinBtn: () => $('#joinBtn'),
    leaveBtn: () => $('#leaveBtn'),
    addGroupBtn: () => $('#addGroupBtn'),
    sendTransport: () => $('#sendTransport'),
    recvTransport: () => $('#recvTransport'),
    groups: () => $('#groupsContainer'),
    chatMessages: () => $('#chatMessages'),
    chatInput: () => $('#chatInput'),
    chatSendBtn: () => $('#chatSendBtn'),
};


/** =========================
 *  블랙 프레임 스트림 생성 (video)
 *  ========================= */
export function createBlackVideoStream(width = 640, height = 360) {
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
 *  장치 나열 (local 전용)
 *  ========================= */
export async function listDevices() {
    // 첫 enumerate 이전에 장치 권한 부여 필요할 수 있음(브라우저 정책)
    try {
        await navigator.mediaDevices.getUserMedia({ audio: false, video: false }).catch(() => { });
    } catch { }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    const mics = devices.filter((d) => d.kind === 'audioinput');
    return { cams, mics };
}
