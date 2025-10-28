function nextSeq(room) { return ++room.last_seq; }

// 유틸: 이진탐색(lowerBound/upperBound) — seq 오름차순 가정
function lowerBoundBySeq(arr, targetSeq) {
  let lo = 0, hi = arr.length; // 첫 >= target
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].seq >= targetSeq) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
function upperBoundBySeq(arr, targetSeq) {
  let lo = 0, hi = arr.length; // 첫 > target
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].seq > targetSeq) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function chat_handler(io, socket, rooms, context) {
    socket.on("chat_send", async (data, callback) => {
        try {
            const room = rooms[context.roomId];
            if (!room) return callback?.({ result: false, data: "Not in a room" });

            const msgText = String(data?.msg ?? "");
            if (!msgText) return callback?.({ result: false, data: "empty message" });
            if (msgText.length > 4096) return callback?.({ result: false, data: "message_too_long" });

            const mode = data?.mode === "PRIVATE" ? "PRIVATE" : "ALL";
            const sendTo = Array.isArray(data?.send_to) ? data.send_to : [];

            const ts = Date.now();
            const seq = nextSeq(room);
            const msgId = `${context.roomId}-${seq}`;

            let recipients = [];
            const chat = {
                seq,
                msgId,
                ts,
                msg: msgText,
                mode,
                send_to: recipients,
                from: context.clientId,
            };
            if (mode !== "ALL") {
                const validTargets = new Set([context.clientId]);
                for (const cid of sendTo) {
                    if (room.clients.has(room.clientIdToUUID.get(cid))) validTargets.add(cid);
                }

                if (validTargets.size === 1) {
                    return callback?.({ result: false, data: "no valid recipients" });
                }

                // recipients = 자기 자신 + 유효한 대상 전체
                recipients = [...validTargets];
                chat.send_to = recipients;
            }

            room.chat_log.push(chat);
            if (mode === "ALL") {
                console.log(`[${context.roomId}][${msgId}] ${context.clientId} to ALL: ${msgText}`);
                io.to(context.roomId).emit("chat_message", chat);
            }
            else {
                for (const cid of recipients) {
                    const entry = room.clients.get(cid);
                    console.log(`[${context.roomId}][${msgId}] ${context.clientId} to ${cid} (PRIVATE): ${msgText}`);
                    entry?.socket?.emit("chat_message", chat);
                }
            }
            callback?.({ result: true, data: { msgId, ts } });
        } catch (err) {
            console.error(`[ERROR] in 'chat_send' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback?.({ result: false, data: err.message });
        }
    });


    // 히스토리 요청
    socket.on("chat_history", async (data, callback) => {
        try {
            const room = rooms[context.roomId];
            if (!room) return callback?.({ result: false, data: "not_in_room" });

            // 0) 권한 필터 통과 메시지 배열(이미 seq 오름차순이라고 가정)
            const visible = room.chat_log.filter(m =>
                m.mode === "ALL" ||
                (m.mode === "PRIVATE" && (m.from === context.clientId || (Array.isArray(m.send_to) && m.send_to.includes(context.clientId))))
            );

            const DEFAULT_WINDOW = 50;
            const MAX_WINDOW = 200;

            // 1) 입력 정규화
            let startSeq = Number.isFinite(data?.start_seq) ? Number(data.start_seq) : undefined;
            let endSeq = Number.isFinite(data?.end_seq) ? Number(data.end_seq) : undefined;

            // visible이 비면 즉시 반환
            if (visible.length === 0) {
                return callback?.({ result: true, data: { messages: [], before_messages_number: 0, after_messages_number: 0 } });
            }

            const minSeq = visible[0].seq;
            const maxSeq = visible[visible.length - 1].seq;

            // 2) 기본 구간 보정
            if (startSeq == null && endSeq == null) {
                // 최신 꼬리 DEFAULT_WINDOW
                endSeq = maxSeq;
                startSeq = Math.max(minSeq, endSeq - (DEFAULT_WINDOW - 1));
            } else if (startSeq == null) {
                // end만 있음 → 뒤쪽 고정, 앞쪽으로 윈도 생성
                endSeq = Math.min(Math.max(endSeq, minSeq), maxSeq);
                startSeq = Math.max(minSeq, endSeq - (MAX_WINDOW - 1));
            } else if (endSeq == null) {
                // start만 있음 → 앞쪽 고정, 뒤로 윈도 생성
                startSeq = Math.min(Math.max(startSeq, minSeq), maxSeq);
                endSeq = Math.min(maxSeq, startSeq + (MAX_WINDOW - 1));
            } else {
                // 둘 다 있음 → 범위 정렬
                if (startSeq > endSeq) [startSeq, endSeq] = [endSeq, startSeq];
                // 서버 보호: 너무 큰 창이면 MAX_WINDOW로 클램프(뒤쪽 기준으로 맞추기)
                if (endSeq - startSeq + 1 > MAX_WINDOW) {
                    startSeq = endSeq - (MAX_WINDOW - 1);
                }
                // 경계 클램프
                startSeq = Math.max(minSeq, startSeq);
                endSeq = Math.min(maxSeq, endSeq);
            }

            // 3) 이진탐색으로 인덱스 범위 구하기 (포함형 [startSeq, endSeq])
            const left = lowerBoundBySeq(visible, startSeq);      // 첫 seq>=startSeq
            const right = upperBoundBySeq(visible, endSeq);        // 첫 seq> endSeq (배타)
            const messages = visible.slice(left, right);

            // 4) 남은 개수 계산 (권한 필터 이후 기준)
            const before_messages_number = left;                         // 구간 앞에 있는 개수
            const after_messages_number = visible.length - right;       // 구간 뒤에 있는 개수

            callback?.({
                result: true,
                data: {
                    messages,
                    before_messages_number,
                    after_messages_number
                }
            });
        } catch (err) {
            console.error(`[ERROR] in 'chat_history' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback?.({ result: false, data: err.message });
        }
    });
};

export default chat_handler;