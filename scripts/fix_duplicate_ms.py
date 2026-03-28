#!/usr/bin/env python3
"""Fix duplicate ms blocks in i18n.js"""
import re

with open('backend/public/shared/i18n.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Find all occurrences of "    ms: {"
ms_starts = [m.start() for m in re.finditer(r'\n    ms: \{', content)]
print(f"Found {len(ms_starts)} ms: blocks at positions: {ms_starts}")

if len(ms_starts) >= 2:
    # Collect all content from all ms blocks
    all_ms_content = {}
    
    for i, start in enumerate(ms_starts):
        # Find the end of this ms block
        # Look for "    }," after the start
        search_from = start + 1
        end_match = re.search(r'\n    \},', content[search_from:])
        if end_match:
            block_end = search_from + end_match.start() + end_match.end()
            block_content = content[start + len('\n    ms: {'):block_end - len('\n    },')]
            
            # Extract key-value pairs
            kv_pattern = r'"([a-z_]+)":\s*"([^"]*)"'
            for kv_match in re.finditer(kv_pattern, block_content):
                key = kv_match.group(1)
                value = kv_match.group(2)
                all_ms_content[key] = value
    
    print(f"Total unique keys found: {len(all_ms_content)}")
    
    # Build merged ms block
    ms_lines = ["    ms: {"]
    for key in sorted(all_ms_content.keys()):
        value = all_ms_content[key]
        escaped_value = value.replace("\\", "\\\\").replace('"', '\\"')
        ms_lines.append(f'        "{key}": "{escaped_value}",')
    ms_lines.append("    },")
    merged_ms_block = "\n".join(ms_lines) + "\n"
    
    # Replace from first ms: { to after last }, 
    first_start = ms_starts[0]
    last_start = ms_starts[-1]
    search_from = last_start + 1
    end_match = re.search(r'\n    \},', content[search_from:])
    last_end = search_from + end_match.start() + end_match.end()
    
    content = content[:first_start] + "\n" + merged_ms_block + content[last_end:]
    
    with open('backend/public/shared/i18n.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Fixed! Merged ms blocks into one with {len(all_ms_content)} keys")
    
    # Verify
    with open('backend/public/shared/i18n.js', 'r') as f:
        verify = f.read()
    new_count = len([m for m in re.finditer(r'\n    ms: \{', verify)])
    print(f"Verification: now have {new_count} ms: blocks")
else:
    print("No duplicate ms blocks found")
