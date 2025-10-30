
import { pool } from "./db.js";
import { isLoggedIn } from "./account.js";
import { DateTime } from "luxon";

// 활성 클래스 확인
export async function isClassActive(roomId) {
  const query = `
    SELECT 1
    FROM classes
    WHERE class_name = $1
      AND alive = TRUE
    LIMIT 1
  `;
  const result = await pool.query(query, [roomId]);
  return result.rowCount > 0;
}
/**
 * 활성 클래스 UUID 조회
 * @async
 * @param {string} roomName - 클래스 이름 (class_name)
 * @returns {Promise<string|null>} 활성 클래스의 UUID, 없으면 null
 */
export async function getActiveClass(roomName) {
  const query = `
    SELECT class_id
    FROM classes
    WHERE class_name = $1
      AND alive = TRUE
    LIMIT 1
  `;
  const result = await pool.query(query, [roomName]);
  return result.rowCount > 0 ? result.rows[0].class_id : null;
}


export async function createClass(
  roomId,
  context,
  policy = {
    min_part: 0.7,
    max_noappear: 5 * 60 * 1000,
    start_late: 5 * 60 * 1000,
    early_exit: 10 * 60 * 1000,
  }
) {
  if (!isLoggedIn(context)) {
    throw new Error("User not logged in");
  }

  if (context.account_type !== "member") {
    throw new Error("Guests are not allowed to create classes");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const creator_id = context.account_uuid;

    const classInsert = `
      INSERT INTO classes (
        class_name, alive, creator_id,
        min_part, max_noappear, start_late, early_exit
      )
      VALUES ($1, TRUE, $2, $3, $4, $5, $6)
      RETURNING class_id, class_name, alive, creator_id,
                min_part, max_noappear, start_late, early_exit
    `;
    const classRes = await client.query(classInsert, [
      roomId,
      creator_id,
      policy.min_part,
      policy.max_noappear,
      policy.start_late,
      policy.early_exit,
    ]);

    await client.query("COMMIT");

    return {
      ...classRes.rows[0],
      creator: context.logon_id, // 사람이 로그인에 사용한 ID
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
/**
 * 클래스 정보 수정
 * @async
 * @param {string} class_id - 수정할 클래스 UUID
 * @param {object} updates - 수정할 값들 (class_name, min_part, max_noappear, start_late, early_exit 등)
 * @param {object} context - 로그인 사용자 컨텍스트
 * @returns {Promise<object|null>} 수정된 클래스 정보 (없으면 null)
 */
export async function editClass(class_id, updates, context) {
  if (!isLoggedIn(context)) {
    throw new Error("User not logged in");
  }
  if (context.account_type !== "member") {
    throw new Error("Guests are not allowed to edit classes");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 권한 확인 (해당 클래스 생성자인지 확인)
    const checkRes = await client.query(
      `SELECT creator_id FROM classes WHERE class_id = $1`,
      [class_id]
    );
    if (checkRes.rowCount === 0) {
      throw new Error("Class not found");
    }
    if (checkRes.rows[0].creator_id !== context.account_uuid) {
      throw new Error("Permission denied: not the creator of this class");
    }

    // 업데이트 가능한 필드만 적용
    const allowedFields = ["class_name", "min_part", "max_noappear", "start_late", "early_exit", "alive"];
    const keys = Object.keys(updates).filter(k => allowedFields.includes(k));
    if (keys.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const values = keys.map(k => updates[k]);

    const updateQuery = `
      UPDATE classes
      SET ${setClause}
      WHERE class_id = $1
      RETURNING class_id, class_name, alive, creator_id,
                min_part, max_noappear, start_late, early_exit
    `;
    const updateRes = await client.query(updateQuery, [class_id, ...values]);

    await client.query("COMMIT");
    return updateRes.rows[0] || null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 클래스 삭제
 * @async
 * @param {string} class_id - 삭제할 클래스 UUID
 * @param {object} context - 로그인 사용자 컨텍스트
 * @param {boolean} [hard=false] - true이면 DB에서 완전 삭제(hard), false이면 soft delete
 * @returns {Promise<boolean>} 삭제 성공 여부
 */
export async function deleteClass(class_id, context, hard = false) {
  if (!isLoggedIn(context)) {
    throw new Error("User not logged in");
  }
  if (context.account_type !== "member") {
    throw new Error("Guests are not allowed to delete classes");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 권한 확인
    const checkRes = await client.query(
      `SELECT creator_id FROM classes WHERE class_id = $1`,
      [class_id]
    );
    if (checkRes.rowCount === 0) {
      throw new Error("Class not found");
    }
    if (checkRes.rows[0].creator_id !== context.account_uuid) {
      throw new Error("Permission denied: not the creator of this class");
    }

    let result;
    if (hard) {
      // 하드 삭제 → FK 제약 조건이 있으므로 CASCADE / SET NULL 여부 확인 필요
      result = await client.query(
        `DELETE FROM classes WHERE class_id = $1`,
        [class_id]
      );
    } else {
      // 소프트 삭제 → alive=false 로 마킹
      result = await client.query(
        `UPDATE classes SET alive = FALSE WHERE class_id = $1`,
        [class_id]
      );
    }

    await client.query("COMMIT");
    return result.rowCount > 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 클래스 목록 조회
 * @async
 * @param {boolean} [includeDead=false] - true이면 alive=false 클래스도 포함
 * @returns {Promise<Array>} 클래스 목록
 */
export async function listClasses(includeDead = false) {
  const query = `
    SELECT class_id, class_name, alive, creator_id,
           min_part, max_noappear, start_late, early_exit
    FROM classes
    ${includeDead ? "" : "WHERE alive = TRUE"}
    ORDER BY class_name
  `;
  const res = await pool.query(query);
  return res.rows;
}



// 요일 매핑 (일요일=0)
const WEEKDAY_INDEX = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};
const INDEX_WEEKDAY = Object.fromEntries(
  Object.entries(WEEKDAY_INDEX).map(([k, v]) => [v, k])
);


/**
 * "SUN" + "09:30" -> 주 분 단위 변환
 */
export function toWeekMinutes(weekday, time) {
  const dayIndex = WEEKDAY_INDEX[weekday.toUpperCase()];
  if (dayIndex === undefined) throw new Error(`Invalid weekday: ${weekday}`);
  const [hh, mm] = time.split(':').map(Number);
  return dayIndex * 1440 + (hh * 60 + mm);
}

/**
 * 요일+시간 구간을 분 단위 [start, end] 로 변환
 */
export function toWeekInterval(startWeekday, startTime, endWeekday, endTime) {
  const start = toWeekMinutes(startWeekday, startTime);
  let end = toWeekMinutes(endWeekday, endTime);
  if (end <= start) end += 10080; // 주 경계 넘어감
  return [start, end];
}

/**
 * 분 단위 -> { weekday, time } 변환
 */
export function fromWeekMinutes(weekMinutes) {
  const norm = weekMinutes % 10080; // 주 반복 고려
  const dayIndex = Math.floor(norm / 1440);
  const minutesInDay = norm % 1440;
  const hh = Math.floor(minutesInDay / 60);
  const mm = minutesInDay % 60;
  return {
    weekday: INDEX_WEEKDAY[dayIndex],
    time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
  };
}


// 보정
function normalizeInterval(start, end) {
  if (end <= start) end += 10080;
  return [start, end];
}

function isOverlap(s1, e1, s2, e2) {
  return s1 < e2 && e1 > s2;
}

async function verifyCreator(classId, account_uuid) {
  const res = await pool.query(
    `SELECT creator_id FROM classes WHERE class_id = $1`,
    [classId]
  );
  if (res.rowCount === 0) {
    throw new Error("Class not found");
  }
  if (res.rows[0].creator_id !== account_uuid) {
    throw new Error("Permission denied: not the class creator");
  }
}

// 1. 추가
export async function addClassTime(classId, context, { startWeekday, startTime, endWeekday, endTime, timezone, early_open_window = 3600000 }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await verifyCreator(classId, context.account_uuid, client);

    const [start, end] = toWeekInterval(startWeekday, startTime, endWeekday, endTime);

    // 겹침 체크
    const existing = await client.query(
      `SELECT week_start, week_end FROM lesson_times WHERE class_id = $1`,
      [classId]
    );
    for (const row of existing.rows) {
      let [es, ee] = normalizeInterval(row.week_start, row.week_end);
      if (isOverlap(start, end, es, ee)) {
        throw new Error("Time overlap detected");
      }
    }

    // 삽입
    const query = `
      INSERT INTO lesson_times (class_id, week_start, week_end, timezone, early_open_window)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const res = await client.query(query, [classId, start, end, timezone, early_open_window]);

    await client.query("COMMIT");
    return res.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}


// 2. 삭제
export async function deleteClassTime(lesson_time_id, context) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // lesson_time_id → class_id
    const res = await client.query(
      `SELECT class_id FROM lesson_times WHERE lesson_time_id = $1`,
      [lesson_time_id]
    );
    if (res.rowCount === 0) throw new Error("Lesson time not found");
    const { class_id } = res.rows[0];

    await verifyCreator(class_id, context.account_uuid, client);

    const delRes = await client.query(
      `DELETE FROM lesson_times WHERE lesson_time_id = $1 RETURNING lesson_time_id`,
      [lesson_time_id]
    );

    await client.query("COMMIT");
    return delRes.rowCount > 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}


// 3. 수정
export async function editClassTime(lesson_time_id, context, { startWeekday, startTime, endWeekday, endTime, ...fields }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cur = await client.query(
      `SELECT class_id, week_start, week_end FROM lesson_times WHERE lesson_time_id = $1`,
      [lesson_time_id]
    );
    if (cur.rowCount === 0) throw new Error("Lesson time not found");
    const { class_id } = cur.rows[0];

    await verifyCreator(class_id, context.account_uuid, client);

    let start = startWeekday && startTime ? toWeekMinutes(startWeekday, startTime) : cur.rows[0].week_start;
    let end   = endWeekday && endTime ? toWeekMinutes(endWeekday, endTime) : cur.rows[0].week_end;
    [start, end] = normalizeInterval(start, end);

    // 겹침 체크
    const existing = await client.query(
      `SELECT week_start, week_end FROM lesson_times WHERE class_id = $1 AND lesson_time_id <> $2`,
      [class_id, lesson_time_id]
    );
    for (const row of existing.rows) {
      let [es, ee] = normalizeInterval(row.week_start, row.week_end);
      if (isOverlap(start, end, es, ee)) {
        throw new Error("Time overlap detected");
      }
    }

    // 업데이트
    const updates = { ...fields, week_start: start, week_end: end };
    const keys = Object.keys(updates);
    const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const values = Object.values(updates);

    const query = `
      UPDATE lesson_times
      SET ${setClause}
      WHERE lesson_time_id = $1
      RETURNING *
    `;
    const res = await client.query(query, [lesson_time_id, ...values]);

    await client.query("COMMIT");
    return res.rows[0] || null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}


/**
 * 특정 클래스의 수업 시간 목록 조회 (디버깅 로그 추가)
 */
export async function listClassTime(classId) {
  console.log(`[listClassTime] >>> START (${classId})`);

  const res = await pool.query(
    `SELECT lesson_time_id, week_start, week_end, timezone, early_open_window
     FROM lesson_times WHERE class_id = $1 ORDER BY week_start`,
    [classId]
  );

  console.log(`[listClassTime] DB rows (${res.rowCount}개):`);
  for (const row of res.rows) {
    console.log(
      `  - lesson_time_id=${row.lesson_time_id}, week_start=${row.week_start}, week_end=${row.week_end}, tz=${row.timezone}, early_open_window=${row.early_open_window}`
    );
  }

  const mapped = res.rows.map(row => {
    const start = fromWeekMinutes(row.week_start);
    const end = fromWeekMinutes(row.week_end);

    console.log(
      `[listClassTime] 변환결과: ${start.weekday} ${start.time} ~ ${end.weekday} ${end.time} (${row.timezone || '기본'})`
    );

    return {
      lesson_time_id: row.lesson_time_id,
      timezone: row.timezone,
      early_open_window: row.early_open_window,
      week_start: row.week_start,
      week_end: row.week_end,
      start,
      end,
    };
  });

  console.log(`[listClassTime] <<< END (${classId})`);
  return mapped;
}


/**
 * class_name 기준으로 class_id 찾은 후, ClassInfoById 호출
 */
export async function ClassInfo(roomName) {
  const client = await pool.connect();
  try {
    // 1️⃣ class_id, creator 조회
    const res = await client.query(
      `SELECT class_id FROM classes WHERE class_name = $1`,
      [roomName]
    );

    if (res.rowCount === 0) throw new Error(`Class not found: ${roomName}`);

    const { class_id } = res.rows[0];

    // 2️⃣ 일관성 보장을 위해 ClassInfoById 재사용
    return await ClassInfoById(class_id);
  } finally {
    client.release();
  }
}

/**
 * 특정 class_id로 수업 정보 조회 (디버깅 로그 포함)
 * @param {string} classId - 클래스 UUID
 * @returns {Promise<object>} 수업 일정 및 상태 정보
 */
export async function ClassInfoById(classId) {
  const client = await pool.connect();
  try {
    console.log(`\n========== [ClassInfoById] START (${classId}) ==========`);

    // 1️⃣ 클래스 기본 정보 조회
    const res = await client.query(
      `SELECT class_id, class_name, creator_id FROM classes WHERE class_id = $1`,
      [classId]
    );

    if (res.rowCount === 0) throw new Error("Class not found");

    const { class_id, class_name, creator_id } = res.rows[0];
    console.log(`[ClassInfoById] class_name=${class_name}, creator=${creator_id}`);

    // 2️⃣ 수업 시간 목록 조회
    const lessonTimes = await listClassTime(class_id);
    console.log(`[ClassInfoById] 수업 시간 ${lessonTimes.length}개 로드됨.`);

    if (lessonTimes.length === 0) {
      console.warn(`[ClassInfoById] ⚠️ 등록된 수업 시간이 없습니다.`);
      return {
        class_id,
        class_name,
        creator: creator_id,
        lesson_start: null,
        lesson_end: null,
        tooEarly: false,
        early_open_time: null,
      };
    }

    // 3️⃣ 현재 시각 (KST)
    const now = DateTime.now().setZone("Asia/Seoul");
    console.log(`[Time] now (KST): ${now.toISO()}`);

    let closest = null;

    // 4️⃣ 각 수업 시간 반복
    for (const lt of lessonTimes) {
      const tz = lt.timezone || "Asia/Seoul";
      const localNow = now.setZone(tz);
      const weekStart = localNow.startOf("week").minus({ days: 1 }); // 일요일 기준 보정

      let start = weekStart.plus({ minutes: lt.week_start });
      let end = weekStart.plus({ minutes: lt.week_end });

      // --- ✅ 진행 중인 수업 체크 ---
      const isOngoing = start <= localNow && localNow <= end;

      if (isOngoing) {
        console.log(`  ⚡ 진행 중인 수업 감지: ${start.toISO()} ~ ${end.toISO()}`);
      } else if (end < localNow) {
        // 이미 끝난 수업은 다음 주로 이동
        start = start.plus({ weeks: 1 });
        end = end.plus({ weeks: 1 });
      }

      const early = start.minus({ minutes: lt.early_open_window });

      if (!closest || start < closest.start) {
        closest = { start, end, early, tz };
      }
    }

    // 5️⃣ 모든 수업이 과거인 경우 (예외)
    if (!closest) {
      console.warn(`[ClassInfoById] 모든 수업이 과거로 계산됨. 다음 주 첫 수업 강제 지정.`);
      const lt = lessonTimes[0];
      const tz = lt.timezone || "Asia/Seoul";
      const base = now.setZone(tz).startOf("week").set({ weekday: 1 }).plus({ weeks: 1 });
      const start = base.plus({ minutes: lt.week_start });
      const end = base.plus({ minutes: lt.week_end });
      const early = start.minus({ minutes: lt.early_open_window });
      closest = { start, end, early, tz };
    }

    const tooEarly = now < closest.early;

    // 6️⃣ 결과 출력
    console.log("\n[Result]");
    console.log(`  class: ${class_name}`);
    console.log(`  lesson_start: ${closest.start.toISO()} (${closest.start.toUTC().toMillis()})`);
    console.log(`  lesson_end:   ${closest.end.toISO()} (${closest.end.toUTC().toMillis()})`);
    console.log(`  early_open:   ${closest.early.toISO()} (${closest.early.toUTC().toMillis()})`);
    console.log(`  tooEarly:     ${tooEarly}`);
    console.log(`========== [ClassInfoById] END (${classId}) ==========\n`);

    // 7️⃣ 반환
    return {
      class_id,
      class_name,
      creator: creator_id,
      lesson_start: closest.start.toUTC().toMillis(),
      lesson_end: closest.end.toUTC().toMillis(),
      tooEarly,
      early_open_time: closest.early.toUTC().toMillis(),
    };
  } catch (err) {
    console.error(`[ClassInfoById] ❌ ERROR:`, err);
    throw err;
  } finally {
    client.release();
  }
}

export function class_handler(io, socket, rooms, context) {
  //
  // 🔹 클래스 관련 이벤트
  //
  socket.on("create_class", async (data, callback) => {
    try {
      if (!isLoggedIn(context)) {
        return callback({ result: false, data: "log on required" });
      }
      const classId = data["classId"];
      if (!classId) {
        return callback({ result: false, data: "classId is required" });
      }
      if (rooms.hasOwnProperty(classId) || await isClassActive(classId)) {
        return callback({ result: false, data: "class already exists" });
      }

      const policy = data["policy"];
      const created = await createClass(classId, context, policy);
      console.log(`[create_class] reserved ${classId}`);

      io.emit("class_updated", {
        classId: created.class_id,
        action: "create",
        data: created
      });

      callback({ result: true, data: created });
    } catch (e) {
      console.error(`[ERROR] in 'create_class' handler:`, e);
      callback({ result: false, data: e.message });
    }
  });

  socket.on("edit_class", async (data, callback) => {
    try {
      if (!isLoggedIn(context)) {
        return callback({ result: false, data: "log on required" });
      }
      const classId = data["classId"];
      if (!classId) {
        return callback({ result: false, data: "classId is required" });
      }
      const updates = data["updates"] || {};
      const updated = await editClass(classId, updates, context);
      console.log(`[edit_class] updated ${classId}`);

      io.emit("class_updated", {
        classId: updated.class_id,
        action: "edit",
        data: updated
      });

      callback({ result: true, data: updated });
    } catch (e) {
      console.error(`[ERROR] in 'edit_class' handler:`, e);
      callback({ result: false, data: e.message });
    }
  });

  socket.on("delete_class", async (data, callback) => {
    try {
      if (!isLoggedIn(context)) {
        return callback({ result: false, data: "log on required" });
      }
      const classId = data["classId"];
      if (!classId) {
        return callback({ result: false, data: "classId is required" });
      }
      const hard = data["hard"] || false;
      const deleted = await deleteClass(classId, context, hard);
      console.log(`[delete_class] deleted ${classId}`);

      io.emit("class_updated", {
        classId,
        action: "delete",
        data: { deleted }
      });

      callback({ result: true, data: deleted });
    } catch (e) {
      console.error(`[ERROR] in 'delete_class' handler:`, e);
      callback({ result: false, data: e.message });
    }
  });

  socket.on("class_info", async (data, callback) => {
    try {
      const roomName = data["roomName"];
      if (!roomName) {
        return callback({ result: false, data: "roomName is required" });
      }
      const info = await ClassInfo(roomName);
      callback({ result: true, data: info });
    } catch (e) {
      console.error(`[ERROR] in 'class_info' handler:`, e);
      callback({ result: false, data: e.message });
    }
  });

  socket.on("list_classes", async (data, callback) => {
    try {
      const includeDead = data?.includeDead || false;
      var classes = await listClasses(includeDead);
      classes = classes.filter(c => {
        console.log(`class ${c.creator_id}, context.account_uuid=${context.account_uuid}`);
        return c.creator_id === context.account_uuid
      })
      callback({ result: true, data: classes });
    } catch (e) {
      console.error(`[ERROR] in 'list_classes' handler:`, e);
      callback({ result: false, data: e.message });
    }
  });

  //
  // 🔹 수업 시간(lesson_time) 관련 이벤트
  //
  socket.on("add_class_time", async (data, callback) => {
    try {
      if (!isLoggedIn(context)) {
        return callback({ result: false, data: "log on required" });
      }
      const classId = data["classId"];
      if (!classId) {
        return callback({ result: false, data: "classId is required" });
      }

      const newTime = await addClassTime(classId, context, {
        startWeekday: data.startWeekday,
        startTime: data.startTime,
        endWeekday: data.endWeekday,
        endTime: data.endTime,
        timezone: data.timezone,
        early_open_window: data.early_open_window,
      });
      const full = {
        ...newTime,
        start: fromWeekMinutes(newTime.week_start),
        end: fromWeekMinutes(newTime.week_end),
      }
      console.log(`[add_class_time] for class ${classId}`);

      io.emit("class_time_updated", {
        lessonTimeId: newTime.lesson_time_id,
        action: "create",
        data: full
      });

      callback({ result: true, data: newTime });
    } catch (e) {
      console.error(`[ERROR] in 'add_class_time' handler:`, e);
      callback({ result: false, data: e.message });
    }
  });

  socket.on("edit_class_time", async (data, callback) => {
    try {
      if (!isLoggedIn(context)) {
        return callback({ result: false, data: "log on required" });
      }
      const lessonTimeId = data["lesson_time_id"];
      if (!lessonTimeId) {
        return callback({ result: false, data: "lesson_time_id is required" });
      }

      const updated = await editClassTime(lessonTimeId, context, data.updates || {});
      console.log(`[edit_class_time] ${lessonTimeId}`);
      const decorated = {
        ...updated,
        start: fromWeekMinutes(updated.week_start),
        end: fromWeekMinutes(updated.week_end),
      };
      io.emit("class_time_updated", {
        lessonTimeId,
        action: "edit",
        data: decorated
      });

      callback({ result: true, data: updated });
    } catch (e) {
      console.error(`[ERROR] in 'edit_class_time' handler:`, e);
      callback({ result: false, data: e.message });
    }
  });

  socket.on("delete_class_time", async (data, callback) => {
    try {
      if (!isLoggedIn(context)) {
        return callback({ result: false, data: "log on required" });
      }
      const lessonTimeId = data["lesson_time_id"];
      if (!lessonTimeId) {
        return callback({ result: false, data: "lesson_time_id is required" });
      }

      const res = await deleteClassTime(lessonTimeId, context);
      console.log(`[delete_class_time] ${res}`);

      if (res) {
        io.emit("class_time_updated", {
          lessonTimeId,
          action: "delete",
          data: { deleted: true }
        });
      }

      callback({ result: true, data: {lessonTimeId} });
    } catch (e) {
      console.error(`[ERROR] in 'delete_class_time' handler:`, e);
      callback({ result: false, data: e.message });
    }
  });

  socket.on("list_class_time", async (data, callback) => {
    try {
      const classId = data["classId"];
      console.log(`list_class_time called for data: ${data}`);
      if (!classId) {
        return callback({ result: false, data: "classId is required" });
      }
      const times = await listClassTime(classId);
      callback({ result: true, data: times });
    } catch (e) {
      console.error(`[ERROR] in 'list_class_time' handler:`, e);
      callback({ result: false, data: e.message });
    }
  });
}
