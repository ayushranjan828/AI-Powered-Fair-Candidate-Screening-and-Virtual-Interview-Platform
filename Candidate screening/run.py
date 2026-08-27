"""Dev entry point:  python run.py   ->  http://127.0.0.1:8000

Importing `backend` installs the DNS fallback in backend/dnsfix.py, so this works
even on machines whose security agent blocks getaddrinfo for file-launched Python.
"""
import os

import backend  # noqa: F401  - installs the DNS fallback before uvicorn starts
import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "backend.main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8000")),
        reload=os.getenv("RELOAD", "0") == "1",
    )
