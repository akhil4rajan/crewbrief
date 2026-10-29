"""Retrieval over the hazard & control library and the safety documents.

``LocalHazardSearch`` is an in-memory BM25 index (no dependencies, deterministic) used in local
mode and by tests/eval. ``AzureHazardSearch`` queries the Azure AI Search index created by
``python -m knowledge.ingest --target azure``. Both return the same ``SearchHit`` records.
"""

from __future__ import annotations

import json
import logging
import math
import re
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Protocol

from packages.common.config import Provider, Settings, get_settings
from packages.schemas import HazardLibrary, Model

from .corpus import DEFAULT_SOURCES_DIR, SearchDocument, build_documents, load_and_validate

log = logging.getLogger(__name__)

INDEX_RELATIVE_PATH = Path("search") / "index.json"
SEARCHABLE_KINDS = {"hazard", "control", "task_type", "site_condition", "document_chunk"}

_STOPWORDS = frozenset(
    "a an and are as at be but by for from has have i in is it its it's of on or our so that the their "
    "there they this to up was we we'll we're will with you your".split())
_TOKEN_RE = re.compile(r"[a-z0-9]+(?:'[a-z]+)?")


class SearchHit(Model):
    kind: str  # hazard | control | task_type | site_condition | document_chunk
    code: str  # library code, or "<doc id>#<chunk no>" for document chunks
    title: str
    score: float
    text: str


class HazardSearch(Protocol):
    async def search(self, query: str, *, kinds: set[str] | None = None, top: int = 5) -> list[SearchHit]: ...


def tokenize(text: str) -> list[str]:
    """Lowercase word tokens with stopwords removed and a light plural/possessive strip."""
    out = []
    for tok in _TOKEN_RE.findall(text.lower()):
        tok = tok.removesuffix("'s")
        if tok in _STOPWORDS:
            continue
        if len(tok) > 3 and tok.endswith("s") and not tok.endswith("ss"):
            tok = tok[:-1]
        out.append(tok)
    return out


def index_path(settings: Settings | None = None) -> Path:
    s = settings or get_settings()
    return Path(s.data_dir) / INDEX_RELATIVE_PATH


class LocalHazardSearch:
    """Okapi BM25 over library entries (name + description + keywords) and document chunks.

    Keywords are counted twice: they are the phrases crews actually use, so they should outrank
    incidental words in descriptions.
    """

    K1 = 1.5
    B = 0.75

    def __init__(self, documents: list[SearchDocument]):
        self._docs = documents
        self._tfs: list[Counter[str]] = []
        lengths = []
        df: Counter[str] = Counter()
        for doc in documents:
            tokens = tokenize(f"{doc.title} {doc.content}") + 2 * tokenize(" ".join(doc.keywords))
            tf = Counter(tokens)
            self._tfs.append(tf)
            lengths.append(len(tokens))
            df.update(tf.keys())
        n = max(len(documents), 1)
        self._avgdl = (sum(lengths) / n) or 1.0
        self._lengths = lengths
        self._idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    @classmethod
    def from_index_file(cls, path: Path) -> LocalHazardSearch:
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls([SearchDocument.model_validate(d) for d in data["documents"]])

    @classmethod
    def from_sources(cls, sources_dir: Path = DEFAULT_SOURCES_DIR,
                     library: HazardLibrary | None = None) -> LocalHazardSearch:
        lib = library or load_and_validate(sources_dir)
        return cls(build_documents(lib, sources_dir))

    @classmethod
    def load(cls, settings: Settings | None = None) -> LocalHazardSearch:
        """Prefer the index written by the ingest CLI; fall back to building from the sources."""
        path = index_path(settings)
        if path.is_file():
            try:
                return cls.from_index_file(path)
            except (OSError, ValueError, KeyError) as exc:
                log.warning("local_search_index_unreadable", extra={"path": str(path), "error": str(exc)})
        return cls.from_sources()

    def search_sync(self, query: str, *, kinds: set[str] | None = None, top: int = 5) -> list[SearchHit]:
        terms = tokenize(query)
        if not terms:
            return []
        scored: list[tuple[float, int]] = []
        for i, doc in enumerate(self._docs):
            if kinds and doc.kind not in kinds:
                continue
            tf = self._tfs[i]
            norm = self.K1 * (1 - self.B + self.B * self._lengths[i] / self._avgdl)
            score = 0.0
            for term in terms:
                f = tf.get(term)
                if f:
                    score += self._idf[term] * f * (self.K1 + 1) / (f + norm)
            if score > 0:
                scored.append((score, i))
        scored.sort(key=lambda x: (-x[0], self._docs[x[1]].id))
        return [SearchHit(kind=self._docs[i].kind, code=self._docs[i].code, title=self._docs[i].title,
                          score=round(s, 4), text=self._docs[i].content) for s, i in scored[:top]]

    async def search(self, query: str, *, kinds: set[str] | None = None, top: int = 5) -> list[SearchHit]:
        return self.search_sync(query, kinds=kinds, top=top)


