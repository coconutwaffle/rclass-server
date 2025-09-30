import bcrypt from "bcrypt";
import { pool } from "./db.js";

/**
 * 새 회원 계정 생성
 * @async
 * @param {string} account_id - 로그인 아이디 (중복 불가)
 * @param {string} name - 표시 이름
 * @param {string} pwd - 평문 비밀번호
 * @returns {Promise<{ account_uuid: string, account_id: string, name: string, account_type: string }>}
 * @throws {Error} account_id 중복 또는 DB 에러
 */
export async function create_account(account_id, name, pwd) {
  if (!account_id || !name || !pwd) {
    throw new Error("create_account: account_id, name, pwd are required");
  }

  // 비밀번호 해시
  const hash = await bcrypt.hash(pwd, 10);

  const query = `
    INSERT INTO account (account_id, name, pwd, account_type)
    VALUES ($1, $2, $3, 'member')
    RETURNING id as account_uuid, account_id, name, account_type
  `;

  try {
    const result = await pool.query(query, [account_id, name, hash]);
    return result.rows[0];
  } catch (err) {
    if (err.code === "23505") { // unique violation
      throw new Error("account_id already exists");
    }
    throw err;
  }
}

/**
 * 게스트 계정 생성
 * @param {string} name - 게스트 이름
 * @returns {object} 생성된 게스트 정보 (valid, account_uuid, account_id, name, account_type)
 */
export async function guestLogin(name, context) {
  const query = `
    INSERT INTO account (account_id, name, pwd, account_type)
    VALUES (NULL, $1, NULL, 'guest')
    RETURNING id as account_uuid, account_id, name, account_type
  `;

  const result = await pool.query(query, [name]);
  const row = result.rows[0];
  context.logon_id = row.account_id;
  context.account_uuid = row.account_uuid;
  context.name = row.name;
  context.account_type = row.account_type;
  console.log(`Guest logged in: ${JSON.stringify(context, null, 2)}`);
  return true;
}

/**
 * 회원 로그인
 * @param {string} id - account_id (로그인용 문자열)
 * @param {string} pwd - 입력 비밀번호
 * @param {object} context - 로그인 세션 컨텍스트
 * @returns {Promise<boolean>} 로그인 성공 여부
 */
export async function LogIn(id, pwd, context) {
  const query = `
    SELECT id AS account_uuid, account_id, name, pwd, account_type
    FROM account
    WHERE account_id = $1
      AND account_type = 'member'
    LIMIT 1
  `;

  const result = await pool.query(query, [id]);

  if (result.rowCount === 0) {
    return false; // 계정 없음
  }

  const { account_uuid, account_id, name, pwd: hash, account_type } = result.rows[0];

  // 비밀번호 검증
  const isValid = await bcrypt.compare(pwd, hash);
  if (!isValid) {
    return false;
  }

  // context 채우기
  context.logon_id = account_id;    // 로그인 문자열 ID
  context.account_uuid = account_uuid; // UUID
  context.name = name;
  context.account_type = account_type;

  return true;
}


export function getLogOnId(context)
{
    if(isLoggedIn(context))
    {
        return context.logon_id;
    }
    throw new Error("User is not logged in");
}

export function isLoggedIn(context) {
  return context.account_uuid ? true : false;
}

/**
 * UUID 로 계정 검색
 * @async
 * @param {string} uuid - account 테이블의 id (UUID)
 * @returns {Promise<{ account_uuid: string, account_id: string, name: string, account_type: string } | null>}
 */
export async function getAccountByUUID(uuid) {
  if (!uuid) {
    throw new Error("getAccountByUUID: uuid is required");
  }

  const query = `
    SELECT id AS account_uuid, account_id, name, account_type
    FROM account
    WHERE id = $1
    LIMIT 1
  `;

  try {
    const result = await pool.query(query, [uuid]);
    if (result.rowCount === 0) {
      return null; // 해당 UUID 없음
    }
    return result.rows[0];
  } catch (err) {
    throw err;
  }
}
