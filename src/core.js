// core.js (refactored)

import { io } from 'socket.io-client';
import { Device } from 'mediasoup-client';

/**
 * @typedef {{ result: boolean, data: any }} ServerResponse
 * @typedef {'send'|'recv'} TransportKind
 */

export class RoomClient {
  /** @type {ReturnType<typeof io>|null} */
  #socket = null;
  /** @type {Device|null} */
  #device = null;
  /** @type {import('mediasoup-client/lib/Transport').Transport|null} */
  #sendTransport = null;
  /** @type {import('mediasoup-client/lib/Transport').Transport|null} */
  #recvTransport = null;
  /** @type {Map<string, import('mediasoup-client/lib/Producer').Producer>} */
  #producers = new Map();
  /** @type {Map<string, import('mediasoup-client/lib/Consumer').Consumer>} */
  #consumers = new Map();
  /** @type {Set<number>} */
  #localGroups = new Set();

  /** 외부로 전달할 콜백들 */
  /** @type {(reason?: any)=>void} */
  onDisconnect = () => {};
  /** @type {(groups: any)=>void} */
  onGroupsUpdated = () => {};
  /** @type {(groups: any)=>void} */
  onRecvchat = () => {};
  /** @type {(kind: TransportKind, state: string)=>void} */
  onTransportState = () => {};

