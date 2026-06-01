#!/usr/bin/env python3
"""
Add Settings .help i18n keys to backend/public/shared/i18n.js
10 help keys × 16+ target locales

Usage: python3 scripts/add-settings-help-i18n.py
"""

from pathlib import Path

FILE_PATH = Path('backend/public/shared/i18n.js')
BACKUP_PATH = FILE_PATH.with_suffix('.js.backup4')

# English canonical help text
EN_HELP = {
    "feedback_category_help": "Pick the category that best matches your report. AI assist runs different triage flows per category (bug = repro check, feature = roadmap match, design = visual diff).",
    "feedback_photo_help": "Attach screenshots showing the problem in context. Maximum 5 photos; web upload supports drag-and-drop. EXIF location data is stripped before upload.",
    "kanban_cron_recurring_notify_help": "Send a chat notification when this card's cron fires. Disable for low-priority recurring jobs that shouldn't ping you.",
    "kanban_nudge_advanced_help": "Per-entity overrides for nudge interval, statuses, and stop mode. Most decks don't need this — leave collapsed unless one entity has different cadence needs.",
    "kanban_nudge_batch_help": "Maximum number of L1 stale cards picked per cron tick — device-wide cap, NOT per-entity. L2 (priority bump) and L3 (auto-block) escalations are unaffected. See L1/L2/L3 in the kanban-nudge spec.",
    "kanban_nudge_interval_help": "Base interval (minutes) between stale-card nudges. Default 180 (3h). Per-entity overrides win when set (see advanced section).",
    "kanban_nudge_per_entity_section_help": "Per-entity nudge configuration. Each entity can override interval, statuses, and stop-mode independently. Used when one entity wants quieter cadence or different status filters.",
    "kanban_nudge_per_entity_throttle_help": "Skip a card if any of its assigned recipients was already nudged within their effective interval. Prevents duplicate pings when multiple cards target the same entity. Recommended ON.",
    "kanban_nudge_priority_help": "Sort order when picking the next batch of stale cards. 'priority_first' picks higher-priority before older; 'age_first' picks oldest regardless of priority.",
    "kanban_nudge_statuses_help": "Which card statuses trigger nudges. Default is todo + in_progress + review + blocked. Excluding 'blocked' is common when blocked cards are truly waiting on others.",
}

TARGET_KEYS = list(EN_HELP.keys())

def escape_js(s):
    """Escape a string for JS"""
    return s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t')

def make_js_entry(key, value):
    """Make a JS key-value line"""
    return f'        "{key}": "{escape_js(value)}"'

def build_new_entries():
    """Build new JS entries - comma after each except last"""
    lines = []
    for k in TARGET_KEYS:
        lines.append(make_js_entry(k, EN_HELP[k]))
    return ',\n'.join(lines)

def find_locale_block(content_bytes, locale_name):
    """
    Find locale block boundaries in bytes content.
    Returns (header_byte, last_content_line_start, last_content_line_end, close_byte) or None.
    """
    # Build search patterns - try unquoted and quoted forms
    # In this file, locales can be:
    # - unquoted: '    ja: {' (4 spaces indent)
    # - quoted:   '    "zh-CN": {' (with possible blank lines between)
    patterns = [
        f'\n    {locale_name}: {{'.encode('utf-8'),
        f'\n    "{locale_name}": {{'.encode('utf-8'),
    ]
    
    header_byte = None
    for pattern in patterns:
        idx = content_bytes.find(pattern)
        if idx != -1:
            header_byte = idx
            break
    
    if header_byte is None:
        return None
    
    # Find closing - the locale block ends with a line that has } followed by comma
    # The closing pattern varies: could be '        },' (8 spaces) or '    },' (4 spaces) or '            },' (12 spaces)
    # We search for a newline followed by spaces and then }, on the same line
    search_start = header_byte + 10
    # Search up to 20MB ahead for the closing
    search_limit = min(search_start + 20000000, len(content_bytes))
    
    # Pattern: newline + spaces + } + comma
    # We need to find '},' preceded by whitespace on a line
    close_pattern = b'\n'
    idx = content_bytes.find(close_pattern, search_start, search_limit)
    
    # Try to find the correct closing pattern
    # The locale block closes with '},' on its own line, but the indent varies
    # Let's search for '\n    },' - the standard 4-space indent version
    close_4 = content_bytes.find(b'\n    },', search_start, search_limit)
    
    # Also try 8-space indent: '\n        },'
    close_8 = content_bytes.find(b'\n        },', search_start, search_limit)
    
    # Also try 12-space indent (3 tabs): '\n            },'
    close_12 = content_bytes.find(b'\n            },', search_start, search_limit)
    
    # Choose the nearest one that's NOT inside the next locale
    candidates = []
    if close_4 != -1:
        candidates.append(('4space', close_4))
    if close_8 != -1:
        candidates.append(('8space', close_8))
    if close_12 != -1:
        candidates.append(('12space', close_12))
    
    if not candidates:
        # Try without newline prefix
        close_alt = content_bytes.find(b'    },', search_start, search_limit)
        if close_alt != -1:
            candidates.append(('alt', close_alt))
    
    if not candidates:
        return None
    
    # Sort by position and find the one that actually closes this block
    # The closing must come before the next locale block
    close_byte = None
    close_type = None
    
    for ctype, cpos in sorted(candidates):
        # Verify this is not the start of the next locale
        # Check what follows the potential close
        rest = content_bytes[cpos+5:cpos+50]
        
        # If the next locale starts right after, this is not our close
        if close_type is None or cpos < close_byte:
            close_byte = cpos + 4  # byte after '    },' or '        },' etc
            close_type = ctype
    
    if close_byte is None:
        return None
    
    # Now find the last content line - the line just before the closing }
    # Search backwards from close_byte to find the last non-empty, non-comment line
    search_back = close_byte - 1
    # Skip trailing whitespace
    while search_back > search_start and content_bytes[search_back:search_back+1] in (b'\n', b'\r', b' ', b'\t'):
        search_back -= 1
    
    # Now we're at the last character of the last content line
    last_content_end = search_back + 1
    
    # Find the start of this line
    last_content_start = last_content_end
    while last_content_start > search_start and content_bytes[last_content_start-1:last_content_start] not in (b'\n', b'\r'):
        last_content_start -= 1
    
    return header_byte, last_content_start, last_content_end, close_byte, close_type

