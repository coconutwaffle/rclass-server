function make_dummy_log()
{
    return {
            "per_block": [
            {
                "closed_frames": 0,
                "end_ms": 0,
                "label": "NO_CAMERA",
                "noface_frames": 0,
                "open_frames": 0,
                "open_ratio": 0,
                "start_ms": 0,
                "total_frames": 0
            }
            ],
            "summary": {
            "blocks": 0,
            "frame_open_ratio": 0,
            "no_camera_blocks": 0,
            "noface_blocks": 0,
            "notopen_blocks": 0,
            "open_blocks": 0,
            "total_closed": 0,
            "total_frames": 0,
            "total_noface": 0,
            "total_open": 0
            }
    }
}
function check_log_complete(io, socket, room, context)
{
    try {
        let not_complete_list = [] 
        room.clients_log_isComplete.forEach((value, key) => {
            if(!value && key !== room.creator_client_id)
            {
                console.log(`log_complete not complete ${key}`);
                if(room.clients.has(key))
                {
                    not_complete_list.push(key);
                } else
                {
                    room.clients_log_isComplete.set(key, true);
                    if(room.clients_log.has(key))
                    {
                        const log_ = make_dummy_log();
                        const ts = Date.now()
                        room.clients_log.get(key).set(ts, {end_ts: ts, log:log_});
                    }
                    console.log(`[check_log_complete] client ${key} disconnected, force-completed log`);
                }
            }
        });

        if(not_complete_list.length  === 0)
        {
            console.log(`log_compelte all done`);
            const full_log = {};
            room.clients_log.forEach((clientLogMap, cid) => {
                if(cid !== room.creator_client_id)
                    full_log[cid] = Object.fromEntries(clientLogMap);
            });
            room.merged_log = mergeFullLogWithLessonTime(
                full_log,
                room.lesson.start_time,
                room.lesson.end_time
            );

            if (!room.notified) {
                room.notified = true;
                console.log("emit all " + JSON.stringify(room.merged_log, null, 2));
                io.to(context.roomId).emit("log_all_complete", room.merged_log);
                checkAttendance(io, socket, room, context);
                console.log(`emit done roomid: ${context.roomId}`);
            }
            return true;
        }
        else
        {
            console.log(`log competle not all done`);
            console.log(JSON.stringify(not_complete_list));
        }
    } catch(e){
        console.error(`[ERROR] in 'check_log_complete' handler:`, e);
        if (e instanceof Error) {
            console.error(e.stack);
        }
    }
    return false;
}

function get_all_students(roomId)
{
    //TODO DB
    return [
        'qml-user',
        'asdf'
    ]
}
function mergeClientLogsWithLessonTime(clientLogs, lessonStart, lessonEnd) {
  const mergedBlocks = [];
  const summary = {
    blocks: 0,
    frame_open_ratio: 0,
    no_camera_blocks: 0,
    noface_blocks: 0,
    notopen_blocks: 0,
    open_blocks: 0,
    total_closed: 0,
    total_frames: 0,
    total_noface: 0,
    total_open: 0,
  };

  for (const [tsStr, entry] of Object.entries(clientLogs)) {
    const sessionAbsStart = parseInt(tsStr, 10);
    const log = entry.log;
    if (!log) continue;

    for (const block of log.per_block) {
      const absStart = sessionAbsStart + block.start_ms;
      const absEnd = sessionAbsStart + block.end_ms;
      const relStart = absStart - lessonStart;
      const relEnd = absEnd - lessonStart;

      mergedBlocks.push({
        start_ms: relStart,
        end_ms: relEnd,
        label: block.label,
        closed_frames: block.closed_frames,
        noface_frames: block.noface_frames,
        open_frames: block.open_frames,
        open_ratio: block.open_ratio,
        total_frames: block.total_frames,
      });
    }

    const s = log.summary;
    summary.blocks += s.blocks;
    summary.no_camera_blocks += s.no_camera_blocks;
    summary.noface_blocks += s.noface_blocks;
    summary.notopen_blocks += s.notopen_blocks;
    summary.open_blocks += s.open_blocks;
    summary.total_closed += s.total_closed;
    summary.total_frames += s.total_frames;
    summary.total_noface += s.total_noface;
    summary.total_open += s.total_open;
  }

  // 시간순 정렬
  mergedBlocks.sort((a, b) => a.start_ms - b.start_ms);

  // 빈 구간 채우기
  const filledBlocks = [];
  let prevEnd = 0;
  for (const block of mergedBlocks) {
    if (block.start_ms > prevEnd) {
      // gap → NO_CAMERA
      filledBlocks.push({
        start_ms: prevEnd,
        end_ms: block.start_ms,
        label: "NO_CAMERA",
        closed_frames: 0,
        noface_frames: 0,
        open_frames: 0,
        open_ratio: 0,
        total_frames: 0,
      });
      summary.blocks += 1;
      summary.no_camera_blocks += 1;
    }
    filledBlocks.push(block);
    prevEnd = block.end_ms;
  }

  // 끝 부분도 채우기 (lessonEnd까지)
  if (prevEnd < lessonEnd - lessonStart) {
    filledBlocks.push({
      start_ms: prevEnd,
      end_ms: lessonEnd - lessonStart,
      label: "NO_CAMERA",
      closed_frames: 0,
      noface_frames: 0,
      open_frames: 0,
      open_ratio: 0,
      total_frames: 0,
    });
    summary.blocks += 1;
    summary.no_camera_blocks += 1;
  }

  // frame_open_ratio 재계산
  if (summary.total_frames > 0) {
    summary.frame_open_ratio = summary.total_open / summary.total_frames;
  }

  return {
    per_block: filledBlocks,
    summary,
  };
}


