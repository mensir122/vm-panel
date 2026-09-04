// lib/schema.js — DDL per database (9 DB SQLite) sesuai docs/DESIGN.md §5.3
// Setiap DB diawali schema_migrations + meta, meta diinisialisasi backupset_epoch=1.
// Tidak ada FK lintas-DB (SQLite tidak mendukung; lihat §5.4) — hanya FK intra-DB.

const BASE_STATEMENTS = [
  {
    name: 'create_schema_migrations',
    sql: `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT,
  applied_at TEXT
)`,
  },
  {
    name: 'create_meta',
    sql: `CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  },
  {
    name: 'init_meta_backupset_epoch',
    sql: `INSERT INTO meta (key, value, updated_at)
  SELECT 'backupset_epoch', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'backupset_epoch')`,
  },
];

const PLATFORM = [
  ...BASE_STATEMENTS,
  {
    name: 'create_runner_state',
    sql: `CREATE TABLE IF NOT EXISTS runner_state (
  id TEXT PRIMARY KEY,
  phase TEXT,
  started_at TEXT,
  expires_at TEXT,
  self_chain_pid TEXT,
  chain_depth INTEGER,
  watchdog_seen TEXT
)`,
  },
  {
    name: 'create_storage_stats',
    sql: `CREATE TABLE IF NOT EXISTS storage_stats (
  id INTEGER PRIMARY KEY,
  total_bytes INTEGER,
  used_bytes INTEGER,
  free_bytes INTEGER,
  est_full_at TEXT,
  captured_at TEXT
)`,
  },
];

const PROJECTS = [
  ...BASE_STATEMENTS,
  {
    name: 'create_projects',
    sql: `CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE,
  type TEXT,
  status TEXT,
  repo_url TEXT,
  repo_owner TEXT,
  repo_name TEXT,
  branch TEXT,
  revision TEXT,
  workspace_path TEXT,
  runtime_path TEXT,
  start_cmd TEXT,
  stop_cmd TEXT,
  restart_cmd TEXT,
  health_cmd TEXT,
  health_url TEXT,
  port INTEGER,
  env_ref TEXT,
  secret_ref TEXT,
  pid_file TEXT,
  log_file TEXT,
  resource_limits TEXT,
  restart_policy TEXT,
  deployment_policy TEXT,
  backup_policy TEXT,
  last_deployment_id TEXT,
  last_health_at TEXT,
  last_recovery_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  archived_at TEXT
)`,
  },
  {
    name: 'create_project_env_refs',
    sql: `CREATE TABLE IF NOT EXISTS project_env_refs (
  project_id TEXT NOT NULL,
  env_name TEXT NOT NULL,
  secret_ref TEXT,
  PRIMARY KEY (project_id, env_name)
)`,
  },
  {
    name: 'create_workspaces',
    sql: `CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT UNIQUE,
  path TEXT,
  created_at TEXT
)`,
  },
  {
    name: 'idx_project_env_refs_project',
    sql: `CREATE INDEX IF NOT EXISTS idx_project_env_refs_project ON project_env_refs (project_id)`,
  },
];

const SERVICES = [
  ...BASE_STATEMENTS,
  {
    name: 'create_services',
    sql: `CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  name TEXT,
  status TEXT,
  pid INTEGER,
  port INTEGER,
  enabled INTEGER,
  restart_count INTEGER,
  last_exit_code INTEGER,
  started_at TEXT,
  updated_at TEXT
)`,
  },
  {
    name: 'create_service_supervisor_state',
    sql: `CREATE TABLE IF NOT EXISTS service_supervisor_state (
  service_id TEXT PRIMARY KEY,
  state TEXT,
  restart_count INTEGER,
  backoff_until TEXT,
  crash_loop INTEGER,
  consecutive_failures INTEGER,
  last_event TEXT,
  updated_at TEXT
)`,
  },
  {
    name: 'create_deployment_queue',
    sql: `CREATE TABLE IF NOT EXISTS deployment_queue (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  job_type TEXT,
  payload TEXT,
  status TEXT,
  worker TEXT,
  enqueued_at TEXT,
  started_at TEXT,
  finished_at TEXT
)`,
  },
  {
    name: 'create_ports',
    sql: `CREATE TABLE IF NOT EXISTS ports (
  port INTEGER PRIMARY KEY,
  service_id TEXT,
  bound_host TEXT,
  bound_at TEXT
)`,
  },
  {
    name: 'idx_services_project',
    sql: `CREATE INDEX IF NOT EXISTS idx_services_project ON services (project_id)`,
  },
  {
    name: 'idx_deployment_queue_status',
    sql: `CREATE INDEX IF NOT EXISTS idx_deployment_queue_status ON deployment_queue (status)`,
  },
];

const DEPLOYMENTS = [
  ...BASE_STATEMENTS,
  {
    name: 'create_deployments',
    sql: `CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  revision TEXT,
  actor TEXT,
  status TEXT,
  stage TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  rollback_of TEXT
)`,
  },
  {
    name: 'create_deployment_events',
    sql: `CREATE TABLE IF NOT EXISTS deployment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id TEXT,
  stage TEXT,
  status TEXT,
  detail TEXT,
  at TEXT
)`,
  },
  {
    name: 'create_revisions',
    sql: `CREATE TABLE IF NOT EXISTS revisions (
  project_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  source TEXT,
  marker TEXT,
  at TEXT,
  PRIMARY KEY (project_id, revision)
)`,
  },
  {
    name: 'idx_deployments_project',
    sql: `CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments (project_id)`,
  },
  {
    name: 'idx_deployment_events_deployment',
    sql: `CREATE INDEX IF NOT EXISTS idx_deployment_events_deployment ON deployment_events (deployment_id)`,
  },
];

const HEALTH = [
  ...BASE_STATEMENTS,
  {
    name: 'create_health_checks',
    sql: `CREATE TABLE IF NOT EXISTS health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  service_id TEXT,
  check_type TEXT,
  at TEXT,
  latency_ms INTEGER,
  result TEXT,
  status TEXT,
  error TEXT,
  consecutive_failures INTEGER,
  recovery_action TEXT
)`,
  },
  {
    name: 'create_health_state',
    sql: `CREATE TABLE IF NOT EXISTS health_state (
  service_id TEXT PRIMARY KEY,
  status TEXT,
  last_check_at TEXT,
  last_healthy_at TEXT,
  consecutive_failures INTEGER
)`,
  },
  {
    name: 'create_alerts',
    sql: `CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  level TEXT,
  code TEXT,
  message TEXT,
  at TEXT,
  resolved_at TEXT
)`,
  },
  {
    name: 'idx_health_checks_service_at',
    sql: `CREATE INDEX IF NOT EXISTS idx_health_checks_service_at ON health_checks (service_id, at)`,
  },
];

const BACKUPS = [
  ...BASE_STATEMENTS,
  {
    name: 'create_backups',
    sql: `CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  at TEXT,
  trigger TEXT,
  file_path TEXT,
  file_size INTEGER,
  sha256 TEXT,
  db_status TEXT,
  upload_status TEXT,
  verification_status TEXT,
  retention_class TEXT,
  runner_id TEXT,
  error TEXT
)`,
  },
  {
    name: 'create_backup_items',
    sql: `CREATE TABLE IF NOT EXISTS backup_items (
  backup_id TEXT,
  path TEXT,
  size INTEGER,
  sha256 TEXT
)`,
  },
  {
    name: 'create_retention_runs',
    sql: `CREATE TABLE IF NOT EXISTS retention_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT,
  class TEXT,
  deleted_count INTEGER,
  kept_count INTEGER,
  detail TEXT
)`,
  },
  {
    name: 'idx_backups_project',
    sql: `CREATE INDEX IF NOT EXISTS idx_backups_project ON backups (project_id)`,
  },
  {
    name: 'idx_backup_items_backup',
    sql: `CREATE INDEX IF NOT EXISTS idx_backup_items_backup ON backup_items (backup_id)`,
  },
];

const AUDIT = [
  ...BASE_STATEMENTS,
  {
    name: 'create_audit_events',
    sql: `CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT,
  actor TEXT,
  user_id TEXT,
  role TEXT,
  project_id TEXT,
  service_id TEXT,
  operation TEXT,
  input_json TEXT,
  status_before TEXT,
  status_after TEXT,
  revision_before TEXT,
  revision_after TEXT,
  pid_old TEXT,
  pid_new TEXT,
  port INTEGER,
  backup_id TEXT,
  deployment_id TEXT,
  runner_id TEXT,
  recovery_action TEXT,
  error TEXT,
  result TEXT
)`,
  },
  {
    name: 'trigger_audit_no_delete',
    sql: `CREATE TRIGGER IF NOT EXISTS no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only (no delete)');