def add_keys_to_locale(content_bytes, locale_name):
    """Add keys to an existing locale block using byte operations"""
    result = find_locale_block(content_bytes, locale_name)
    if result is None:
        print(f"  WARNING: Locale '{locale_name}' not found")
        return content_bytes, False
    
    header_byte, last_content_start, last_content_end, close_byte, close_type = result
    
    if last_content_start is None:
        print(f"  WARNING: No content for '{locale_name}'")
        return content_bytes, False
    
    # Get the last content line
    last_line = content_bytes[last_content_start:last_content_end]
    
    # Add comma if missing
    if not last_line.rstrip().endswith(b','):
        last_line_with_comma = last_line.rstrip() + b','
    else:
        last_line_with_comma = last_line.rstrip()
    
    # Build new entries
    new_entries_bytes = build_new_entries().encode('utf-8')
    
    # Determine closing pattern based on close_type
    close_prefix = {
        '4space': b'\n    },',
        '8space': b'\n        },',
        '12space': b'\n            },',
        'alt': b'    },',
    }.get(close_type, b'\n    },')
    
    # Build the new section: last_line + comma + new_entries + closing
    new_section = last_line_with_comma + b'\n' + new_entries_bytes + b',\n' + close_prefix
    
    # Replace
    new_content = content_bytes[:last_content_start] + new_section + content_bytes[close_byte:]
    
    return new_content, True

def insert_new_locale_before(content_bytes, new_locale, before_locale):
    """Insert a new locale block before another locale block"""
    result = find_locale_block(content_bytes, before_locale)
    if result is None:
        print(f"  WARNING: Could not find '{before_locale}' to insert before")
        return content_bytes, False
    
    header_byte = result[0]
    
    # Build the new locale block
    new_entries_bytes = build_new_entries().encode('utf-8')
    new_block = (
        b'\n    ' + new_locale.encode('utf-8') + b': {\n' +
        new_entries_bytes + b',\n' +
        b'    },\n'
    )
    
    new_content = content_bytes[:header_byte] + new_block + content_bytes[header_byte:]
    return new_content, True

def main():
    print(f"Reading {FILE_PATH}...")
    with open(FILE_PATH, 'rb') as f:
        original_content = f.read()
    
    content = original_content
    original_len = len(content)
    
    print(f"File size: {original_len:,} bytes")
    
    # Placeholder translations (English) for all locales
    placeholder = {k: EN_HELP[k] for k in TARGET_KEYS}
    
    print("\n=== Adding keys to existing locales ===")
    
    # Existing locales in order
    existing_locales = [
        ('ar', 'unquoted'),
        ('de', 'unquoted'),
        ('es', 'unquoted'),
        ('fr', 'unquoted'),
        ('hi', 'unquoted'),
        ('id', 'unquoted'),
        ('ja', 'unquoted'),
        ('ko', 'unquoted'),
        ('ms', 'unquoted'),
        ('pt', 'unquoted'),
        ('th', 'unquoted'),
        ('vi', 'unquoted'),
        ('zh-CN', 'quoted'),  # uses quoted form
    ]
    
    success_count = 0
    for locale, style in existing_locales:
        print(f"Processing {locale}...", end=' ')
        new_content, ok = add_keys_to_locale(content, locale)
        if ok:
            content = new_content
            success_count += 1
            print("OK")
        else:
            print("FAILED")
    
    print(f"\n=== Inserting new locale blocks ===")
    
    # New locales to insert
    # in before ja, it before id, ru before ms, pt-rBR before ru
    inserts = [
        ('in', 'ja'),
        ('it', 'id'),
        ('pt-rBR', 'ru'),
        ('ru', 'ms'),
    ]
    
    for new_locale, before_locale in inserts:
        print(f"Inserting '{new_locale}' before '{before_locale}'...", end=' ')
        new_content, ok = insert_new_locale_before(content, new_locale, before_locale)
        if ok:
            content = new_content
            success_count += 1
            print("OK")
        else:
            print("FAILED")
    
    new_len = len(content)
    print(f"\nOriginal size: {original_len:,} bytes")
    print(f"New size: {new_len:,} bytes")
    print(f"Added: {new_len - original_len:,} bytes")
    
    if new_len != original_len:
        print(f"\nBacking up original to {BACKUP_PATH}...")
        with open(BACKUP_PATH, 'wb') as f:
            f.write(original_content)
        
        print(f"Writing changes to {FILE_PATH}...")
        with open(FILE_PATH, 'wb') as f:
            f.write(content)
        print("Done!")
    else:
        print("\nNo changes made!")

if __name__ == '__main__':
    main()