  /** 내부 공용 요청 래퍼(타임아웃 포함) */
  #request(type, data = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!this.#socket) return reject(new Error('No socket connection'));
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Request timeout: ${type}`));
        }
      }, timeoutMs);

      this.#socket.emit(type, data, /** @param {ServerResponse} res */ (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (res?.result) resolve(res.data);
        else reject(new Error(res?.data || `Request failed: ${type}`));
      });
    });
  }

  /** 소켓 연결 및 룸 조인 */
  async join({ roomId, userId }) {
    if (!roomId || !userId) throw new Error('Room ID and User ID are required');

    // 1) 소켓 연결
    this.#socket = io({
      path: '/socket.io',
      transports: ['websocket'],
    });

    await new Promise((resolve, reject) => {
      if (!this.#socket) return reject(new Error('Socket not created'));
      this.#socket.on('connect', resolve);
      this.#socket.on('connect_error', reject);
    });

    // 2) 서버에 조인
    const { rtpCapabilities } = await this.#request('join_room', { roomId, clientId: userId });

    // 3) 이벤트 바인딩
    this.#socket.on('disconnect', (reason) => this.onDisconnect?.(reason));
    this.#socket.on('update_group_one', (payload) => this.onGroupsUpdated?.(payload));
    this.#socket.on('chat_message', (payload) => this.onRecvchat?.(payload));
    // 4) Device 준비
    this.#device = new Device();
    await this.#device.load({ routerRtpCapabilities: rtpCapabilities });

    // 5) rtpCapabilities 서버에 저장
    await this.#request('store_rtp_capabilities', { rtpCapabilities: this.#device.rtpCapabilities });

    // 6) 트랜스포트 생성
    await this.#createTransports();

    // 7) 초기 그룹 상태 fetch
    const initialGroups = await this.getGroups();
    if (this.onGroupsUpdated) {
      for (const [groupId, groupData] of initialGroups.groups) {
        this.onGroupsUpdated({ group_id: groupId, mode: 'create', data: groupData });
      }
    }
  }

  /** 트랜스포트 생성/연결 공통 */
  async #createTransports() {
    if (!this.#device) throw new Error('Device not ready');

    // --- Send Transport ---
    const sendParams = await this.#request('create_transport');
    this.#sendTransport = this.#device.createSendTransport(sendParams);
    this.#sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await this.#request('connect_transport', { transportId: this.#sendTransport.id, dtlsParameters });
        callback();
      } catch (err) {
        errback(err);
      }
    });
    this.#sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
      try {
        const { id } = await this.#request('produce', { transportId: this.#sendTransport.id, kind, rtpParameters });
        callback({ id });
      } catch (err) {
        errback(err);
      }
    });
    this.#sendTransport.on('connectionstatechange', (state) => this.onTransportState?.('send', state));

    // --- Receive Transport ---
    const recvParams = await this.#request('create_transport');
    this.#recvTransport = this.#device.createRecvTransport(recvParams);
    this.#recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await this.#request('connect_transport', { transportId: this.#recvTransport.id, dtlsParameters });
        callback();
      } catch (err) {
        errback(err);
      }
    });
    this.#recvTransport.on('connectionstatechange', (state) => this.onTransportState?.('recv', state));
  }

  /** 프로듀서 시작 */
  async startProducing(track) {
    if (!this.#sendTransport) throw new Error('Send transport not ready');
    const producer = await this.#sendTransport.produce({ track });
    this.#producers.set(producer.id, producer);
    return producer.id;
  }

  /** 프로듀서 종료 */
  stopProducing(producerId) {
    const p = this.#producers.get(producerId);
    if (p) {
      p.close();
      this.#producers.delete(producerId);
    }
  }

  /** 컨슈머 생성 및 재생 */
  async consume(producerId, kind) {
    if (!this.#recvTransport) throw new Error('Recv transport not ready');

    const { id, rtpParameters } = await this.#request('consume', {
      producerId,
      transportId: this.#recvTransport.id,
    });

    const consumer = await this.#recvTransport.consume({ id, producerId, kind, rtpParameters });
    this.#consumers.set(consumer.id, consumer);

    await this.#request('resume_consumer', { consumerId: consumer.id });

    const stream = new MediaStream([consumer.track]);
    return { consumerId: consumer.id, stream };
  }

  /** 컨슈머 종료 */
  closeConsumer(id) {
    const c = this.#consumers.get(id);
    if (c) {
      c.close();
      this.#consumers.delete(id);
    }
  }

  /** 현재 연결 전체 종료 */
  async leave() {
    // 1) 서버 리소스 먼저 정리(그룹)
    for (const id of Array.from(this.#localGroups)) {
      try { await this.delGroup(id); } catch {}
    }
    this.#localGroups.clear();

    // 2) 로컬 리소스 종료
    for (const [, p] of this.#producers) p.close();
    for (const [, c] of this.#consumers) c.close();
    this.#producers.clear();
    this.#consumers.clear();

    if (this.#sendTransport) { this.#sendTransport.close(); this.#sendTransport = null; }
    if (this.#recvTransport) { this.#recvTransport.close(); this.#recvTransport = null; }

    // 3) 소켓 종료 (마지막)
    if (this.#socket) {
      this.#socket.disconnect();
      this.#socket = null;
    }
    this.#device = null;
  }

  // --------- 채팅 ----------
  chatSend(msg, mode, send_to) {
    return this.#request('chat_send', { msg, mode, send_to });
  }
  chatHistory(params) { // {room_id, limit, cursor}
    return this.#request('chat_history', params);
  }

  // --------- 그룹 ----------
  async setGroup(groupId, videoId, audioId) {
    const data = await this.#request('set_group', {
      groupId,
      video_id: videoId,
      audio_id: audioId
    });
    const newId = data.groupId;
    if (typeof newId === 'number') this.#localGroups.add(newId);
    return newId;
  }
  async delGroup(groupId) {
    const data = await this.#request('del_group', { groupId });
    this.#localGroups.delete(groupId);
    return data.deletedGroupId;
  }
  getGroups() {
    return this.#request('get_groups');
  }
  getOnlineUsers() {
    return this.#request('get_online_users');
  }
}

/* ---------------------------
 * 기존 handle* API와의 호환 래퍼
 * (UI 레이어가 바뀌지 않도록 유지)
 * --------------------------*/

let _client/** @type {RoomClient|null} */ = null;

export async function handleJoinRoom(roomId, userId, update_group, leave_room_callback, updateTransportStatus, recv_chat) {
  _client = new RoomClient();
  _client.onDisconnect = leave_room_callback;
  _client.onGroupsUpdated = update_group;
  _client.onTransportState = updateTransportStatus;
  _client.onRecvchat = recv_chat;
  await _client.join({ roomId, userId });
}

export function handleLeaveRoom() {
  if (_client) _client.leave();
  _client = null;
}

export function handleStartProducing(track) {
  if (!_client) throw new Error('Not joined');
  return _client.startProducing(track);
}

export function handleCloseProducing(producerId) {
  if (!_client) throw new Error('Not joined');
  _client.stopProducing(producerId);
  return producerId;
}

export async function handleConsumeStream(producerId, kind /*, groupId UNUSED */) {
  if (!_client) throw new Error('Not joined');
  const { stream } = await _client.consume(producerId, kind);
  return stream;
}

export function handleClose(id) {
  if (!_client) return;
  _client.stopProducing(id);
  _client.closeConsumer(id);
}

export function setGroup(groupId, videoId, audioId) { if (!_client) throw new Error('Not joined'); return _client.setGroup(groupId, videoId, audioId); }
export function del_group(groupId) { if (!_client) throw new Error('Not joined'); return _client.delGroup(groupId); }
export function getGroups() { if (!_client) throw new Error('Not joined'); return _client.getGroups(); }
export function getOnlineUsers() { if (!_client) throw new Error('Not joined'); return _client.getOnlineUsers(); }
export function chat_send(msg, mode, send_to) { if (!_client) throw new Error('Not joined'); return _client.chatSend(msg, mode, send_to); }
export function chat_history(start_seq, end_seq) {
  if (!_client) throw new Error("Not joined");
  return _client.chatHistory({ start_seq, end_seq });
}
