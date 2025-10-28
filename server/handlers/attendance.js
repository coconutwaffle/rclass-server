import { pool } from "./db.js";

/**
 * @event get_my_attendance
 * @desc 로그인된 사용자의 참여 수업 및 출결 결과 목록 조회
 * @param {object} data { start?: number, end?: number, limit?: number }
 */
export function attendance_handler(io, socket, rooms, context) {
  socket.on("get_my_attendance", async (data, callback) => {
    try {
      if (!context?.account_uuid)
        return callback({ result: false, data: "log on required" });

      const attendeeId = context.account_uuid;
      const start = Number(data?.start ?? 0);
      const end = Number(data?.end ?? 0);
      const limit = Number(data?.limit ?? 20);

      console.log(
        `[get_my_attendance] user=${attendeeId}, start=${start}, end=${end}, limit=${limit}`
      );

      const where = ["a.attendee_id = $1"];
      const params = [attendeeId];
      let idx = 2;

      if (start > 0) {
        where.push(`r.lesson_start >= $${idx++}`);
        params.push(start);
      }
      if (end > 0) {
        where.push(`r.lesson_end <= $${idx++}`);
        params.push(end);
      }

      const whereSql = `WHERE ${where.join(" AND ")}`;

      // ✅ status → a.status 로 변경, reason/guest 추가
      const query = `
        SELECT 
          r.room_id,
          r.class_id,
          c.class_name,
          acc.name AS creator_name, 
          r.session_no,
          r.lesson_start,
          r.lesson_end,
          a.status,
          a.reason,
          a.guest,
          a.log_data
        FROM attendance_logs a
        JOIN rooms r ON a.room_id = r.room_id
        JOIN classes c ON r.class_id = c.class_id
        JOIN account acc ON r.creator_id = acc.id
        ${whereSql}
        ORDER BY r.lesson_start DESC
        LIMIT $${idx++};
      `;

      params.push(limit);

      const countQuery = `
        SELECT COUNT(*) AS total
        FROM attendance_logs a
        JOIN rooms r ON a.room_id = r.room_id
        WHERE a.attendee_id = $1;
      `;

      const [listRes, countRes] = await Promise.all([
        pool.query(query, params),
        pool.query(countQuery, [attendeeId]),
      ]);

      const totalCount = Number(countRes.rows[0]?.total ?? 0);

      const result = {
        limit,
        total_count: totalCount,
        records: listRes.rows.map((r) => ({
          room_info: {
            room_id: r.room_id,
            class_id: r.class_id,
            class_name: r.class_name,
            session_no: r.session_no,
            status: r.status,
            creator_name: r.creator_name,
            lesson_start: r.lesson_start,
            lesson_end: r.lesson_end,
          },
          result: {
            status: r.status,
            reason: r.reason,
            guest: r.guest,  
            detail: r.log_data.summary ?? {},
            per_block: r.log_data.per_block ?? [],
            name: context.logon_id
          },
        })),
      };

      callback({ result: true, data: result });
    } catch (e) {
      console.error(`[ERROR] in 'get_my_attendance' handler:`, e);
      callback({ result: false, data: e.message });
    }
  });

    /**
     * @event update_attendance_result
     * @desc 방(수업)의 출석 결과를 수정한다 (creator 전용)
     * @param {object} data {
     *   room_id: string,
     *   attendee_id: string,
     *   status?: "present"|"late"|"absent"|"early_exit",
     *   reason?: string,
     *   guest?: boolean
     * }
     */
  socket.on("update_attendance_result", async (data, callback) => {
    try {
      // ✅ 1. 로그인 확인
      if (!context?.account_uuid) {
        return callback({ result: false, data: "log on required" });
      }

      const { room_id, attendee_id, status, reason, guest } = data ?? {};

      // ✅ 2. 파라미터 유효성 검증
      if (!room_id || !attendee_id) {
        return callback({ result: false, data: "room_id and attendee_id required" });
      }

      // ✅ 3. 수정 요청자가 해당 room의 creator 인지 확인
      const roomCheck = await pool.query(
        `SELECT creator_id FROM rooms WHERE room_id = $1 LIMIT 1;`,
        [room_id]
      );

      if (roomCheck.rowCount === 0) {
        return callback({ result: false, data: "room not found" });
      }

      const creatorId = roomCheck.rows[0].creator_id;
      if (creatorId !== context.account_uuid) {
        console.warn(
          `[update_attendance_result] Unauthorized attempt by ${context.account_uuid}`
        );
        return callback({ result: false, data: "permission denied (not creator)" });
      }

      // ✅ 4. 기존 출결 레코드 존재 여부 확인
      const existing = await pool.query(
        `SELECT * FROM attendance_logs WHERE room_id = $1 AND attendee_id = $2 LIMIT 1;`,
        [room_id, attendee_id]
      );

      if (existing.rowCount === 0) {
        return callback({ result: false, data: "attendance record not found" });
      }

      // ✅ 5. 업데이트 쿼리 구성
      const updates = [];
      const params = [];
      let idx = 1;

      if (status) {
        updates.push(`status = $${idx++}`);
        params.push(status);
      }
      if (reason !== undefined) {
        updates.push(`reason = $${idx++}`);
        params.push(reason);
      }
      if (guest !== undefined) {
        updates.push(`guest = $${idx++}`);
        params.push(guest);
      }

      if (updates.length === 0) {
        return callback({ result: false, data: "no fields to update" });
      }

      params.push(room_id, attendee_id);

      const updateQuery = `
        UPDATE attendance_logs
        SET ${updates.join(", ")}, updated_at = NOW()
        WHERE room_id = $${idx++} AND attendee_id = $${idx++}
        RETURNING room_id, attendee_id, status, reason, guest, updated_at;
      `;

      const updateRes = await pool.query(updateQuery, params);
      const updated = updateRes.rows[0];

      console.log(`[update_attendance_result] Updated:`, updated);

      // ✅ 6. 성공 응답
      callback({ result: true, data: updated });
    } catch (e) {
      console.error(`[ERROR] in 'update_attendance_result' handler:`, e);
      callback({ result: false, data: e.message });
    }
  });
}