function mergeFullLogWithLessonTime(full_log, lessonStart, lessonEnd) {
  const mergedLogs = {};
  for (const [clientId, clientLogs] of Object.entries(full_log)) {
    mergedLogs[clientId] = mergeClientLogsWithLessonTime(
      clientLogs,
      lessonStart,
      lessonEnd
    );
  }
  return {
    full_log: mergedLogs,
    lesson_start: lessonStart,
    lesson_end: lessonEnd,
  };
}
function evaluateAttendance(log, lessonStart, lessonEnd, policy) {
  if (!log) {
    return { status: "absent", reason: "no log" };
  }

  const { per_block, summary, firstAppear_ms, lastAppear_ms } = log;
  const totalDuration = lessonEnd - lessonStart;

  // 1. 얼굴이 아예 없었음
  if (firstAppear_ms == null || per_block.length === 0) {
    return { status: "absent", reason: "never appeared" };
  }

  // 2. 첫 등장 시각 (수업 상대시간)
  const firstJoinAt = firstAppear_ms;
  if (firstJoinAt > policy.max_noappear) {
    return { status: "absent", reason: "no show (missed > max_noappear)" };
  }

  const isLate = firstJoinAt > policy.start_late;

  // 3. 조퇴 판정
  let isEarlyExit = false;
  if (lastAppear_ms != null) {
    const gapToEnd = lessonEnd - (lessonStart + lastAppear_ms);
    if (gapToEnd > policy.ealry_exit) {
      isEarlyExit = true;
    }
  }

  // 4. 출석 비율 계산 (per_block 기반)
  let openDuration = 0;
  for (const block of per_block) {
    const duration = Math.max(0, block.end_ms - block.start_ms);
    if (block.label === "OPEN") {
      openDuration += duration;
    }
  }
  const ratio = totalDuration > 0 ? openDuration / totalDuration : 0;
  const hasEnoughPart = ratio >= policy.min_part;

  // 5. 최종 판정
  if (!hasEnoughPart) {
    return { status: "absent", reason: "below min_part" };
  }

  if (isLate && isEarlyExit) {
    return { status: "absent", reason: "late + early_exit" };
  }
  if (isLate) {
    return { status: "late", reason: "joined after start_late" };
  }
  if (isEarlyExit) {
    return { status: "early_exit", reason: "left early" };
  }
  return { status: "present", reason: "all conditions ok" };
}


// === 모드 1: 단순 로그만 받아서 판정 ===
function evaluateAttendanceForClients(full_log, lessonStart, lessonEnd, policy, registeredStudents, creatorId) {
  const results = {};
  for (const [id, mergedLog] of Object.entries(full_log)) {
    if (id === creatorId) continue; // 선생님 제외
    const evalResult = evaluateAttendance(mergedLog, lessonStart, lessonEnd, policy);
    results[id] = {
      status: evalResult.status,
      reason: evalResult.reason,
      guest: !registeredStudents.includes(id),
      detail: mergedLog ? mergedLog.summary : null,
      per_block: mergedLog ? mergedLog.per_block : [],
    };
  }
  return results;
}

// === 모드 2: io/socket/room/context 기반 ===
function checkAttendance(io, socket, room, context) {
  if (check_log_complete(io, socket, room, context)) {
    const start_ts = room.lesson.start_time;
    const end_ts = room.lesson.end_time;
    const policy = room.attendancePolicy;
    const studs = get_all_students(context.roomId);

    const full_log = room.merged_log?.full_log || {};
    const results = evaluateAttendanceForClients(full_log, start_ts, end_ts, policy, studs, room.creator_client_id);

    const response = {
      lesson_start: start_ts,
      lesson_end: end_ts,
      results,
    };

    room.attendance_result = response;
    console.log("[checkAttendance] result:", JSON.stringify(response, null, 2));
    io.to(context.roomId).emit("attendance_checked", response);

    return response;
  }
  return null;
}


