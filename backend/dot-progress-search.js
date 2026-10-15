// Search only records already exposed by the private progress workspace.
// Receipts, accounts, credentials and share capabilities are deliberately absent.
const sources = [
    "SELECT 'project' AS kind,p.id AS id,NULL::text AS owner,NULL::text AS parent,NULL::text AS date,p.version AS version,p.data->>'title' AS title,COALESCE(p.data->>'title','') || ' ' || COALESCE(p.data->>'status','') || ' ' || COALESCE(p.data->>'summary','') || ' ' || COALESCE(p.data->>'completedWork','') || ' ' || COALESCE(p.data->>'blockers','') || ' ' || COALESCE(p.data->>'nextStep','') || ' ' || COALESCE(p.data->>'publicTitle','') || ' ' || COALESCE(p.data->>'publicSummary','') || ' ' || COALESCE(p.data->>'completedAt','') || ' ' || COALESCE(ps.push_count,0)::text || ' ' || COALESCE(to_jsonb(ps.last_pushed_at)::text,'') AS content,p.updated_at AS at FROM dot_progress_projects p LEFT JOIN dot_progress_push_state ps ON ps.project_id=p.id",
    "SELECT 'comment' AS kind,c.id::text AS id,c.project_id AS owner,NULL::text AS parent,NULL::text AS date,NULL::integer AS version,p.data->>'title' AS title,c.body AS content,c.created_at AS at FROM dot_progress_comments c JOIN dot_progress_projects p ON p.id=c.project_id",
    "SELECT 'project_history' AS kind,h.id::text AS id,h.project_id AS owner,NULL::text AS parent,NULL::text AS date,h.version AS version,p.data->>'title' AS title,h.changes::text AS content,h.created_at AS at FROM dot_progress_history h JOIN dot_progress_projects p ON p.id=h.project_id",
    "SELECT 'decision' AS kind,d.id AS id,d.project_id AS owner,NULL::text AS parent,NULL::text AS date,d.version AS version,d.question AS title,d.question || ' ' || d.recommendation AS content,d.updated_at AS at FROM dot_progress_decisions d",
    "SELECT 'decision_comment' AS kind,c.id::text AS id,d.project_id AS owner,d.id AS parent,NULL::text AS date,c.recommendation_version AS version,d.question AS title,c.body AS content,c.created_at AS at FROM dot_progress_decision_comments c JOIN dot_progress_decisions d ON d.id=c.decision_id",
    "SELECT 'decision_history' AS kind,e.id::text AS id,d.project_id AS owner,d.id AS parent,NULL::text AS date,e.version AS version,d.question AS title,e.data::text AS content,e.created_at AS at FROM dot_progress_decision_events e JOIN dot_progress_decisions d ON d.id=e.decision_id",
    "SELECT 'review' AS kind,r.id AS id,NULL::text AS owner,NULL::text AS parent,NULL::text AS date,NULL::integer AS version,r.title AS title,r.title || ' ' || r.body || ' ' || r.occurred_at || ' ' || r.source || ' ' || r.scope AS content,r.created_at AS at FROM dot_progress_review r",
    "SELECT 'review_comment' AS kind,c.id::text AS id,c.review_id AS owner,NULL::text AS parent,NULL::text AS date,NULL::integer AS version,r.title AS title,c.body AS content,c.created_at AS at FROM dot_progress_review_comments c JOIN dot_progress_review r ON r.id=c.review_id",
    "SELECT 'timeline' AS kind,t.id AS id,NULL::text AS owner,NULL::text AS parent,NULL::text AS date,t.version AS version,t.project_label AS title,t.data::text AS content,COALESCE(t.started_at,t.ended_at) AS at FROM dot_progress_timeline t",
    "SELECT 'timeline_history' AS kind,h.id::text AS id,h.timeline_id AS owner,NULL::text AS parent,NULL::text AS date,h.version AS version,t.project_label AS title,h.changes::text AS content,h.created_at AS at FROM dot_progress_timeline_revisions h JOIN dot_progress_timeline t ON t.id=h.timeline_id",
    "SELECT 'schedule' AS kind,s.date AS id,NULL::text AS owner,NULL::text AS parent,s.date AS date,s.version AS version,s.date AS title,s.rows::text AS content,s.updated_at AS at FROM dot_progress_schedule s",
    "SELECT 'schedule_history' AS kind,h.id::text AS id,NULL::text AS owner,NULL::text AS parent,h.date AS date,h.version AS version,h.date AS title,h.changes::text AS content,h.created_at AS at FROM dot_progress_schedule_revisions h"
];
const sql = '(' + sources.join(' UNION ALL ') + ') AS searchable';
const kinds = new Set(['project','comment','project_history','decision','decision_comment','decision_history','review','review_comment','timeline','timeline_history','schedule','schedule_history']);
function plain(value) {
    if (Array.isArray(value)) return value.map(plain).filter(Boolean).join('\n');
    if (value && typeof value === 'object') return Object.values(value).map(plain).filter(Boolean).join('\n');
    return value === null || value === undefined ? '' : String(value);
}
function content(value) { try { return plain(JSON.parse(value)); } catch (_error) { return String(value || ''); } }
function hit(row, query) {
    const body = content(row.content); const at = body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    const start = Math.max(0, at - 70);
    return { kind: row.kind, id: row.id, owner: row.owner, parent: row.parent, date: row.date, version: row.version, title: row.title, at: row.at,
        snippet: (start ? '…' : '') + body.slice(start, start + 280) + (body.length > start + 280 ? '…' : '') };
}
module.exports = { sql, kinds, content, hit };