END`,
  },
  {
    name: 'trigger_audit_no_update',
    sql: `CREATE TRIGGER IF NOT EXISTS no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only (no update)');
END`,
  },
  {
    name: 'idx_audit_events_at',
    sql: `CREATE INDEX IF NOT EXISTS idx_audit_events_at ON audit_events (at)`,
  },
  {
    name: 'idx_audit_events_project',
    sql: `CREATE INDEX IF NOT EXISTS idx_audit_events_project ON audit_events (project_id)`,
  },
];

const USERS = [
  ...BASE_STATEMENTS,
  {
    name: 'create_users',
    sql: `CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  password_hash TEXT,
  role TEXT,
  totp_secret TEXT,
  status TEXT,
  failed_attempts INTEGER,
  locked_until TEXT,
  created_at TEXT,
  last_login_at TEXT
)`,
  },
  {
    name: 'create_sessions',
    sql: `CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  created_at TEXT,
  expires_at TEXT,
  csrf_token TEXT,
  revoked INTEGER
)`,
  },
  {
    name: 'create_recovery_codes',
    sql: `CREATE TABLE IF NOT EXISTS recovery_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  code_hash TEXT,
  used_at TEXT
)`,
  },
  {
    name: 'idx_sessions_user',
    sql: `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,
  },
  {
    name: 'idx_recovery_codes_user',
    sql: `CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes (user_id)`,
  },
];

