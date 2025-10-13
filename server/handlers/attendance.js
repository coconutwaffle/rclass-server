import { pool } from "../db.js";

/**
 * @event get_my_attendance
 * @desc 로그인된 사용자의 참여 수업 및 출결 결과 목록 조회
 * @param {object} data { start?: number, end?: number, offset?: number, limit?: number }
 */
export function attendance_handler(io, socket, rooms, context) {
  socket.on("get_my_attendance", async (data, callback) => {
    try {
      // ✅ 1. 로그인 여부 확인
      if (!context?.account_uuid) {
        return callback({ result: false, data: "log on required" });
      }

      const attendeeId = context.account_uuid;
      const start = Number(data?.start ?? 0);
      const end = Number(data?.end ?? 0);
      const offset = Number(data?.offset ?? 0);
      const limit = Number(data?.limit ?? 20);

      console.log(`[get_my_attendance] user=${attendeeId}, start=${start}, end=${end}, offset=${offset}, limit=${limit}`);

      // ✅ 2. 동적 WHERE 조건 구성
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

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      // ✅ 3. 메인 조회 쿼리
      const query = `
        SELECT 
          r.room_id,
          r.class_id,
          c.class_name,
          r.session_no,
          r.lesson_start,
          r.lesson_end,
          r.status,
          a.log_data
        FROM attendance_logs a
        JOIN rooms r ON a.room_id = r.room_id
        JOIN classes c ON r.class_id = c.class_id
        ${whereSql}
        ORDER BY r.lesson_start DESC
        OFFSET $${idx++} LIMIT $${idx++};
      `;

      params.push(offset, limit);

      // ✅ 4. 전체 개수
      const countQuery = `
        SELECT COUNT(*) AS total
        FROM attendance_logs a
        JOIN rooms r ON a.room_id = r.room_id
        WHERE a.attendee_id = $1;
      `;

      // ✅ 5. DB 실행
      const [listRes, countRes] = await Promise.all([
        pool.query(query, params),
        pool.query(countQuery, [attendeeId]),
      ]);

      const totalCount = Number(countRes.rows[0]?.total ?? 0);

      // ✅ 6. 결과 포맷팅
      const result = {
        offset,
        limit,
        total_count: totalCount,
        records: listRes.rows.map((r) => ({
          room_info: {
            room_id: r.room_id,
            class_id: r.class_id,
            class_name: r.class_name,
            session_no: r.session_no,
            status: r.status,
            lesson_start: r.lesson_start,
            lesson_end: r.lesson_end,
          },
          result: r.log_data, // AttendanceResult 구조 그대로
        })),
      };

      // ✅ 7. 성공 응답
      callback({ result: true, data: result });
    } catch (e) {
      console.error(`[ERROR] in 'get_my_attendance' handler:`, e);
      callback({ result: false, data: e.message });
    }
  });
}
