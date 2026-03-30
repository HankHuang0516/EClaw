#!/usr/bin/env python3
"""Add translations batch to i18n.js"""
import json, re, sys

if len(sys.argv) < 3:
    print("Usage: add_batch.py <lang> <batch_num>")
    sys.exit(1)

lang = sys.argv[1]
batch_num = int(sys.argv[2])

with open('backend/public/shared/i18n.js', 'r', encoding='utf-8') as f:
    content = f.read()

lines = content.split('\n')

# Find section
start = end = -1
bc = 0
currentLang = None
inBlock = False

for i, line in enumerate(lines):
    m = re.match(r'^    ([a-z][a-z]): \{', line)
    if m:
        currentLang = m.group(1)
        if currentLang == lang:
            start = i
            inBlock = True
            bc = 0
        continue
    if inBlock and currentLang == lang:
        bc += line.count('{') - line.count('}')
        if bc <= 0 and line.strip() == '},':
            end = i
            break

# Find last key line
lkl = -1
for i in range(start, end + 1):
    if re.match(r'^\s+"[^"]+":', lines[i]):
        lkl = i

print(f'{lang.upper()} section: lines {start+1}-{end+1}, last key at {lkl+1}')
print(f'Last key: {lines[lkl].strip()[:60]}')

# Load batch
batch_file = f'{lang}_remaining_batch{batch_num}.json'
try:
    with open(batch_file, 'r', encoding='utf-8') as f:
        translations = json.load(f)
except FileNotFoundError:
    print(f'Batch file {batch_file} not found')
    sys.exit(1)

# Find which are new
existing = set()
for i in range(start, end + 1):
    m = re.match(r'^\s+"([^"]+)":', lines[i])
    if m:
        existing.add(m.group(1))

new_t = {k: v for k, v in translations.items() if k not in existing}
print(f'Translations to add: {len(new_t)}')

if len(new_t) == 0:
    sys.exit(0)

# Ensure last key has comma
last_line = lines[lkl].rstrip()
if not last_line.endswith(','):
    lines[lkl] = last_line + ','

# Generate new lines with trailing commas
nl = []
for key, value in sorted(new_t.items()):
    escaped = value.replace('\\', '\\\\').replace('"', '\\"')
    nl.append(f'        "{key}": "{escaped}",')

# Remove comma from last new line to match file format
if nl:
    nl[-1] = nl[-1].rstrip(',')

lines[lkl+1:lkl+1] = nl

with open('backend/public/shared/i18n.js', 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))

print(f'Added {len(new_t)} translations')
