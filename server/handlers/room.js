import { pool } from "./db.js";
import { create_account, LogIn, isLoggedIn, getLogOnId, guestLogin, getAccountByUUID } from './account.js';
/**
 * DB에 room을 생성하고 UUID를 반환
 * - rooms insert
 * - room_students_snapshot insert (class_id 기준 학생명 복사)
 *
 * @async
 * @param {object} room - 메모리 상의 room 객체
 * @param {object} context - 방 생성자의 context
 * @returns {Promise<string>} - 생성된 room의 UUID (room_id)
 */
export async function store_room(room, context) {
  if (!context?.account_uuid) {
    throw new Error("store_room: creator account_uuid not found in context");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. rooms insert
    const insertQuery = `
      INSERT INTO rooms (
        session_no, creator_id,
        lesson_start, lesson_end,
        class_id, class_name,
        min_part, max_noappear, start_late, early_exit
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING room_id
    `;
    
    const values = [
      room.session_no,                               // session_no (생성 시각 ms)
      context.account_uuid,              // creator_id
      room.lesson_reserved?.st_time ?? null,
      room.lesson_reserved?.end_time ?? null,
      room.class_id ?? null,             // class_id (없을 수 있음)
      room.roomId,                       // class_name snapshot
      room.attendancePolicy.min_part,
      room.attendancePolicy.max_noappear,
      room.attendancePolicy.start_late,
      room.attendancePolicy.ealry_exit,
    ];
    console.log("store_room: inserting into rooms with values:", values);
    console.log("store_room: room object:", room);
    const res = await client.query(insertQuery, values);
    const db_room_id = res.rows[0].room_id;

    // 2. room_students_snapshot insert (class_id 기준)
    if (room.class_id) {
      const studentsRes = await client.query(
        `SELECT student_name
         FROM class_students
         WHERE class_id = $1`,
        [room.class_id]
      );

      for (const row of studentsRes.rows) {
        await client.query(
          `INSERT INTO room_students_snapshot (room_id, student_name)
           VALUES ($1, $2)`,
          [db_room_id, row.student_name]
        );
      }
    }

    await client.query("COMMIT");

    // 메모리 객체에도 반영
    room.db_room_id = db_room_id;

    return db_room_id;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}


/**
 * room 객체의 상태를 DB 스키마에 아카이브
 * - rooms: lesson_start, lesson_end, 출결 정책 업데이트
 * - chat_logs, chat_target: 채팅 기록 저장
 * - attendance_logs: 출결 로그 저장
 * 
 * @async
 * @param {object} room - 메모리 상의 room 객체
 * @returns {Promise<void>}
 * @throws {Error} DB 오류 발생 시
 */
export async function archiveRoomToDB(room) {
  if (!room.db_room_id) {
    throw new Error("archiveRoomToDB: Room has not been stored in DB (call store_room first)");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. rooms 업데이트
    await client.query(
      `UPDATE rooms
       SET lesson_start = $1,
           lesson_end   = $2,
           min_part     = $3,
           max_noappear = $4,
           start_late   = $5,
           early_exit   = $6
       WHERE room_id = $7`,
      [
        room.lesson?.start_time ?? null,
        room.lesson?.end_time ?? null,
        room.attendancePolicy.min_part,
        room.attendancePolicy.max_noappear,
        room.attendancePolicy.start_late,
        room.attendancePolicy.ealry_exit,
        room.db_room_id,
      ]
    );

    // 2. chat_logs + chat_target
    console.log(`Archiving ${room.chat_log.length} chat logs for room ${room.db_room_id}`);
    console.log(`chat_log: ${JSON.stringify(room.chat_log, null, 2)}`);
    for (const chat of room.chat_log) {
      const {
        seq: chat_seq,
        msgId: msg_id,
        ts,
        msg,
        mode,
        from,        // clientId
        send_to = [],// clientId 배열
      } = chat;

      // clientId → uuid 변환
      const from_uuid = room.clientIdToUUID.get(from);
      if (!from_uuid) {
        console.warn(`archiveRoomToDB: no uuid mapping for sender ${from}, skip`);
        continue;
      }

      const chatRes = await client.query(
        `INSERT INTO chat_logs (chat_id, room_id, sender_id, chat_seq, msg_id, ts, msg, mode)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
        RETURNING chat_id`,
        [room.db_room_id, from_uuid, chat_seq, msg_id, ts, msg, mode]
      );
      const chat_id = chatRes.rows[0].chat_id;

      if (mode !== "ALL" && Array.isArray(send_to)) {
        for (const target_cid of send_to) {
          const target_uuid = room.clientIdToUUID.get(target_cid);
          if (!target_uuid) {
            console.warn(`archiveRoomToDB: no uuid mapping for target ${target_cid}, skip`);
            continue;
          }
          await client.query(
            `INSERT INTO chat_target (chat_id, target_id)
            VALUES ($1, $2)`,
            [chat_id, target_uuid]
          );
        }
      }
    }


    // 3. attendance_logs
    console.log(`Archiving attendance logs for room ${room.db_room_id}`);
    console.log(`merged_log: ${JSON.stringify(room.merged_log, null, 2)}`);
    console.log(`attendance_result: ${JSON.stringify(room.attendance_result, null, 2)}`);
    if (room.attendance_result && room.attendance_result.results) {
      const { lesson_start, lesson_end, results } = room.attendance_result;

      for (const [clientId, attResult] of Object.entries(results)) {
        const uuid = room.clientIdToUUID.get(clientId);
        if (!uuid) {
          console.warn(`archiveRoomToDB: no uuid mapping for clientId ${clientId}, skip`);
          continue;
        }

        // JSON 데이터 구성 (detail + per_block 포함)
        const logData = {
          summary: attResult.detail || {},
          per_block: attResult.per_block || [],
          firstAppear_ms: attResult.detail?.firstAppear_ms || 0,
          lastAppear_ms: attResult.detail?.lastAppear_ms || 0,
        };

        const status = attResult.status || 'present';
        const reason = attResult.reason || '';
        const guest = attResult.guest ?? false;

        // ✅ UPSERT 처리 (중복 시 갱신)
        await client.query(
          `
          INSERT INTO attendance_logs (room_id, attendee_id, status, reason, guest, log_data)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (room_id, attendee_id)
          DO UPDATE SET
            status = EXCLUDED.status,
            reason = EXCLUDED.reason,
            guest = EXCLUDED.guest,
            log_data = EXCLUDED.log_data,
            updated_at = NOW()
          `,
          [room.db_room_id, uuid, status, reason, guest, logData]
        );

        console.log(
          `[attendance_logs] Saved ${clientId} (${uuid}) → status=${status}, guest=${guest}`
        );
      }

      console.log(
        `[attendance_logs] Archiving completed for room ${room.db_room_id} (students: ${Object.keys(
          results
        ).length})`
      );
    } else {
      console.warn(`[attendance_logs] No attendance_result found for room ${room.db_room_id}`);
    }


    await client.query("COMMIT");
    console.log(`Room ${room.db_room_id} archived successfully`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`Failed to archive room ${room.db_room_id}:`, err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 방에 속한 모든 학생명(student_name)을 스냅샷에서 가져오기
 *
 * @async
 * @param {object} room - 메모리 room 객체 (db_room_id 필요)
 * @returns {Promise<string[]>} 학생 이름 배열
 */
export async function get_all_students(room) {
  if (!room.db_room_id) {
    throw new Error("get_all_students: room.db_room_id is missing (store_room 먼저 실행 필요)");
  }

  const query = `
    SELECT student_name
    FROM room_students_snapshot
    WHERE room_id = $1
    ORDER BY student_name
  `;

  const result = await pool.query(query, [room.db_room_id]);
  return result.rows.map(r => r.student_name);
}

/**
 * room_attendees 에 참가자 추가
 * @async
 * @param {string} db_room_id - rooms 테이블의 room_id (UUID)
 * @param {string} account_uuid - 참가자 account.id (UUID)
 * @returns {Promise<boolean>} 성공 여부
 */
export async function add_attendees(db_room_id, account_uuid) {
  const query = `
    INSERT INTO room_attendees (room_id, attendee_id)
    VALUES ($1, $2)
    ON CONFLICT DO NOTHING
  `;

  try {
    await pool.query(query, [db_room_id, account_uuid]);
    return true;
  } catch (err) {
    console.error("add_attendees error:", err);
    return false;
  }
}

/**
 * 특정 class_id의 세션(room) 목록 + 상태 조회 (LIMIT / OFFSET 기반)
 * @async
 * @param {string} classId - classes 테이블의 class_id (UUID)
 * @param {number} [limit=20] - 한 번에 가져올 개수
 * @param {number} [offset=0] - 시작 위치
 */
export async function listRoomsByClass(classId, limit = 20, offset = 0) {
  const dataQuery = `
    SELECT
      r.room_id,
      r.session_no,
      r.class_name,
      r.lesson_start,
      r.lesson_end,
      a.name AS creator_name,
      CASE
        WHEN r.lesson_start IS NULL THEN 'waiting'
        WHEN r.lesson_end IS NULL THEN 'ongoing'
        ELSE 'finished'
      END AS status
    FROM rooms r
    JOIN account a ON r.creator_id = a.id
    WHERE r.class_id = $1
    ORDER BY r.lesson_start DESC NULLS LAST, r.session_no DESC
    LIMIT $2 OFFSET $3
  `;

  const countQuery = `SELECT COUNT(*) FROM rooms WHERE class_id = $1`;

  const [dataRes, countRes] = await Promise.all([
    pool.query(dataQuery, [classId, limit, offset]),
    pool.query(countQuery, [classId]),
  ]);

  const total = Number(countRes.rows[0].count);

  return {
    data: dataRes.rows,
    total,
    limit,
    offset,
    start: offset,
    end: offset + dataRes.rows.length - 1
  };
}

/**
 * 특정 room_id의 출결 결과 조회
 * @async
 * @param {string} roomId
 * @returns {Promise<Object>} LessonAttendance 구조
 */
export async function getAttendanceResults(roomId) {
  // 1️⃣ rooms 테이블에서 lesson_start / lesson_end 가져오기
  const roomRes = await pool.query(
    `SELECT lesson_start, lesson_end FROM rooms WHERE room_id = $1`,
    [roomId]
  );
  if (roomRes.rowCount === 0) {
    throw new Error(`Room not found for room_id=${roomId}`);
  }

  const { lesson_start, lesson_end } = roomRes.rows[0];

  // 2️⃣ attendance_logs + account 조인해서 전체 출결 데이터 가져오기
  const logsQuery = `
    SELECT 
      a.id   AS attendee_id,
      a.name AS attendee_name,
      l.status,
      l.reason,
      l.guest,
      l.log_data
    FROM attendance_logs l
    JOIN account a ON l.attendee_id = a.id
    WHERE l.room_id = $1
    ORDER BY a.name;
  `;
  const res = await pool.query(logsQuery, [roomId]);

  // 3️⃣ LessonAttendance 구조 생성
  const results = {};
  for (const row of res.rows) {
    results[row.attendee_id] = {         // ✅ UUID를 key로 사용
      name: row.attendee_name,           // ✅ 표시용 이름 필드 추가
      status: row.status,
      reason: row.reason || "",
      guest: row.guest ?? false,
      detail: row.log_data?.summary ?? {},
      per_block: row.log_data?.per_block ?? [],
    };
  }

  return {
    room_id: roomId,
    lesson_start: Number(lesson_start) || 0,
    lesson_end: Number(lesson_end) || 0,
    results,
  };
}

/**
 * 특정 room_id의 출석자 이름(id) → UUID 매핑 조회
 * @async
 * @param {string} roomId - rooms 테이블의 room_id (UUID)
 * @returns {Promise<Object>} { id_map: { "<학생id>": "<UUID>" }, room_id }
 */
export async function getAttendanceIdMap(roomId) {
  const query = `
    SELECT 
      a.id   AS attendee_id,
      a.name AS attendee_name
    FROM attendance_logs l
    JOIN account a ON l.attendee_id = a.id
    WHERE l.room_id = $1
    ORDER BY a.name;
  `;

  const res = await pool.query(query, [roomId]);

  const id_map = {};
  for (const row of res.rows) {
    id_map[row.attendee_name] = row.attendee_id; // name(id) → uuid
  }

  return {
    room_id: roomId,
    id_map,
  };
}


export function room_handler(io, socket, rooms, context) {
  //
  // 🔹 수업(room) 관련 이벤트
  //
  socket.on("list_rooms_by_class", async (data, callback) => {
    try {
      // ✅ 1. 로그인 확인
      if (!isLoggedIn(context)) {
        return callback({ result: false, data: "log on required" });
      }

      // ✅ 2. 파라미터 검증
      const classId = data?.class_id;
      const limit = Number(data?.limit ?? 20);
      const offset = Number(data?.offset ?? 0);

      if (!classId) {
        return callback({ result: false, data: "class_id is required" });
      }

      // ✅ 3. DB 조회
      const result = await listRoomsByClass(classId, limit, offset);

      // ✅ 4. 성공 응답
      callback({ result: true, data: result });
    } catch (e) {
      console.error(`[ERROR] in 'list_rooms_by_class' handler:`, e);
      callback({ result: false, data: e.message });
    }
  });

  socket.on("get_attendance_results", async (data, callback) => {
    try {
      if (!isLoggedIn(context))
        return callback({ result: false, data: "log on required" });

      const roomId = data?.room_id;
      if (!roomId)
        return callback({ result: false, data: "room_id is required" });

      const results = await getAttendanceResults(roomId);
      callback({ result: true, data: results });
    } catch (e) {
      console.error(`[ERROR] in 'get_attendance_results' handler:`, e);
      callback({ result: false, data: e.message });
    }
  });
}