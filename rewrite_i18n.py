#!/usr/bin/env python3
"""
Strategy: Find all guide_bp_cta_* and similar keys in the id block 
that have malformed href values and fix them.

Approach: For each line with a string value containing href attributes:
1. Parse the JS string value
2. Find href="..." patterns within it
3. Fix them to be proper JS string values

Simpler approach: Just find and replace specific broken href patterns.
"""
import re

with open('/home/node/eclaw-i18n/backend/public/shared/i18n.js', 'rb') as f:
    raw = f.read()

content = raw.decode('utf-8', errors='replace')

# Find all lines with broken href attributes in string values
# Broken pattern: href="URL" where the " terminates the JS string prematurely
# This happens when a JS string value contains href="URL" with unescaped inner quotes

# Strategy: find lines where the JavaScript string value has inner quotes that break parsing
# We do this by looking for patterns like:
# "key": "...href="..." 
# where the href=" starts a new string/identifier

lines = content.split('\n')
broken = []
for i, line in enumerate(lines):
    # Look for lines where a JS string value appears to be broken
    # Pattern: after the : " there's href=" followed by something that looks like it terminated the string
    m = re.match(r'^(\s+"(?:[^"\\]|\\.)+":\s*")([^"]+?)(href="\w+://[^"]+)"', line)
    if not m:
        # Try simpler pattern: the line has href=" where href is inside a string value
        # Count quotes in the line - if > 2 (key + value + extra), might be broken
        stripped = line.strip()
        if stripped.startswith('"') and 'href="' in stripped:
            # Check if this line's string value appears broken
            # A broken line has: "value...href="URL">..." where the second " after href= breaks the JS string
            # We can detect this by checking if there's a " after the href=" that's not part of a closing tag
            href_idx = stripped.find('href="')
            if href_idx >= 0:
                after_href = stripped[href_idx+6:]  # after href="
                if '"' in after_href and not after_href.startswith('http'):
                    # Likely broken
                    broken.append((i, stripped[:80]))

print(f"Found {len(broken)} potentially broken lines")
for i, line in broken:
    print(f"Line {i+1}: {line[:80]}")
