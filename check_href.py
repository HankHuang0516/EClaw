#!/usr/bin/env python3
with open('/home/node/eclaw-i18n/backend/public/shared/i18n.js', 'rb') as f:
    data = f.read()

lines = data.split(b'\n')
for i in range(23409, 23412):
    if i < len(lines):
        line = lines[i]
        idx = line.find(b'href=')
        if idx >= 0:
            print(f"Line {i+1}: href at byte {idx}")
            chunk = line[idx:idx+15]
            print(f"  Bytes: {list(chunk)}")
            print(f"  Text: {chunk.decode('utf-8', errors='replace')}")