class AzureHazardSearch:
    """Azure AI Search client (keyword + semantic ranking when a semantic configuration exists).

    Authenticates with ``DefaultAzureCredential`` (managed identity) unless a real query key is
    configured. The SDK is imported lazily so local mode never needs it.
    """

    SEMANTIC_CONFIG = "default"

    def __init__(self, settings: Settings, *, semantic: bool = True):
        self._settings = settings
        self._semantic = semantic
        self._client = None

    def _get_client(self):  # type: ignore[no-untyped-def]
        if self._client is None:
            from azure.search.documents.aio import SearchClient

            self._client = SearchClient(self._settings.search_endpoint, self._settings.search_index,
                                        azure_search_credential(self._settings, aio=True))
        return self._client

    async def search(self, query: str, *, kinds: set[str] | None = None, top: int = 5) -> list[SearchHit]:
        client = self._get_client()
        kind_filter = None
        if kinds:
            kind_filter = " or ".join(f"kind eq '{k}'" for k in sorted(kinds & SEARCHABLE_KINDS)) or None
        kwargs: dict[str, object] = {"filter": kind_filter, "top": top,
                                     "select": ["kind", "code", "title", "content"]}
        if self._semantic:
            kwargs.update(query_type="semantic", semantic_configuration_name=self.SEMANTIC_CONFIG)
        try:
            results = await client.search(search_text=query, **kwargs)
            hits = [h async for h in results]
        except Exception as exc:  # noqa: BLE001 - semantic ranker may be unavailable on the tier
            if not self._semantic:
                raise
            log.warning("semantic_search_unavailable", extra={"error": str(exc)})
            self._semantic = False
            return await self.search(query, kinds=kinds, top=top)
        return [SearchHit(kind=h["kind"], code=h["code"], title=h["title"], text=h.get("content") or "",
                          score=float(h.get("@search.reranker_score") or h.get("@search.score") or 0.0))
                for h in hits]

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()


def azure_search_credential(settings: Settings, *, aio: bool):  # type: ignore[no-untyped-def]
    """API key when a real one is configured, otherwise managed identity."""
    if not Settings.is_dummy(settings.search_api_key):
        from azure.core.credentials import AzureKeyCredential

        return AzureKeyCredential(settings.search_api_key.get_secret_value())
    if aio:
        from azure.identity.aio import DefaultAzureCredential as AioDefaultAzureCredential

        return AioDefaultAzureCredential()
    from azure.identity import DefaultAzureCredential

    return DefaultAzureCredential()


def build_search(settings: Settings | None = None) -> HazardSearch:
    s = settings or get_settings()
    if s.provider("search") == Provider.AZURE:
        return AzureHazardSearch(s)
    return LocalHazardSearch.load(s)


@lru_cache(maxsize=1)
def get_search() -> HazardSearch:
    """Process-wide search instance for the configured provider."""
    return build_search()
