#!/usr/bin/env python3
"""Fix duplicate ms blocks in i18n.js - properly handles the structure"""
import re

with open('backend/public/shared/i18n.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Find all "    ms: {" occurrences
# The file has:
# ... es block ends with "    },\n"
# "    ms: {\n        // Portal Shared\n" (first ms block with comment)
# ... keys ...
# "    },\n"
# "    ms: {\n" (second ms block without comment)
# ... keys ...
# "    },\n"
# Then the closing of TRANSLATIONS object "};\n"

# Find all ms: blocks by finding "    ms: {" pattern
ms_pattern = r'\n    ms: \{'
ms_starts = [m.start() for m in re.finditer(ms_pattern, content)]
print(f"Found {len(ms_starts)} ms: blocks at positions: {ms_starts}")

if len(ms_starts) < 2:
    print("No duplicate ms blocks found")
    exit(0)

# Find where TRANSLATIONS closes - look for "\n};\n" after the last ms block
after_last_ms = content[ms_starts[-1]:]
closing_match = re.search(r'\n\};\n', after_last_ms)
if closing_match:
    # Position of "\n};\n" in the full content
    closing_pos = ms_starts[-1] + closing_match.start() + closing_match.end() - len('\n};\n')
    print(f"TRANSLATIONS closing at: {closing_pos}")

# For each ms block, find its content and closing
all_ms_keys = {}

for i, start in enumerate(ms_starts):
    # Find the end of this block - look for "\n    },\n" after the start
    search_content = content[start+1:]  # start from after the newline
    end_match = re.search(r'\n    \},', search_content)
    if end_match:
        block_end_pos = start + 1 + end_match.end()
        block_content = search_content[:end_match.start()]
        
        print(f"Block {i}: starts at {start}, ends at {block_end_pos}")
        print(f"  Content preview: {block_content[:100]}...")
        
        # Extract keys - skip the comment line if present
        lines = block_content.split('\n')
        for line in lines:
            # Skip empty lines and comments
            if not line.strip() or line.strip().startswith('//'):
                continue
            # Match key-value pairs
            kv_match = re.match(r'\s*"([a-z_]+)":\s*"([^"]*)"', line)
            if kv_match:
                key = kv_match.group(1)
                value = kv_match.group(2)
                all_ms_keys[key] = value

print(f"\nTotal unique keys collected: {len(all_ms_keys)}")

# Build the merged ms block
ms_lines = ["    ms: {"]
for key in sorted(all_ms_keys.keys()):
    value = all_ms_keys[key]
    escaped_value = value.replace("\\", "\\\\").replace('"', '\\"')
    ms_lines.append(f'        "{key}": "{escaped_value}",')
ms_lines.append("    },")
merged_ms_block = "\n".join(ms_lines) + "\n"

print(f"Merged ms block will have {len(all_ms_keys)} keys")

# Now replace everything from first ms: { to the closing };
# First, find the position right before first ms: {
first_ms_start = ms_starts[0]

# Find the closing }; for TRANSLATIONS - it's after all ms blocks
# Look for the pattern: after the last ms block, there's "    },\n\n};\n"
search_from = ms_starts[-1]
# Find "    }," that closes the last ms block
last_block_search = content[search_from:]
last_block_end_match = re.search(r'\n    \},', last_block_search)
if last_block_end_match:
    # Position after this "    }," 
    after_last_block = search_from + last_block_end_match.end()
    # Now find "};\n"
    closing_match = re.search(r'\n\};\n', content[after_last_block:])
    if closing_match:
        closing_start = after_last_block + closing_match.start()
        closing_end = closing_start + closing_match.end()
        print(f"Will replace from {first_ms_start} to {closing_end}")
        
        # Replace
        content = content[:first_ms_start] + "\n" + merged_ms_block + content[closing_end:]
        
        with open('backend/public/shared/i18n.js', 'w', encoding='utf-8') as f:
            f.write(content)
        print("File updated successfully!")
        
        # Verify
        with open('backend/public/shared/i18n.js', 'r') as f:
            verify = f.read()
        new_count = len([m for m in re.finditer(r'\n    ms: \{', verify)])
        print(f"Verification: now have {new_count} ms: blocks")
    else:
        print("Could not find closing };")
else:
    print("Could not find end of last ms block")
