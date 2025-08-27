// ui-chat.js — ES Module
import * as core from './core.js';
import { dom, el } from './ui-utils.js';
import { get_UIstatus } from './ui-main.js';
import { parseScalabilityMode } from 'mediasoup-client';

/** =========================
 *  채팅 관련 변수 및 함수
 *  ========================= */
let chatHistoryLoaded = false;
let lastMessageTimestamp = 0;
let chatUpdateTimer = null;

export function clearChatUI() {
    dom.chatMessages().innerHTML = '';
    chatHistoryLoaded = false;
    lastMessageTimestamp = 0;
    if (chatUpdateTimer) {
        clearInterval(chatUpdateTimer);
        chatUpdateTimer = null;
    }
}

function appendChatMessage({ from, msg, ts }) {
    const msgDiv = el('div', 'chat-message');
    const timestamp = new Date(ts).toLocaleTimeString();
    msgDiv.innerHTML = `<div><span class="meta">[${timestamp}] <b>${from}</b></span></div><div>${msg}</div>`;
    dom.chatMessages().appendChild(msgDiv);

    // 가장 최신 메시지 타임스탬프 저장
    if (ts > lastMessageTimestamp) {
        lastMessageTimestamp = ts;
    }
}

function scrollToChatBottom() {
    const chatContainer = dom.chatMessages();
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

async function loadChatHistory() {
    if (!get_UIstatus('isJoined')) return;

    try {
        const params = { limit: 100 };
        // 두 번째 로드부터는 마지막 메시지 이후의 메시지만 가져옴
        if (chatHistoryLoaded && lastMessageTimestamp > 0) {
            params.after_ts = lastMessageTimestamp;
        }

        const history = await core.chat_history(params);
        if (history && history.messages) {
            history.messages.forEach(appendChatMessage);
            if (history.messages.length > 0) {
                scrollToChatBottom();
            }
        }
        chatHistoryLoaded = true;
    } catch (e) {
        console.error('Failed to load chat history:', e);
    }
}

async function sendChatMessage() {
    const input = dom.chatInput();
    const msg = input.value.trim();
    if (!msg) return;

    try {
        await core.chat_send(msg, 'ALL', []);
        input.value = '';
    } catch (e) {
        alert(`Failed to send message: ${e}`);
    }
}
export async function recv_chat_upate(chat)
{
    appendChatMessage(chat);
    scrollToChatBottom();
}
export function initChat() {
    // 1. 기존 채팅 기록 불러오기
    loadChatHistory();

    // 2. 5초마다 새로운 메시지 폴링
    if (chatUpdateTimer) clearInterval(chatUpdateTimer);
    chatUpdateTimer = setInterval(loadChatHistory, 5000);

    // 3. 전송 버튼 이벤트 바인딩
    dom.chatSendBtn().onclick = sendChatMessage;
    dom.chatInput().onkeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendChatMessage();
        }
    };
}
