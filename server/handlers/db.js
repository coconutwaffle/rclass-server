import { Pool } from "pg";
import config from '../config.js';

export const pool = new Pool({
  host: config.db_host,
  port: config.db_port,
  user: config.db_user,
  password: config.db_pass,
  database: config.db_name,
});
