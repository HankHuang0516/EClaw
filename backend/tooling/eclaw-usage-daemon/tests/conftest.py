import sys
from pathlib import Path

# Make claude_loader / codex_loader / pricing / auth importable when pytest
# is invoked from any directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
