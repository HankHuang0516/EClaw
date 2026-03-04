#!/usr/bin/env python3
"""
db_query.py — Read-only PostgreSQL query helper
Used by Claude CLI AI to query the E-Claw database safely.

Usage:  python db_query.py "SELECT * FROM server_logs WHERE device_id = '...' LIMIT 50"
Output: JSON array of rows (or error message)

Safety: Only SELECT/WITH statements allowed. No INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE.
"""

import json
import os
import sys
from pathlib import Path

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary", file=sys.stderr)
    sys.exit(1)


def get_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    config_path = Path(__file__).parent / ".db-config"
    try:
        return config_path.read_text().strip()
    except FileNotFoundError:
        return ""


def validate_sql(sql: str) -> None:
    normalized = sql.strip().upper()
    first_word = normalized.split()[0] if normalized else ""

    if first_word not in ("SELECT", "WITH"):
        print(f"ERROR: Only SELECT queries allowed. Got: {first_word}", file=sys.stderr)
        sys.exit(1)

    forbidden = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "CREATE", "GRANT", "REVOKE"]
    for kw in forbidden:
        if f"{kw} " in normalized or f"{kw}(" in normalized or normalized.endswith(kw):
            print(f'ERROR: Forbidden keyword "{kw}" detected. Read-only queries only.', file=sys.stderr)
            sys.exit(1)


def main():
    if len(sys.argv) < 2:
        print('Usage: python db_query.py "SELECT ..."', file=sys.stderr)
        sys.exit(1)

    database_url = get_database_url()
    if not database_url:
        print("ERROR: No DATABASE_URL (env var not set and .db-config not found)", file=sys.stderr)
        sys.exit(1)

    sql = sys.argv[1]
    validate_sql(sql)

    try:
        conn = psycopg2.connect(database_url)
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(sql)
        rows = cur.fetchall()
        # Convert to serializable dicts (handles datetime etc.)
        print(json.dumps([dict(r) for r in rows], indent=2, default=str))
    except Exception as e:
        print(f"DB Error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        try:
            cur.close()
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
