"""Make `backend` importable when pytest is run from the app directory or repo root."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
