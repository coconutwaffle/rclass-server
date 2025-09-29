-- ENUM 타입 정의
CREATE TYPE attendance_status AS ENUM ('present','late','absent','early_exit');
CREATE TYPE chat_mode AS ENUM ('ALL','PRIVATE');
CREATE TYPE weekday_enum AS ENUM ('MON','TUE','WED','THU','FRI','SAT','SUN');
CREATE TYPE account_type_enum AS ENUM ('member','guest');

-- account 테이블
CREATE TABLE account (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id VARCHAR(255), -- guest인 경우 NULL 강제
    name TEXT NOT NULL,
    pwd TEXT, -- guest login 시 NULL 가능, hash 저장
    account_type account_type_enum NOT NULL,
    CHECK (
        (account_type = 'guest' AND account_id IS NULL)
        OR (account_type = 'member' AND account_id IS NOT NULL)
    )
);

-- member 계정은 account_id 중복 불가
CREATE UNIQUE INDEX uniq_member_account_id
  ON account(account_id)
  WHERE account_type = 'member';

-- classes 테이블
CREATE TABLE classes (
    class_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_name TEXT NOT NULL,
    alive BOOLEAN NOT NULL DEFAULT FALSE,
    creator_id UUID NOT NULL REFERENCES account(id),
    min_part DOUBLE PRECISION,
    max_noappear BIGINT, -- 밀리초
    start_late BIGINT,   -- 밀리초
    early_exit BIGINT    -- 밀리초
);

-- class_name이 alive 중복 불가 제약 (unique partial index)
CREATE UNIQUE INDEX uniq_alive_class_name
    ON classes(class_name)
    WHERE alive = TRUE;

-- lesson_times 테이블
CREATE TABLE lesson_times (
    lesson_time_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id UUID NOT NULL REFERENCES classes(class_id),
    week_start INT NOT NULL,  -- 주 시작부터 분 단위 (0 ~ 10079)
    week_end   INT NOT NULL,  -- 주 시작부터 분 단위 (end <= start 이면 다음 주로 보정)
    timezone TEXT NOT NULL,
    early_open_window BIGINT NOT NULL DEFAULT 3600000
);

-- class_students 테이블
CREATE TABLE class_students (
    class_id UUID NOT NULL REFERENCES classes(class_id),
    student_name TEXT NOT NULL,
    PRIMARY KEY (class_id, student_name)
);

-- rooms 테이블
CREATE TABLE rooms (
    room_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_no BIGINT NOT NULL,                -- 생성된 시각 (ms 단위 timestamp 등)
    creator_id UUID NOT NULL REFERENCES account(id),
    lesson_start BIGINT NULL,              -- ms
    lesson_end BIGINT NULL,                -- ms
    class_id UUID REFERENCES classes(class_id), -- NULL 허용 (class 없이도 가능)
    class_name TEXT NOT NULL,                  -- snapshot
    min_part DOUBLE PRECISION NOT NULL,        -- snapshot
    max_noappear BIGINT NOT NULL,              -- snapshot
    start_late BIGINT NOT NULL,                -- snapshot
    early_exit BIGINT NOT NULL                 -- snapshot
);

-- room_attendees 테이블
CREATE TABLE room_attendees (
    room_id UUID NOT NULL REFERENCES rooms(room_id),
    attendee_id UUID NOT NULL REFERENCES account(id),
    PRIMARY KEY (room_id, attendee_id)
);

-- room_students_snapshot 테이블
CREATE TABLE room_students_snapshot (
    room_id UUID NOT NULL REFERENCES rooms(room_id),
    student_name TEXT NOT NULL,
    PRIMARY KEY (room_id, student_name)
);

-- attendance_logs 테이블
CREATE TABLE attendance_logs (
    room_id UUID NOT NULL REFERENCES rooms(room_id),
    attendee_id UUID NOT NULL REFERENCES account(id),
    log_data JSONB,
    PRIMARY KEY (room_id, attendee_id)
);

-- chat_logs 테이블
CREATE TABLE chat_logs (
    chat_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES rooms(room_id),
    sender_id UUID NOT NULL REFERENCES account(id),
    chat_seq INT NOT NULL,
    msg_id VARCHAR(225) NOT NULL,
    ts BIGINT NOT NULL,
    msg TEXT NOT NULL,
    mode chat_mode DEFAULT 'ALL'
);

-- chat_target 테이블
CREATE TABLE chat_target (
    chat_id UUID NOT NULL REFERENCES chat_logs(chat_id),
    target_id UUID NOT NULL REFERENCES account(id),
    PRIMARY KEY (chat_id, target_id)
);
