#!/usr/bin/env python3
# Strategy: in the entire i18n.js file, find href="URL" patterns
# where URL contains unescaped double quotes (they break the JS string)
# and fix them to use HTML single quotes: href='URL'

with open('/home/node/eclaw-i18n/backend/public/shared/i18n.js', 'rb') as f:
    data = f.read()

# Find all href="URL" patterns and check for unescaped quotes
# We need to find: href=" where the " is NOT preceded by \
# Then fix them by changing to href='...'

# Count current state
bare_href = data.count(b'href="')
backslash_href = data.count(b'href=\\')
print(f"Before: bare href= quotes: {bare_href}, backslash href= quotes: {backslash_href}")

# In JavaScript double-quoted strings:
# - \" is an escaped quote (literal ")
# - \\ is an escaped backslash (literal \)
# To represent href="url" in a JS string, we need href=\"url\"
# That is: h-r-e-f-=-"-u-r-l-" (6 chars in file)
# But to get the final HTML to have href="url", we need:
# h-r-e-f-=-"-u-r-l-" (this is wrong - breaks the JS string)
# h-r-e-f-=-\-"-u-r-l-=-\-" (this is: href=\"url\" in JS, gives href="url" in HTML)
# bytes: h=104 r=114 e=101 f=102 ==61 "=34 = backslash=92

# The CORRECT pattern: href=\"url\" in the JS file
# File bytes: href=\"url\"
# In JS: href + = + \" + url + \" = href="url" (HTML)
# This works because \" in JS = literal "

# Current PROBLEMATIC pattern: href="url" in the file
# In JS: href=" breaks the string because " is not escaped

# So to FIX: replace href="url" (2 consecutive chars: = and ")
# with href=\"url\" (3 chars: = and \ and ")
# i.e., insert a \ before the inner "

# BUT: if the file already has href=\" (=\ and \"), we need href=\" (=\ and \ and \")

# Current state after my fix:
# The file has href=\" (=\ followed by \ followed by ")
# This is: h-r-e-f-=-\-" = bytes: 104,114,101,102,61,92,34
# In JS: \" = escaped quote -> literal "
# So the HTML becomes href="url" (correct!)
# But wait, then why is node complaining?

# Let me check: maybe the issue is that we have BOTH:
# href=\" in the en block (line 2925 - CORRECT)
# href=" in the id block (line 23409 - WRONG)

# After my fix, id block line 23409 had href=" (bare) -> became href=\" (=\ followed by \ followed by ")
# This SHOULD be correct now. But node still errors.

# Wait - maybe I need to look at this differently.
# Let me check: what if the ORIGINAL id block had:
# "guide_bp_cta_plaza": "Bot Plaza: <a href="/portal/community.html">Visit Bot Plaza</a>",
# (bare quote in HTML attribute value)

# And my fix changed href=" to href=\" (adding one backslash)
# So now it's:
# "guide_bp_cta_plaza": "Bot Plaza: <a href=\"/portal/community.html">Visit Bot Plaza</a>",
# In JS: href=\" = escaped quote = literal "
# So HTML: href="/portal/... (starts with /, not with ")
# The href value is UNQUOTED!

# Ah! That's the issue! The href value is UNQUOTED because \" in JS = literal ".
# The HTML needs href="url" but we have href=/url which is unquoted.

# FIX: need href=\"url\" in JS -> in file: href=\"url\"
# In file: =-\-"-u-r-l-=-\" = bytes: 61,92,34,117,114,108,61,92,34
# So the file needs: backslash-quote before AND after the URL

print("Strategy: will add backslash-quote before and after href URL values")

# But this is complex. Let me try a simpler approach:
# Use Python to parse the JS file as tokens and fix href attributes

# Actually, simplest fix: change ALL href=" in JS string values to href=' (single quote)
# This avoids the escaping issue entirely

# Find: href="url" (where url doesn't contain ")
# Replace with: href='url'

import re

# Pattern: href=" followed by URL and closing "
# URL is everything until the next " that's not preceded by \
def fix_href(m):
    url = m.group(1)
    return "href='" + url + "'"

# Find href="url" where the URL doesn't start with a backslash
# Simple approach: find href=" followed by chars until the next "
def replace_href(content):
    # Find href="URL" patterns where URL is plain text (no backslash)
    # This regex matches href=", then captures everything up to the next unescaped "
    pattern = b'href="([^"\\\\]+)"'
    
    def replacer(m):
        url = m.group(1)
        return b"href='" + url + b"'"
    
    return re.sub(pattern, replacer, content)

new_data = replace_href(data)
bare_after = new_data.count(b'href="')
single_after = new_data.count(b"href='")
print(f"After: bare href= quotes: {bare_after}, single-quote href= patterns: {single_after}")

with open('/home/node/eclaw-i18n/backend/public/shared/i18n.js', 'wb') as f:
    f.write(new_data)
print("Written!")
