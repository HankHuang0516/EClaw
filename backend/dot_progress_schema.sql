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
CREATE TABLE IF NOT EXISTS dot_progress_decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES dot_progress_projects(id),
    question TEXT NOT NULL,
    recommendation TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    recommendation_version INTEGER NOT NULL DEFAULT 1 CHECK (recommendation_version > 0),
    adopted BOOLEAN NOT NULL DEFAULT FALSE,
    adoption_actor_id TEXT,
    adoption_at TIMESTAMPTZ,
    adoption_recommendation_version INTEGER,
    creator_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    creation_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, creator_id, request_id),
    CHECK ((adopted AND adoption_actor_id IS NOT NULL AND adoption_at IS NOT NULL AND adoption_recommendation_version = recommendation_version)
       OR (NOT adopted AND adoption_actor_id IS NULL AND adoption_at IS NULL AND adoption_recommendation_version IS NULL))
);
CREATE TABLE IF NOT EXISTS dot_progress_decision_comments (
    id BIGSERIAL PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES dot_progress_decisions(id),
    actor_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    body TEXT NOT NULL,
    recommendation_version INTEGER NOT NULL CHECK (recommendation_version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(decision_id, actor_id, request_id)
);
CREATE TABLE IF NOT EXISTS dot_progress_decision_events (
    id BIGSERIAL PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES dot_progress_decisions(id),
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    version INTEGER NOT NULL,
    recommendation_version INTEGER NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dot_progress_decisions_project ON dot_progress_decisions(project_id, created_at);
CREATE INDEX IF NOT EXISTS dot_progress_decision_comments_lookup ON dot_progress_decision_comments(decision_id, recommendation_version, id);
CREATE INDEX IF NOT EXISTS dot_progress_decision_events_lookup ON dot_progress_decision_events(decision_id, id);
CREATE TABLE IF NOT EXISTS dot_progress_review (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('permission', 'decision', 'change')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    source TEXT NOT NULL,
    scope TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(actor_id, request_id)
);
CREATE TABLE IF NOT EXISTS dot_progress_review_comments (
    id BIGSERIAL PRIMARY KEY,
    review_id TEXT NOT NULL REFERENCES dot_progress_review(id),
    body TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(review_id, actor_id, request_id)
);
CREATE INDEX IF NOT EXISTS dot_progress_review_recent ON dot_progress_review(created_at, id);
CREATE INDEX IF NOT EXISTS dot_progress_review_comments_lookup ON dot_progress_review_comments(review_id, id);
-- Push signals are independent from editable project data and its version.
CREATE TABLE IF NOT EXISTS dot_progress_push_state (
    project_id TEXT PRIMARY KEY REFERENCES dot_progress_projects(id),
    push_count INTEGER NOT NULL DEFAULT 0 CHECK (push_count >= 0),
    last_pushed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS dot_progress_push_requests (
    id BIGSERIAL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES dot_progress_projects(id),
    actor_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    push_count INTEGER NOT NULL CHECK (push_count > 0),
    pushed_at TIMESTAMPTZ NOT NULL,
    UNIQUE(project_id, actor_id, request_id)
);
CREATE INDEX IF NOT EXISTS dot_progress_push_requests_recent ON dot_progress_push_requests(id);
CREATE TABLE IF NOT EXISTS dot_progress_timeline (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES dot_progress_projects(id),
    project_label TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL,
    data JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    actor_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (ended_at >= started_at)
);
-- Additive migration preserves existing intervals and their retry receipts.
ALTER TABLE dot_progress_timeline ALTER COLUMN started_at DROP NOT NULL;
CREATE TABLE IF NOT EXISTS dot_progress_timeline_revisions (
    id BIGSERIAL PRIMARY KEY,
    timeline_id TEXT NOT NULL REFERENCES dot_progress_timeline(id),
    version INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    changes JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(timeline_id, version)
);
CREATE TABLE IF NOT EXISTS dot_progress_timeline_requests (
    actor_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_payload JSONB NOT NULL,
    response_entry JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(actor_id, request_id)
);
CREATE INDEX IF NOT EXISTS dot_progress_timeline_dates ON dot_progress_timeline(started_at, id);
CREATE INDEX IF NOT EXISTS dot_progress_timeline_project ON dot_progress_timeline(project_label, started_at);
CREATE INDEX IF NOT EXISTS dot_progress_timeline_revision_lookup ON dot_progress_timeline_revisions(timeline_id, version);
-- Private planning snapshots are independent of recorded actual work.
CREATE TABLE IF NOT EXISTS dot_progress_schedule (
    date TEXT PRIMARY KEY,
    rows JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS dot_progress_schedule_revisions (
    id BIGSERIAL PRIMARY KEY,
    date TEXT NOT NULL REFERENCES dot_progress_schedule(date),
    version INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    changes JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(date, version)
);
CREATE TABLE IF NOT EXISTS dot_progress_schedule_requests (
    actor_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_payload JSONB NOT NULL,
    response_schedule JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(actor_id, request_id)
);
