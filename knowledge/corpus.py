"""Turn the knowledge sources (library YAML + safety documents) into validated, searchable records.

Shared by the ingest CLI (which writes the local index or pushes to Azure AI Search) and by
``LocalHazardSearch`` (which builds the same records in memory when no index has been built), so
both search back-ends see exactly the same documents.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml
from pydantic import Field, ValidationError

from packages.schemas import HazardLibrary, Model

DEFAULT_SOURCES_DIR = Path(__file__).resolve().parent / "sources"
LIBRARY_FILE = "hazard_library.yaml"
CHUNK_TARGET_CHARS = 900

CODE_PREFIXES = {"hazards": "HZ-", "controls": "CT-", "task_types": "TT-", "site_conditions": "SC-",
                 "documents": "DOC-"}
KEYWORD_RE = re.compile(r"^[a-z0-9][a-z0-9 '\-./]*$")


class LibraryValidationError(Exception):
    """Raised with every problem found, so authors can fix the library in one pass."""

    def __init__(self, errors: list[str]):
        super().__init__("\n".join(errors))
        self.errors = errors


class SearchDocument(Model):
    """One record in the search index (local JSON or Azure AI Search). Field names match the index."""

    id: str
    kind: str  # hazard | control | task_type | site_condition | document_chunk
    code: str
    title: str
    content: str
    category: str | None = None
    severity: str | None = None
    control_type: str | None = None
    keywords: list[str] = Field(default_factory=list)
    hazard_codes: list[str] = Field(default_factory=list)


def load_and_validate(sources_dir: Path = DEFAULT_SOURCES_DIR) -> HazardLibrary:
    """Load the library and check schema, code uniqueness, cross-references and document files."""
    path = sources_dir / LIBRARY_FILE
    if not path.is_file():
        raise LibraryValidationError([f"Library file not found: {path}"])
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        library = HazardLibrary.model_validate(raw)
    except yaml.YAMLError as exc:
        raise LibraryValidationError([f"{path}: invalid YAML: {exc}"]) from exc
    except ValidationError as exc:
        raise LibraryValidationError(
            [f"{path}: {'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()]) from exc

    errors = _cross_reference_errors(library, sources_dir)
    if errors:
        raise LibraryValidationError(errors)
    return library


def _cross_reference_errors(lib: HazardLibrary, sources_dir: Path) -> list[str]:
    errors: list[str] = []
    sections: dict[str, list[Any]] = {"hazards": lib.hazards, "controls": lib.controls,
                                      "task_types": lib.task_types, "site_conditions": lib.site_conditions,
                                      "documents": lib.documents}
    for section, items in sections.items():
        seen: set[str] = set()
        for item in items:
            code = item.id if section == "documents" else item.code
            if code in seen:
                errors.append(f"{section}: duplicate code {code}")
            seen.add(code)
            if not code.startswith(CODE_PREFIXES[section]):
                errors.append(f"{section}: {code} must start with {CODE_PREFIXES[section]}")
            if "/" in code or "~" in code:
                errors.append(f"{section}: {code} must not contain '/' or '~' (used as a JSON pointer key)")
            for kw in getattr(item, "keywords", []):
                if kw != kw.lower() or not KEYWORD_RE.match(kw):
                    errors.append(f"{section}: {code} keyword {kw!r} must be a lowercase phrase")

    hazards = {h.code for h in lib.hazards}
    controls = {c.code: c for c in lib.controls}
    documents = {d.id for d in lib.documents}

    def check(owner: str, field: str, refs: list[str], known: set[str] | dict[str, Any]) -> None:
        for ref in refs:
            if ref not in known:
                errors.append(f"{owner}.{field}: unknown code {ref}")

    for h in lib.hazards:
        check(h.code, "typical_controls", h.typical_controls, controls)
        check(h.code, "references", h.references, documents)
        if h.severity.is_high_risk and not any(
                controls[c].type.satisfies_high_risk_rule for c in h.typical_controls if c in controls):
            errors.append(f"{h.code}: {h.severity.value} hazard needs at least one isolation/engineering "
                          f"(or better) typical control, otherwise the high-risk rule can never be satisfied")
    for t in lib.task_types:
        check(t.code, "typical_hazards", t.typical_hazards, hazards)
    for s in lib.site_conditions:
        check(s.code, "implies_hazards", s.implies_hazards, hazards)
    for d in lib.documents:
        check(d.id, "hazard_codes", d.hazard_codes, hazards)
        check(d.id, "control_codes", d.control_codes, controls)
        if not (sources_dir / d.path).is_file():
            errors.append(f"{d.id}: document file not found: {sources_dir / d.path}")
    return errors


def chunk_markdown(text: str, *, target_chars: int = CHUNK_TARGET_CHARS) -> list[tuple[str, str]]:
    """Split markdown into ``(section heading, text)`` chunks on headings, then on paragraphs.

    Small, section-aligned chunks keep retrieved passages quotable as control rationale.
    """
    sections: list[tuple[str, list[str]]] = [("", [])]
    for line in text.splitlines():
        if line.startswith("#"):
            sections.append((line.lstrip("#").strip(), []))
        else:
            sections[-1][1].append(line)

    chunks: list[tuple[str, str]] = []
    for heading, lines in sections:
        paragraphs = [p.strip() for p in "\n".join(lines).split("\n\n") if p.strip()]
        buf = ""
        for para in paragraphs:
            if buf and len(buf) + len(para) > target_chars:
                chunks.append((heading, buf))
                buf = ""
            buf = f"{buf}\n\n{para}" if buf else para
        if buf:
            chunks.append((heading, buf))
    return chunks


def build_documents(library: HazardLibrary, sources_dir: Path = DEFAULT_SOURCES_DIR) -> list[SearchDocument]:
    """Library entries plus document chunks, in the shape of the search index."""
    docs: list[SearchDocument] = []
    for h in library.hazards:
        docs.append(SearchDocument(
            id=f"hazard-{h.code}", kind="hazard", code=h.code, title=h.name,
            content=f"{h.name}. {h.description}", category=h.category, severity=h.severity.value,
            keywords=h.keywords, hazard_codes=[h.code]))
    for c in library.controls:
        linked = [h.code for h in library.hazards if c.code in h.typical_controls]
        docs.append(SearchDocument(
            id=f"control-{c.code}", kind="control", code=c.code, title=c.name,
            content=f"{c.name}. {c.description}", control_type=c.type.value, keywords=c.keywords,
            hazard_codes=linked))
    for t in library.task_types:
        docs.append(SearchDocument(
            id=f"task_type-{t.code}", kind="task_type", code=t.code, title=t.name, content=t.name,
            keywords=t.keywords, hazard_codes=t.typical_hazards))
    for s in library.site_conditions:
        docs.append(SearchDocument(
            id=f"site_condition-{s.code}", kind="site_condition", code=s.code, title=s.name, content=s.name,
            keywords=s.keywords, hazard_codes=s.implies_hazards))
    for d in library.documents:
        text = (sources_dir / d.path).read_text(encoding="utf-8")
        for i, (heading, body) in enumerate(chunk_markdown(text), start=1):
            title = f"{d.title} — {heading}" if heading and heading != d.title else d.title
            docs.append(SearchDocument(
                id=f"chunk-{d.id}-{i:03d}", kind="document_chunk", code=f"{d.id}#{i}", title=title,
                content=body, hazard_codes=d.hazard_codes))
    return docs
