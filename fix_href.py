#!/usr/bin/env python3
with open('/home/node/eclaw-i18n/backend/public/shared/i18n.js', 'rb') as f:
    data = f.read()

# Count current state
bare = data.count(b'href="')
backslash = data.count(b'href=\\')
print(f"Before: href=\" bare quotes: {bare}, href=\\ backslash-quote: {backslash}")

# Replace href="  (bytes: href followed by = and ") 
# with href=\\  (bytes: href followed by = and \ and ")
# This ensures the JS string sees \\" which is a literal backslash + quote
fix = data.replace(b'href="', b'href=\\\\')
bare2 = fix.count(b'href="')
backslash2 = fix.count(b'href=\\\\')
print(f"After: href=\" bare quotes: {bare2}, href=\\ backslash-quote: {backslash2}")

with open('/home/node/eclaw-i18n/backend/public/shared/i18n.js', 'wb') as f:
    f.write(fix)
print("Written!")