const LOCKS = [
  ...BASE_STATEMENTS,
  {
    name: 'create_lock_registry',
    sql: `CREATE TABLE IF NOT EXISTS lock_registry (
  name TEXT PRIMARY KEY,
  holder TEXT,
  acquired_at TEXT,
  expires_at TEXT,
  meta TEXT
)`,
  },
  {
    name: 'create_lock_events',
    sql: `CREATE TABLE IF NOT EXISTS lock_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lock_name TEXT,
  event TEXT,
  holder TEXT,
  at TEXT,
  detail TEXT
)`,
  },
  {
    name: 'idx_lock_events_name_at',
    sql: `CREATE INDEX IF NOT EXISTS idx_lock_events_name_at ON lock_events (lock_name, at)`,
  },
];

/**
 * DDL per database. Urutan statement di dalam tiap DB = urutan migrasi
 * (versi = index + 1). Semua statement idempotent (IF NOT EXISTS /
 * WHERE NOT EXISTS) sehingga migrate() boleh dipanggil berulang.
 */
export const SCHEMAS = {
  platform: PLATFORM,
  projects: PROJECTS,
  services: SERVICES,
  deployments: DEPLOYMENTS,
  health: HEALTH,
  backups: BACKUPS,
  audit: AUDIT,
  users: USERS,
  locks: LOCKS,
};

export const SCHEMA_NAMES = Object.keys(SCHEMAS);
