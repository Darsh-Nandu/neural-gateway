-- NeuralGateway — Migration 001: Initial Schema
-- Run via: npm run migrate
-- 
-- WHAT IS A MIGRATION?
-- A migration is a versioned SQL script that evolves your database
-- schema over time. Instead of manually editing tables, you write
-- migrations. Team members run them in order. The database always
-- ends up in the same state for everyone.

-- Enable UUID generation (built into PostgreSQL 13+)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'free'
                            CHECK (role IN ('free', 'premium', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- SESSIONS (chat threads)
-- One user can have many sessions. Each session is a separate
-- conversation — like different chat threads in ChatGPT.
CREATE TABLE IF NOT EXISTS sessions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT,       -- auto-generated from first message
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_last_message ON sessions(user_id, last_message_at DESC);


-- SESSION MESSAGES (session memory)
-- Every message in a conversation is stored here.
-- When building context for the LLM, we load the last N rows
-- for the session, ordered by created_at.
CREATE TABLE IF NOT EXISTS session_messages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_session_messages_user ON session_messages(user_id);


-- USER MEMORY (general / persistent memory)
-- 
-- After conversations, the AI extracts key facts about the user
-- (name, expertise, preferences) and stores them here.
-- These are injected into the system prompt of EVERY new session,
-- so Claude "remembers" who the user is across all conversations.
--
-- key/user_id is UNIQUE: updating a memory fact replaces the old one.
CREATE TABLE IF NOT EXISTS user_memory (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key               TEXT        NOT NULL,   -- e.g. "name", "expertise", "preferred_language"
  value             TEXT        NOT NULL,   -- e.g. "Aryan", "beginner Node.js", "TypeScript"
  confidence        FLOAT       NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  source_session_id UUID        REFERENCES sessions(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Only one value per (user, key). If we learn the user's name again,
  -- we UPDATE not INSERT a duplicate.
  CONSTRAINT uq_user_memory_key UNIQUE (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_user_memory_user ON user_memory(user_id);

-- JOBS
-- Every LLM request becomes a job. The gateway creates the row,
-- the queue worker updates status as it processes.
CREATE TABLE IF NOT EXISTS jobs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status      TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  prompt      TEXT        NOT NULL,
  result      TEXT,                   -- filled in on completion
  error       TEXT,                   -- filled in on failure
  priority    INTEGER     NOT NULL DEFAULT 0,  -- higher = processed sooner
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_user     ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_session  ON jobs(session_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created  ON jobs(created_at DESC);


-- USAGE (billing / token tracking)
-- After every LLM call, we record tokens used and estimated cost.
-- This lets you build per-user dashboards, enforce quotas, and
-- understand your Anthropic bill.
CREATE TABLE IF NOT EXISTS usage (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id         UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  model          TEXT        NOT NULL,
  input_tokens   INTEGER     NOT NULL DEFAULT 0,
  output_tokens  INTEGER     NOT NULL DEFAULT 0,
  -- cost_usd = (input_tokens / 1_000_000 * input_price) + (output_tokens / 1_000_000 * output_price)
  -- For claude-sonnet-4: $3/M input, $15/M output (as of 2024)
  cost_usd       NUMERIC(10, 8) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_user    ON usage(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_job     ON usage(job_id);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage(created_at DESC);


-- DOCUMENTS (for RAG — Phase 5)
-- Metadata about uploaded documents. The actual vectors live in Qdrant.
CREATE TABLE IF NOT EXISTS documents (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename     TEXT        NOT NULL,
  size_bytes   INTEGER,
  chunk_count  INTEGER     NOT NULL DEFAULT 0,
  status       TEXT        NOT NULL DEFAULT 'processing'
                           CHECK (status IN ('processing', 'ready', 'failed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);

-- RESPONSE CACHE (Phase 4)
-- If the same prompt hash was already answered, skip the LLM call.
-- Saves money and latency for identical queries.
CREATE TABLE IF NOT EXISTS response_cache (
  prompt_hash  TEXT        PRIMARY KEY,   -- SHA-256 of (model + prompt)
  response     TEXT        NOT NULL,
  model        TEXT        NOT NULL,
  input_tokens  INTEGER    NOT NULL,
  output_tokens INTEGER    NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_hit_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count    INTEGER     NOT NULL DEFAULT 1
);

-- HELPER: auto-update updated_at on any row change
-- This trigger fires on UPDATE for tables that have updated_at.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply the trigger to tables with updated_at
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['users', 'sessions', 'jobs', 'user_memory']
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_updated_at ON %I;
       CREATE TRIGGER trg_updated_at
       BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();',
      tbl, tbl
    );
  END LOOP;
END;
$$;
