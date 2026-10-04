CREATE TABLE IF NOT EXISTS dot_progress_projects (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS dot_progress_history (
    id BIGSERIAL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES dot_progress_projects(id),
    version INTEGER NOT NULL,
    action TEXT NOT NULL,
    changes JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS dot_progress_comments (
    id BIGSERIAL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES dot_progress_projects(id),
    author_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, author_id, request_id)
);
CREATE INDEX IF NOT EXISTS dot_progress_history_project ON dot_progress_history(project_id, id);
CREATE INDEX IF NOT EXISTS dot_progress_comments_project ON dot_progress_comments(project_id, id);
