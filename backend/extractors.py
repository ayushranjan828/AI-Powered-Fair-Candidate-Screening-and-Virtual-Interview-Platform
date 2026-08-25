"""Resume text extraction for PDF / DOCX / DOC / TXT / RTF, including ZIP archives.

Every extractor returns plain text. Callers get a flat list of (display_name, text,
error) tuples so a single corrupt file never aborts a bulk upload.
"""
from __future__ import annotations

import io
import re
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

SUPPORTED_DOC_EXTS = {".pdf", ".docx", ".doc", ".txt", ".rtf", ".docm"}
ARCHIVE_EXTS = {".zip"}

_W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


@dataclass
class ExtractedResume:
    file_name: str          # path as uploaded, e.g. "batch1/john_doe.pdf"
    text: str = ""
    error: str = ""
    meta: dict = field(default_factory=dict)


def _ext(name: str) -> str:
    dot = name.rfind(".")
    return name[dot:].lower() if dot != -1 else ""


def _clean(text: str) -> str:
    text = text.replace("\x00", " ").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# --------------------------------------------------------------------------- PDF
def extract_pdf(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception:
            raise ValueError("PDF is password protected")
    parts = []
    for page in reader.pages:
        try:
            parts.append(page.extract_text() or "")
        except Exception:
            parts.append("")
    return _clean("\n".join(parts))


# -------------------------------------------------------------------------- DOCX
def extract_docx(data: bytes) -> str:
    """Parse WordprocessingML directly - no python-docx/lxml dependency."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = [n for n in ("word/document.xml", "word/document2.xml") if n in zf.namelist()]
        if not names:
            raise ValueError("Not a valid .docx (missing word/document.xml)")
        xml = zf.read(names[0])
        extra = [n for n in zf.namelist() if re.match(r"word/(header|footer)\d*\.xml$", n)]
        extra_xml = [zf.read(n) for n in extra]

    def walk(blob: bytes) -> str:
        root = ET.fromstring(blob)
        lines: list[str] = []
        for para in root.iter(f"{_W_NS}p"):
            buf = []
            for node in para.iter():
                if node.tag == f"{_W_NS}t" and node.text:
                    buf.append(node.text)
                elif node.tag in (f"{_W_NS}tab",):
                    buf.append(" ")
                elif node.tag in (f"{_W_NS}br", f"{_W_NS}cr"):
                    buf.append("\n")
            line = "".join(buf).strip()
            if line:
                lines.append(line)
        return "\n".join(lines)

    body = walk(xml)
    tail = "\n".join(walk(b) for b in extra_xml)
    return _clean(f"{body}\n{tail}")


# --------------------------------------------------------------------------- DOC
def extract_doc(data: bytes) -> str:
    """Legacy binary .doc - best effort.

    Some .doc files are actually .docx or RTF with a wrong extension; those are
    detected by magic bytes. True OLE2 files fall back to readable-run scraping,
    which is imperfect but good enough for resume screening.
    """
    if data[:2] == b"PK":
        return extract_docx(data)
    if data[:5] == b"{\\rtf":
        return extract_rtf(data)

    # UTF-16LE runs (Word stores text as UTF-16 inside the WordDocument stream)
    utf16 = data.decode("utf-16-le", errors="ignore")
    runs = re.findall(r"[\x20-\x7e\n]{6,}", utf16)
    text = "\n".join(runs)

    if len(text) < 200:  # fall back to latin-1 scraping
        latin = data.decode("latin-1", errors="ignore")
        runs = re.findall(r"[\x20-\x7e]{6,}", latin)
        text = "\n".join(runs)

    text = re.sub(r"(HYPERLINK|PAGEREF|TOC \\|MERGEFORMAT|Microsoft Word|Normal\.dotm?)[^\n]*", "", text)
    text = _clean(text)
    if len(text) < 80:
        raise ValueError("Could not read legacy .doc - please re-save as .docx or .pdf")
    return text


# --------------------------------------------------------------------------- RTF
def extract_rtf(data: bytes) -> str:
    raw = data.decode("latin-1", errors="ignore")
    raw = re.sub(r"\\'([0-9a-fA-F]{2})", lambda m: chr(int(m.group(1), 16)), raw)
    raw = re.sub(r"\\par[d]?", "\n", raw)
    raw = re.sub(r"\{\\\*?[^{}]*\}", " ", raw)
    raw = re.sub(r"\\[a-zA-Z]+-?\d* ?", " ", raw)
    raw = raw.replace("{", " ").replace("}", " ")
    return _clean(raw)


# --------------------------------------------------------------------------- TXT
def extract_txt(data: bytes) -> str:
    for enc in ("utf-8", "utf-16", "latin-1"):
        try:
            return _clean(data.decode(enc))
        except UnicodeDecodeError:
            continue
    return _clean(data.decode("utf-8", errors="ignore"))


# ------------------------------------------------------------------ dispatchers
def extract_single(file_name: str, data: bytes) -> ExtractedResume:
    ext = _ext(file_name)
    try:
        if ext == ".pdf":
            text = extract_pdf(data)
        elif ext in (".docx", ".docm"):
            text = extract_docx(data)
        elif ext == ".doc":
            text = extract_doc(data)
        elif ext == ".rtf":
            text = extract_rtf(data)
        elif ext == ".txt":
            text = extract_txt(data)
        else:
            return ExtractedResume(file_name, error=f"Unsupported file type '{ext or 'unknown'}'")
    except Exception as exc:  # noqa: BLE001 - one bad file must not stop the batch
        return ExtractedResume(file_name, error=f"{type(exc).__name__}: {exc}")

    if len(text.strip()) < 40:
        return ExtractedResume(
            file_name, text=text,
            error="No readable text found (scanned image resume?)",
        )
    return ExtractedResume(file_name, text=text, meta={"chars": len(text)})


def extract_zip(file_name: str, data: bytes, depth: int = 0) -> list[ExtractedResume]:
    """Expand a ZIP (including nested folders and nested ZIPs)."""
    out: list[ExtractedResume] = []
    if depth > 3:
        return [ExtractedResume(file_name, error="ZIP nesting too deep")]
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001
        return [ExtractedResume(file_name, error=f"Invalid ZIP: {exc}")]

    with zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            inner_name = info.filename
            base = inner_name.rsplit("/", 1)[-1]
            if base.startswith(".") or inner_name.startswith("__MACOSX/"):
                continue
            ext = _ext(inner_name)
            display = f"{file_name}/{inner_name}"
            try:
                payload = zf.read(info)
            except Exception as exc:  # noqa: BLE001
                out.append(ExtractedResume(display, error=f"Unreadable entry: {exc}"))
                continue
            if ext in ARCHIVE_EXTS:
                out.extend(extract_zip(display, payload, depth + 1))
            elif ext in SUPPORTED_DOC_EXTS:
                out.append(extract_single(display, payload))
    if not out:
        out.append(ExtractedResume(file_name, error="ZIP contained no supported resume files"))
    return out


def extract_upload(file_name: str, data: bytes) -> list[ExtractedResume]:
    """Entry point: one uploaded item -> one or more extracted resumes."""
    if _ext(file_name) in ARCHIVE_EXTS:
        return extract_zip(file_name, data)
    return [extract_single(file_name, data)]
