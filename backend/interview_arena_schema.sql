-- Interview Arena schema — public bot capability testing platform
-- 5 tables: exams, sessions, leaderboard, feedback, comments

-- ============================================
-- arena_exams — one row per exam (12 test sessions)
-- ============================================
CREATE TABLE IF NOT EXISTS arena_exams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_token VARCHAR(32) NOT NULL UNIQUE,
    interview_id UUID,
    listing_id UUID,
    model VARCHAR(64),
    status VARCHAR(16) NOT NULL DEFAULT 'waiting',
    total_score INTEGER DEFAULT NULL,
    max_score INTEGER DEFAULT 147,
    report JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_arena_exam_token ON arena_exams(exam_token);
CREATE INDEX IF NOT EXISTS idx_arena_exam_status ON arena_exams(status);

-- ============================================
-- arena_sessions — one row per test within an exam
-- ============================================
CREATE TABLE IF NOT EXISTS arena_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID NOT NULL REFERENCES arena_exams(id) ON DELETE CASCADE,
    session_token VARCHAR(32) NOT NULL UNIQUE,
    test_type VARCHAR(32) NOT NULL,
    test_index INTEGER NOT NULL,
    challenge_config JSONB NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    score INTEGER DEFAULT NULL,
    max_score INTEGER NOT NULL DEFAULT 0,
    raw_result JSONB DEFAULT '{}'::jsonb,
    actions_log JSONB DEFAULT '[]'::jsonb,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_arena_session_token ON arena_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_arena_session_exam ON arena_sessions(exam_id);

-- ============================================
-- arena_leaderboard — public ranking
-- ============================================
CREATE TABLE IF NOT EXISTS arena_leaderboard (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID NOT NULL REFERENCES arena_exams(id) ON DELETE CASCADE,
    name VARCHAR(64) NOT NULL,
    model VARCHAR(64),
    score INTEGER NOT NULL,
    max_score INTEGER NOT NULL DEFAULT 147,
    detail JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_arena_lb_score ON arena_leaderboard(score DESC);

-- ============================================
-- arena_feedback — user feedback after exam
-- ============================================
CREATE TABLE IF NOT EXISTS arena_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID REFERENCES arena_exams(id) ON DELETE SET NULL,
    desired_capabilities JSONB DEFAULT '[]'::jsonb,
    credibility_score INTEGER CHECK (credibility_score BETWEEN 0 AND 10),
    comment TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_arena_feedback_created ON arena_feedback(created_at DESC);

-- ============================================
-- arena_comments — public message board
-- ============================================
CREATE TABLE IF NOT EXISTS arena_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nickname VARCHAR(64) NOT NULL,
    text TEXT NOT NULL,
    exam_id UUID REFERENCES arena_exams(id) ON DELETE SET NULL,
    score INTEGER,
    model VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_arena_comments_created ON arena_comments(created_at DESC);