function lesson_handler(io, socket, rooms, context){
    socket.on('lesson_start', (data, callback) => {
        try {
            if(!context.logon_id)
            {
                return callback({result: false, data:'log on required'});
            }
            const room = rooms[context.roomId];
            if (!room) return callback({ result: false, data: 'Not in a room' });
            if(room.creator !== context.logon_id)
            {
                callback({result:false, data:'Not creator'});
            }
            if(room.lesson.state !== 'Not started')
            {
                return callback({result:false, data:'Already started'})
            }
            room.lesson.state = 'Started';
            room.lesson.start_time = Date.now();
            console.log(`lesson_start room: ${context.roomId}`)
            const res = {start_ts:room.lesson.start_time};
            socket.to(context.roomId).emit('lesson_started',  res)
            callback({result:true, data: res});
        } catch (e) {
            console.error(`[ERROR] in 'lesson_start' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    })
    socket.on('lesson_end', (data, callback) => {
        try {
            if(!context.logon_id)
            {
                return callback({result: false, data:'log on required'});
            }
            const room = rooms[context.roomId];
            if (!room) return callback({ result: false, data: 'Not in a room' });
            if(room.creator !== context.logon_id)
            {
                return callback({result:false, data:'Not creator'});
            }
            if(room.lesson.state === 'Not started')
            {
                return callback({result:false, data:'Not started'});
            }
            if(room.lesson.state === 'Ended')
            {
                return callback({result:false, data:'Already ended'});
            }
            room.lesson.state = 'Ended';
            room.lesson.end_time = Date.now();
            console.log(`lesson_end room: ${context.roomId}`);
            const res = {start_ts:room.lesson.start_time, end_ts: room.lesson.end_time};
            socket.to(context.roomId).emit('lesson_ended', res);
            check_log_complete(io, socket, room, context);
            callback({result:true, data:res});
        } catch (e) {
            console.error(`[ERROR] in 'lesson_end' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    })
    socket.on('lesson_state', (data, callback) => {
        try {
            const room = rooms[context.roomId];
            if (!room) return callback({ result: false, data: 'Not in a room' });
            callback({result:true, data:{state: room.lesson.state}});
        } catch(e) {
            console.error(`[ERROR] in 'lesson_state' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    })
    socket.on('log_backup', (data, callback) => {
        try {
            const room = rooms[context.roomId];
            if (!room) return callback({ result: false, data: 'Not in a room' });
            const log_ = data['log'];
            if(!log_)
            {
                console.log('No log to backup');
                return callback({result:false, data:'log is required'});
            }
            const ts = room.clients.get(context.clientId).join_ts;
            const perClientLog = room.clients_log.get(context.clientId);
            perClientLog.set(ts, { end_ts: Date.now(), log: log_ });
            callback({result:true, data:{join_ts:ts}});
            console.log("log_backup all " + JSON.stringify(
            Object.fromEntries(
                [...room.clients_log].map(([cid, logs]) => [cid, Object.fromEntries(logs)])
            ), null, 2));
        } catch(e) {
            console.error(`[ERROR] in 'log_backup' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    });
    socket.on('log_complete', (data, callback) => {
        try {
            if (!context.roomId || !context.clientId) {
                return callback({ result: false, data: 'roomId and clientId are required' });
            }
            let room = rooms[context.roomId];
            const log_ = data['log'];
            if(!log_)
            {
                return callback({result:false, data:'log is required'});
            }
            console.log(JSON.stringify(log_));
            const ts = room.clients.get(context.clientId).join_ts;
            const perClientLog = room.clients_log.get(context.clientId);
            perClientLog.set(ts, { end_ts: Date.now(), log: log_ });

            room.clients_log_isComplete.set(context.clientId, true);
            check_log_complete(io, socket, room, context);
            const kkk = {full_log: Object.fromEntries(perClientLog) };
            console.log(`ack log_complete to ${context.clientId}`); 
            callback({result: true, data: kkk});
            
        } catch(e) {
            console.error("log_complete error:", e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    })

    socket.on("attendance_override", (data, callback) => {
    try {
      const room = rooms[context.roomId];
      if (!room) return callback({ result: false, data: "Not in a room" });

      if (room.creator !== context.logon_id) {
        return callback({ result: false, data: "Not creator" });
      }

      if (!room.attendance_result) {
        return callback({ result: false, data: "Attendance not available yet" });
      }

      const { studentId, status, reason } = data;
      const validStatuses = ["present", "late", "early_exit", "absent"];

      if (!studentId || !status) {
        return callback({ result: false, data: "studentId and status required" });
      }
      if (!validStatuses.includes(status)) {
        return callback({ result: false, data: "Invalid status" });
      }

      if (!room.attendance_result.results[studentId]) {
        return callback({ result: false, data: "Unknown studentId" });
      }

      // override
      room.attendance_result.results[studentId].status = status;
      room.attendance_result.results[studentId].reason = reason || "manual override";

      console.log(`[attendance_override] ${studentId} -> ${status}`);
      
      // 브로드캐스트
      io.to(context.roomId).emit("attendance_checked", room.attendance_result);

      return callback({ result: true, data: room.attendance_result });
    } catch (e) {
      console.error("[ERROR] in 'attendance_override':", e);
      if (e instanceof Error) {
        console.error(e.stack);
      }
      return callback({ result: false, data: e.message });
    }
  });
}

module.exports = lesson_handler;