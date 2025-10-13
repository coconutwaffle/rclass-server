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
          },
        })),
      };

      callback({ result: true, data: result });
    } catch (e) {
      console.error(`[ERROR] in 'get_my_attendance' handler:`, e);
      callback({ result: false, data: e.message });
    }
  });
}
