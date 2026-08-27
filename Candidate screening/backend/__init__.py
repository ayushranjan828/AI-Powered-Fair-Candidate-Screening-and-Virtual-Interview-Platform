"""Backend package.

The DNS fallback is installed on import so that every entry point - `run.py`,
`python -m uvicorn backend.main:app`, or the test client - gets it before any
HTTP client is constructed.
"""
from . import dnsfix

dnsfix.install()
