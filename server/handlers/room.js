import { pool } from "./db.js";

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
      room.sesson_no,                               // session_no (생성 시각 ms)
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
    if (room.merged_log) {
      for (const [clientId, logData] of Object.entries(room.merged_log.full_log || {})) {
        // clientId → uuid 매핑
        const uuid = room.clientIdToUUID.get(clientId);
        if (!uuid) {
          console.warn(`archiveRoomToDB: no uuid mapping for clientId ${clientId}, skip`);
          continue;
        }

        await client.query(
          `INSERT INTO attendance_logs (room_id, attendee_id, log_data)
          VALUES ($1, $2, $3)`,
          [room.db_room_id, uuid, logData]
        );
      }
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